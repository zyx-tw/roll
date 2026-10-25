import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { createInvite } from "./auth"
import { loadConfig } from "./config"
import { exifTime, readMeta } from "./library"

const ROLL = "http://roll.test"
let dir: string
let app: ReturnType<typeof createApp>
const cookies: Record<string, string> = {}

function req(path: string, init: RequestInit & { as?: string | null } = {}) {
  const headers = new Headers(init.headers)
  headers.set("host", "roll.test")
  if (init.as) headers.set("cookie", cookies[init.as])
  if (init.method && init.method !== "GET" && init.method !== "HEAD" && !headers.has("origin")) headers.set("origin", ROLL)
  return app.fetch(new Request(ROLL + path, { ...init, headers }), "1.1.1.1")
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response | Promise<Response>): Promise<any> => (await res).json()
const post = (path: string, value: unknown, as: string | null = null) => req(path, { method: "POST", body: JSON.stringify(value), as })

function signIn(userId: string) {
  const token = `session-${userId}`
  app.db.query("insert into users (id, name, created_at) values (?, ?, 0) on conflict do nothing").run(userId, userId)
  app.db.query("insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), userId, Date.now(), Date.now() + 60_000)
  cookies[userId] = `roll_session=${token}`
}

// A small JPEG with a capture time, made by vips and exiftool like the real thing.
async function photo(path: string, taken: string, w = 300, h = 200) {
  mkdirSync(join(path, ".."), { recursive: true })
  await Bun.spawn(["vips", "black", path, String(w), String(h)]).exited
  await Bun.spawn(["exiftool", "-q", "-overwrite_original", `-DateTimeOriginal=${taken}`, "-OffsetTimeOriginal=+09:00", path]).exited
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "roll-test-"))
  mkdirSync(join(dir, "dist/assets"), { recursive: true })
  writeFileSync(join(dir, "dist/index.html"), "<!doctype html><title>roll</title>")
  const config = loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_DIST: join(dir, "dist"), ROLL_ORIGIN: ROLL })
  app = createApp(config)
  signIn("ann")
  signIn("bob")
  const lib = join(dir, "data/library")
  await photo(join(lib, "ann/2025/a.jpg"), "2025:05:01 10:00:00")
  await photo(join(lib, "ann/2025/b.jpg"), "2025:06:01 10:00:00", 200, 300)
  await photo(join(lib, "ann/live/IMG_0001.jpg"), "2025:07:01 10:00:00")
  await Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x120:d=1", "-y", join(lib, "ann/live/IMG_0001.mov")]).exited
  await Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-y", join(lib, "ann/clip.mp4")]).exited
  writeFileSync(join(lib, "ann/notes.txt"), "not a photo")
  await photo(join(lib, "bob/c.jpg"), "2025:01:01 10:00:00")
  await app.library.scan()
  await app.library.drained()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("auth", () => {
  test("unknown host is refused", async () => {
    expect((await app.fetch(new Request("http://evil.test/api/photos", { headers: { host: "evil.test" } }))).status).toBe(421)
  })
  test("api needs a session", async () => {
    expect((await req("/api/photos")).status).toBe(401)
    expect(await body(req("/api/auth/me"))).toEqual({ user: null })
    expect(await body(req("/api/auth/me", { as: "ann" }))).toEqual({ user: { id: "ann", name: "ann" } })
  })
  test("writes need the roll origin", async () => {
    expect((await req("/api/auth/logout", { method: "POST", body: "{}", headers: { origin: "http://evil.test" } })).status).toBe(403)
  })
  test("registering needs an invite or a session", async () => {
    expect((await post("/api/auth/register/options", { invite: "nope" })).status).toBe(403)
    const link = createInvite(loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_ORIGIN: ROLL }), app.db, "cat", "Cat")
    const invite = new URL(link).searchParams.get("invite")
    const ok = await post("/api/auth/register/options", { invite })
    expect(ok.status).toBe(200)
    const options = await body(ok)
    expect(options.rp.id).toBe("roll.test")
    expect(options.user.name).toBe("cat")
    // A session registers for its own user, whatever invite it sends.
    const own = await body(post("/api/auth/register/options", { invite }, "ann"))
    expect(own.user.name).toBe("ann")
  })
  test("a spent or expired invite is refused", async () => {
    const link = createInvite(loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_ORIGIN: ROLL }), app.db, "dan", "")
    const invite = new URL(link).searchParams.get("invite")!
    app.db.query("update invites set used_at = 1 where token_hash = ?").run(createHash("sha256").update(invite).digest("hex"))
    expect((await post("/api/auth/register/options", { invite })).status).toBe(403)
    const link2 = createInvite(loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_ORIGIN: ROLL }), app.db, "dan", "")
    const invite2 = new URL(link2).searchParams.get("invite")!
    app.db.query("update invites set expires_at = 1 where token_hash = ?").run(createHash("sha256").update(invite2).digest("hex"))
    expect((await post("/api/auth/register/options", { invite: invite2 })).status).toBe(403)
  })
  test("user ids must be slugs", () => {
    expect(() => createInvite(loadConfig({ ROLL_DATA: join(dir, "data") }), app.db, "../x", "")).toThrow()
  })
  test("register verify without a flow fails", async () => {
    expect((await post("/api/auth/register/verify", { response: {} }, "ann")).status).toBe(400)
  })
})

