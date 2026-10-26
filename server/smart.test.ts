import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { loadConfig } from "./config"
import { readKind, textKey } from "./smart"

const ROLL = "http://roll.test"
const TOKEN = "embed-test-token"
let dir: string
let app: ReturnType<typeof createApp>
let fake: ReturnType<typeof Bun.serve>
let fakeUp = true
const seen = { auth: new Set<string>(), images: 0, ocr: 0 }

// A WebP's pixel size from its VP8 header, so the fake can tell photos apart.
function webpSize(bytes: Uint8Array) {
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "VP8 ") return null
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
}

// 768 numbers, all zero but one: the beach photo and the query 海邊 share
// axis 0, everything else gets an axis of its own.
const axis = (n: number) => Array.from({ length: 768 }, (_, i) => (i === n ? 1 : 0))
let nextAxis = 10

function startFake() {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.auth.add(req.headers.get("authorization") ?? "")
      if (!fakeUp) return new Response("down", { status: 503 })
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 })
      const body = (await req.json()) as { kind?: string; items?: { text?: string; image_b64?: string }[]; image_b64?: string }
      const path = new URL(req.url).pathname
      if (path === "/ocr") {
        seen.ocr++
        const size = webpSize(Buffer.from(body.image_b64!, "base64"))
        const text = size?.width === 120 ? "Wi-Fi password: lab-2026" : ""
        return Response.json({ text, lines: text ? [{ text, score: 0.99, box: [] }] : [] })
      }
      const vectors = body.items!.map(item => {
        if (item.text !== undefined) return axis(item.text === "海邊" ? 0 : 5)
        seen.images++
        const size = webpSize(Buffer.from(item.image_b64!, "base64"))
        return axis(size?.width === 333 ? 0 : nextAxis++)
      })
      return Response.json({ vectors })
    },
  })
}

function req(path: string, as: string) {
  const headers = new Headers({ host: "roll.test", cookie: `roll_session=session-${as}` })
  return app.fetch(new Request(ROLL + path, { headers }), "1.1.1.1")
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const search = async (q: string, as = "ann"): Promise<any> => (await req(`/api/photos?q=${encodeURIComponent(q)}`, as)).json()

function signIn(userId: string) {
  app.db.query("insert into users (id, name, created_at) values (?, ?, 0) on conflict do nothing").run(userId, userId)
  app.db.query("insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)").run(createHash("sha256").update(`session-${userId}`).digest("hex"), userId, Date.now(), Date.now() + 60_000)
}

async function photo(path: string, taken: string, w: number, h: number, extra: string[] = []) {
  mkdirSync(join(path, ".."), { recursive: true })
  await Bun.spawn(["vips", "black", path, String(w), String(h)]).exited
  if (!path.endsWith(".png")) await Bun.spawn(["exiftool", "-q", "-overwrite_original", `-DateTimeOriginal=${taken}`, ...extra, path]).exited
}

const ids = new Map<string, string>()
const idOf = (name: string) => ids.get(name)!

beforeAll(async () => {
  startFake()
  dir = mkdtempSync(join(tmpdir(), "roll-smart-"))
  mkdirSync(join(dir, "dist"), { recursive: true })
  writeFileSync(join(dir, "dist/index.html"), "<!doctype html>")
  app = createApp(
    loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_DIST: join(dir, "dist"), ROLL_ORIGIN: ROLL, ROLL_RESERVE_GB: "0", ROLL_VAAPI: "", ROLL_EMBED_URL: `http://127.0.0.1:${fake.port}/`, ROLL_EMBED_TOKEN: TOKEN }),
  )
  signIn("ann")
  signIn("bob")
  const lib = join(dir, "data/library")
  await photo(join(lib, "ann/beach.jpg"), "2025:08:01 10:00:00", 333, 111)
  await photo(join(lib, "ann/street.jpg"), "2025:08:02 10:00:00", 300, 200)
  await photo(join(lib, "ann/me.jpg"), "2025:08:03 10:00:00", 200, 300, ["-LensModel=iPhone 15 front camera 2.69mm f/1.9"])
  await photo(join(lib, "ann/shot.png"), "", 120, 260)
  await Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=2", "-y", join(lib, "ann/clip.mp4")]).exited
  await photo(join(lib, "bob/sea.jpg"), "2025:08:01 10:00:00", 333, 111)
  await app.library.scan()
  await app.library.drained()
  await app.smart.pump()
  for (const row of app.db.query("select id, path from photos").all() as { id: string; path: string }[]) ids.set(row.path.split(".")[0], row.id)
})

