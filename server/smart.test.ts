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
      if (path === "/faces") {
        const size = webpSize(Buffer.from(body.image_b64!, "base64"))
        // One person in every ann photo but the screenshot (and in bob's).
        const faces = size && size.width !== 120 ? [{ box: [10, 10, 90, 90], score: 0.9, vector: axis(100) }, { box: [0, 0, 20, 20], score: 0.9, vector: axis(101) }] : []
        return Response.json({ width: size?.width ?? 0, height: size?.height ?? 0, faces })
      }
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

function req(path: string, as: string, init: RequestInit = {}) {
  const headers = new Headers({ host: "roll.test", cookie: `roll_session=session-${as}`, origin: ROLL })
  return app.fetch(new Request(ROLL + path, { ...init, headers }), "1.1.1.1")
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (path: string, as: string, method: string, value: unknown): Promise<{ status: number; body: any }> => {
  const res = await req(path, as, { method, body: JSON.stringify(value) })
  return { status: res.status, body: await res.json() }
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
  await app.faces.pump()
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

describe("people", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const people = async (as = "ann"): Promise<any> => (await req("/api/people", as)).json()
  test("faces too small are dropped; one person's faces form a group", async () => {
    const { people: named, groups } = await people()
    expect(named).toEqual([])
    expect(groups).toHaveLength(1)
    // beach, street and me; the 20 px faces never count.
    expect(groups[0].size).toBe(3)
  })
  test("a face crop is a small image, only for its owner", async () => {
    const face = (await people()).groups[0].faces[0]
    const res = await req(`/api/faces/${face}`, "ann")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect((await req(`/api/faces/${face}`, "bob")).status).toBe(404)
  })
  test("another user cannot name these faces", async () => {
    const group = (await people()).groups[0]
    expect((await call("/api/people/name", "bob", "POST", { faces: group.all, name: "Ann" })).status).toBe(404)
  })
  test("naming a group makes a person, and search finds them by name", async () => {
    const group = (await people()).groups[0]
    expect((await call("/api/people/name", "ann", "POST", { faces: group.all.slice(0, 1), name: " 媽媽 " })).status).toBe(200)
    const after = await people()
    // The other two matched the named face.
    expect(after.people).toEqual([{ id: expect.any(Number), name: "媽媽", photos: 3, cover: group.all[0] }])
    expect(after.groups).toEqual([])
    const found = (await search("媽媽")).items.map((p: { id: string }) => p.id).sort()
    expect(found).toEqual([idOf("beach"), idOf("street"), idOf("me")].sort())
    expect((await search("媽媽 自拍")).items.map((p: { id: string }) => p.id)).toEqual([idOf("me")])
    expect((await search("媽媽", "bob")).items.map((p: { id: string }) => p.id)).not.toContain(idOf("me"))
  })
  test("a photo's details list its people", async () => {
    const detail = (await (await req(`/api/photos/${idOf("me")}`, "ann")).json()) as { people: string[] }
    expect(detail.people).toEqual(["媽媽"])
  })
  test("rename, merge and forget a person", async () => {
    const id = (await people()).people[0].id
    expect((await call(`/api/people/${id}`, "bob", "PATCH", { name: "x" })).status).toBe(404)
    expect((await call(`/api/people/${id}`, "ann", "PATCH", { name: "Mom" })).status).toBe(200)
    expect((await people()).people[0].name).toBe("Mom")
    expect((await call(`/api/people/${id}`, "ann", "DELETE", null)).status).toBe(200)
    const after = await people()
    expect(after.people).toEqual([])
    expect(after.groups[0].size).toBe(3)
  })
  test("bad input is refused", async () => {
    expect((await call("/api/people/name", "ann", "POST", { faces: [], name: "x" })).status).toBe(400)
    expect((await call("/api/people/name", "ann", "POST", { faces: ["../../etc/pass"], name: "x" })).status).toBe(400)
    const group = (await people()).groups[0]
    expect((await call("/api/people/name", "ann", "POST", { faces: group.all, name: "x".repeat(41) })).status).toBe(400)
  })
  test("set aside: a group named null leaves the list", async () => {
    const group = (await people()).groups[0]
    expect((await call("/api/people/name", "ann", "POST", { faces: group.all, name: null })).status).toBe(200)
    expect((await people()).groups).toEqual([])
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