describe("photos", () => {
  test("the timeline is newest first, without the live video or non-photos", async () => {
    const { items, next } = await body(req("/api/photos", { as: "ann" }))
    expect(next).toBeNull()
    expect(items.map((p: { kind: string; live: boolean }) => `${p.kind}${p.live ? "+live" : ""}`)).toEqual(["video", "image+live", "image", "image"])
    // -fast2 would skip a movie's duration.
    expect(items[0].duration).toBeCloseTo(1, 0)
    const b = items[2]
    expect(b.width).toBe(200)
    expect(b.height).toBe(300)
    expect(b.takenAt).toBe(Date.parse("2025-06-01T10:00:00+09:00"))
  })
  test("pages by cursor", async () => {
    const first = await body(req("/api/photos?limit=3", { as: "ann" }))
    expect(first.items).toHaveLength(3)
    const second = await body(req(`/api/photos?limit=3&cursor=${first.next}`, { as: "ann" }))
    expect(second.items).toHaveLength(1)
    expect(second.next).toBeNull()
  })
  test("each user sees only their own", async () => {
    const ann = (await body(req("/api/photos", { as: "ann" }))).items
    const bob = (await body(req("/api/photos", { as: "bob" }))).items
    expect(bob).toHaveLength(1)
    for (const part of ["", "/thumb", "/large", "/original"]) expect((await req(`/api/photos/${ann[0].id}${part}`, { as: "bob" })).status).toBe(404)
  })
  test("serves thumb, large, original and live", async () => {
    const live = (await body(req("/api/photos", { as: "ann" }))).items[1]
    const thumb = await req(`/api/photos/${live.id}/thumb?v=${live.v}`, { as: "ann" })
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get("content-type")).toBe("image/webp")
    expect(thumb.headers.get("cache-control")).toContain("immutable")
    expect((await req(`/api/photos/${live.id}/large`, { as: "ann" })).status).toBe(200)
    expect((await req(`/api/photos/${live.id}/original`, { as: "ann" })).status).toBe(200)
    const mov = await req(`/api/photos/${live.id}/live`, { as: "ann", headers: { range: "bytes=0-9" } })
    expect(mov.status).toBe(206)
  })
  test("a symlink out of the library is not served", async () => {
    const lib = join(dir, "data/library")
    writeFileSync(join(dir, "secret.jpg"), "x")
    symlinkSync(join(dir, "secret.jpg"), join(lib, "ann/link.jpg"))
    await app.library.scan()
    await app.library.drained()
    expect(app.db.query("select id from photos where path = 'link.jpg'").get()).toBeNull()
  })
  test("a removed file leaves the timeline, a changed one renders again", async () => {
    const lib = join(dir, "data/library")
    rmSync(join(lib, "ann/clip.mp4"))
    cpSync(join(lib, "ann/2025/a.jpg"), join(lib, "ann/2025/a2.jpg"))
    utimesSync(join(lib, "ann/2025/b.jpg"), new Date(), new Date())
    const before = app.db.query("select version from photos where path = '2025/b.jpg'").get() as { version: number }
    await app.library.scan()
    await app.library.drained()
    const kinds = (await body(req("/api/photos", { as: "ann" }))).items.map((p: { kind: string }) => p.kind)
    expect(kinds).not.toContain("video")
    expect(kinds).toHaveLength(4)
    const after = app.db.query("select version from photos where path = '2025/b.jpg'").get() as { version: number }
    expect(after.version).toBe(before.version + 1)
  })
  test("bad ids are a 404", async () => {
    expect((await req("/api/photos/..%2F..%2Fetc/thumb", { as: "ann" })).status).toBe(404)
    expect((await req("/api/photos/short/thumb", { as: "ann" })).status).toBe(404)
  })
})

describe("metadata", () => {
  test("exif time uses its offset, else Taiwan time", () => {
    expect(exifTime("2025:01:02 03:04:05", "+09:00")).toBe(Date.parse("2025-01-02T03:04:05+09:00"))
    expect(exifTime("2025:01:02 03:04:05")).toBe(Date.parse("2025-01-02T03:04:05+08:00"))
    expect(exifTime("2025:01:02 03:04:05-05:00")).toBe(Date.parse("2025-01-02T03:04:05-05:00"))
    expect(exifTime("0000:00:00 00:00:00")).toBeNull()
  })
  test("a movie's CreateDate is UTC, its CreationDate is local", () => {
    expect(readMeta({ MIMEType: "video/quicktime", CreateDate: "2025:01:02 03:04:05" }).takenAt).toBe(Date.parse("2025-01-02T03:04:05Z"))
    expect(readMeta({ MIMEType: "video/quicktime", CreationDate: "2025:01:02 11:04:05+08:00", CreateDate: "2025:01:02 03:04:05" }).takenAt).toBe(Date.parse("2025-01-02T03:04:05Z"))
  })
  test("zero GPS is no GPS", () => {
    expect(readMeta({ GPSLatitude: 0, GPSLongitude: 0 })).toMatchObject({ lat: null, lon: null })
    expect(readMeta({ GPSLatitude: 25.03, GPSLongitude: 121.56 })).toMatchObject({ lat: 25.03, lon: 121.56 })
  })
})