afterAll(() => {
  fake.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe("indexing", () => {
  test("every photo is read once, with the token", () => {
    expect((app.db.query("select count(*) as n from photo_index where error is null").get() as { n: number }).n).toBe(6)
    expect([...seen.auth]).toEqual([`Bearer ${TOKEN}`])
    expect(app.smart.pending("ann")).toBe(0)
  })
  test("a video gives three frames, a photo one vector", () => {
    const frames = (id: string) => (app.db.query("select count(*) as n from photo_vectors where photo_id = ?").get(id) as { n: number }).n
    expect(frames(idOf("clip"))).toBe(3)
    expect(frames(idOf("beach"))).toBe(1)
  })
  test("EXIF and OCR fill the kind and the text", () => {
    const row = (id: string) => app.db.query("select front, screenshot, text from photo_index where photo_id = ?").get(id) as { front: number; screenshot: number; text: string }
    expect(row(idOf("me")).front).toBe(1)
    expect(row(idOf("shot")).screenshot).toBe(1)
    expect(row(idOf("shot")).text).toContain("password")
    expect(row(idOf("beach"))).toEqual({ front: 0, screenshot: 0, text: "" })
  })
  test("a second round reads nothing again", async () => {
    const before = seen.images
    await app.smart.pump()
    expect(seen.images).toBe(before)
  })
})

describe("search", () => {
  test("meaning finds the photo, first", async () => {
    const found = await search("海邊")
    expect(found.items[0].id).toBe(idOf("beach"))
  })
  test("text in a photo comes first, whatever its meaning", async () => {
    expect((await search("password")).items[0].id).toBe(idOf("shot"))
    expect((await search("LAB-2026")).items[0].id).toBe(idOf("shot"))
  })
  test("kind words filter", async () => {
    expect((await search("自拍")).items.map((p: { id: string }) => p.id)).toEqual([idOf("me")])
    expect((await search("截圖")).items.map((p: { id: string }) => p.id)).toEqual([idOf("shot")])
    expect((await search("影片")).items.map((p: { id: string }) => p.id)).toEqual([idOf("clip")])
  })
  test("a kind word and free text together search within the kind", async () => {
    expect((await search("自拍 海邊")).items.map((p: { id: string }) => p.id)).toEqual([idOf("me")])
  })
  test("each user searches only their own", async () => {
    expect((await search("海邊", "bob")).items.map((p: { id: string }) => p.id)).toEqual([idOf("sea")])
  })
  test("with the service down, text in photos still matches", async () => {
    fakeUp = false
    try {
      // A query not cached yet needs the service.
      expect((await search("lab-2026 password")).items.map((p: { id: string }) => p.id)).toEqual([idOf("shot")])
      expect((await search("山")).items).toEqual([])
    } finally {
      fakeUp = true
    }
  })
})

describe("helpers", () => {
  test("screenshots and the front camera from EXIF", () => {
    expect(readKind({ UserComment: "Screenshot" }, "IMG_1.PNG")).toEqual({ front: 0, screenshot: 1 })
    expect(readKind({}, "a.png")).toEqual({ front: 0, screenshot: 1 })
    expect(readKind({ Make: "Apple" }, "a.png")).toEqual({ front: 0, screenshot: 0 })
    expect(readKind({ LensModel: "iPhone 15 Pro front TrueDepth camera" }, "a.heic")).toEqual({ front: 1, screenshot: 0 })
  })
  test("text keys ignore width, case and spaces", () => {
    expect(textKey("Ｗｉ-Fi  Pass")).toBe("wi-fipass")
  })
})
