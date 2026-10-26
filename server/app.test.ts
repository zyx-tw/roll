import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { createInvite } from "./auth"
import { loadConfig } from "./config"
import { exifTime, readMeta } from "./library"
import { parseDateQuery } from "./search"
import { loadPlaces } from "./places"
import { searchClause } from "./photos"

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

// Starts an upload and sends it in chunks, as the app does.
async function upload(name: string, bytes: Uint8Array | string, as: string | null = "ann", modified?: number, chunk = 4) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  const started = await post("/api/upload", { name, size: data.byteLength, modified }, as)
  if (!started.ok) return started
  const { id } = (await started.json()) as { id: string }
  let res = started
  for (let at = 0; at < data.byteLength; at += chunk) {
    res = await req(`/api/upload/${id}?offset=${at}`, { method: "PUT", body: data.slice(at, at + chunk), as })
    if (!res.ok) return res
  }
  return res
}

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
  const config = loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_DIST: join(dir, "dist"), ROLL_ORIGIN: ROLL, ROLL_RESERVE_GB: "0" })
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

describe("review fixes", () => {
  test("logout clears cached previews", async () => {
    const res = await req("/api/auth/logout", { method: "POST", body: "{}" })
    expect(res.headers.get("clear-site-data")).toBe('"cache"')
    const ann = (await body(req("/api/photos", { as: "ann" }))).items[0]
    expect((await req(`/api/photos/${ann.id}/thumb`, { as: "ann" })).headers.get("vary")).toBe("Cookie")
  })
  test("a file that turns into a symlink never renders", async () => {
    const lib = join(dir, "data/library")
    signIn("eve")
    mkdirSync(join(lib, "eve"), { recursive: true })
    await photo(join(lib, "eve/swap.jpg"), "2025:01:01 10:00:00")
    const scanning = app.library.scan()
    // The swap races the scan; either the walk skips the link or the render refuses it.
    rmSync(join(lib, "eve/swap.jpg"))
    symlinkSync(join(lib, "bob/c.jpg"), join(lib, "eve/swap.jpg"))
    await scanning
    await app.library.drained()
    const row = app.db.query("select status from photos where user_id = 'eve'").get() as { status: string } | null
    if (row) expect(row.status).toBe("failed")
    expect((await body(req("/api/photos", { as: "eve" }))).items).toHaveLength(0)
  })
  test("a missing user folder keeps the timeline", async () => {
    const lib = join(dir, "data/library")
    const before = (await body(req("/api/photos", { as: "bob" }))).items.length
    cpSync(join(lib, "bob"), join(dir, "bob-moved"), { recursive: true })
    rmSync(join(lib, "bob"), { recursive: true })
    await app.library.scan()
    expect((await body(req("/api/photos", { as: "bob" }))).items).toHaveLength(before)
    cpSync(join(dir, "bob-moved"), join(lib, "bob"), { recursive: true })
  })
})

describe("date search", () => {
  const now = Date.parse("2026-10-26T12:00:00+08:00")
  const day = (s: string) => Date.parse(`${s}T00:00:00+08:00`)
  test("years, months and days", () => {
    expect(parseDateQuery("2025", now)).toEqual({ from: day("2025-01-01"), to: day("2026-01-01") })
    expect(parseDateQuery("2026-04", now)).toEqual({ from: day("2026-04-01"), to: day("2026-05-01") })
    expect(parseDateQuery("2026年4月15日", now)).toEqual({ from: day("2026-04-15"), to: day("2026-04-16") })
    expect(parseDateQuery("2025/12", now)).toEqual({ from: day("2025-12-01"), to: day("2026-01-01") })
  })
  test("a month or day without a year is the latest one not in the future", () => {
    expect(parseDateQuery("4/15", now)).toEqual({ from: day("2026-04-15"), to: day("2026-04-16") })
    expect(parseDateQuery("4月", now)).toEqual({ from: day("2026-04-01"), to: day("2026-05-01") })
    expect(parseDateQuery("12/25", now)).toEqual({ from: day("2025-12-25"), to: day("2025-12-26") })
  })
  test("anything else is not a date", () => {
    for (const q of ["東京", "13月", "2026-13", "4/32", ""]) expect(parseDateQuery(q, now)).toBeNull()
  })
  test("the timeline filters by the query", async () => {
    const all = (await body(req("/api/photos", { as: "ann" }))).items.length
    expect(all).toBeGreaterThan(1)
    const june = (await body(req("/api/photos?q=2025-06", { as: "ann" }))).items
    expect(june).toHaveLength(1)
    expect((await body(req(`/api/photos?q=${encodeURIComponent("東京")}`, { as: "ann" }))).items).toHaveLength(0)
  })
})

describe("upload", () => {
  const put = (name: string, bytes: Uint8Array | string, as = "ann", modified?: number) => upload(name, bytes, as, modified, 4096)
  test("needs a session and a photo or video name", async () => {
    expect((await post("/api/upload", { name: "a.jpg", size: 1 })).status).toBe(401)
    expect((await put("notes.txt", "x")).status).toBe(415)
    for (const bad of ["../a.jpg", "a/b.jpg", ".hidden.jpg", ""]) expect([400, 415]).toContain((await put(bad, "x")).status)
    for (const size of [0, -1, 1.5, "1"]) expect((await post("/api/upload", { name: "a.jpg", size }, "ann")).status).toBe(400)
  })
  test("keeps the bytes, picks a free name and shows up after a scan", async () => {
    const src = join(dir, "data/library/ann/2025/a.jpg")
    const bytes = new Uint8Array(await Bun.file(src).arrayBuffer())
    const before = (await body(req("/api/photos", { as: "ann" }))).items.length
    const first = await body(put("trip.jpg", bytes, "ann", 1700000000000))
    const second = await body(put("trip.jpg", bytes))
    expect(first.name).toBe("trip.jpg")
    expect(second.name).toBe("trip_1.jpg")
    const folder = (await Array.fromAsync(new Bun.Glob("uploads/*/trip.jpg").scan(join(dir, "data/library/ann"))))[0]
    const saved = join(dir, "data/library/ann", folder)
    expect(new Uint8Array(await Bun.file(saved).arrayBuffer())).toEqual(bytes)
    expect(Math.round((await Bun.file(saved).stat()).mtimeMs)).toBe(1700000000000)
    await app.library.scan()
    await app.library.drained()
    expect((await body(req("/api/photos", { as: "ann" }))).items.length).toBe(before + 2)
    // Bob's library is untouched.
    expect(await Array.fromAsync(new Bun.Glob("uploads/**").scan(join(dir, "data/library/bob")))).toHaveLength(0)
  })
  test("an uploads folder that links elsewhere is refused", async () => {
    const lib = join(dir, "data/library")
    signIn("gil")
    mkdirSync(join(lib, "gil"), { recursive: true })
    symlinkSync(join(lib, "bob"), join(lib, "gil/uploads"))
    expect((await put("x.jpg", "x", "gil")).status).toBe(404)
    expect(await Array.fromAsync(new Bun.Glob("*.jpg").scan(join(lib, "bob")))).not.toContain("x.jpg")
  })
})

describe("resumable upload", () => {
  const start = async (name: string, size: number, as = "ann") => (await body(post("/api/upload", { name, size }, as))).id as string
  const chunk = (id: string, offset: number, bytes: string, as = "ann") => req(`/api/upload/${id}?offset=${offset}`, { method: "PUT", body: bytes, as })
  const found = async (name: string) => (await Array.fromAsync(new Bun.Glob(`uploads/*/${name}`).scan(join(dir, "data/library/ann")))).length

  test("a chunk sent again, or one that skips ahead, is told where the file stands", async () => {
    const id = await start("resume.mov", 6)
    expect(await body(chunk(id, 0, "abc"))).toEqual({ received: 3 })
    const again = await chunk(id, 0, "abc")
    expect(again.status).toBe(409)
    expect((await body(again)).received).toBe(3)
    expect((await chunk(id, 5, "f")).status).toBe(409)
    expect(await body(req(`/api/upload/${id}`, { as: "ann" }))).toEqual({ received: 3 })
    expect((await body(chunk(id, 3, "def"))).name).toBe("resume.mov")
    const folder = (await Array.fromAsync(new Bun.Glob("uploads/*/resume.mov").scan(join(dir, "data/library/ann"))))[0]
    expect(await Bun.file(join(dir, "data/library/ann", folder)).text()).toBe("abcdef")
    // The last response lost: asking again gives the same name, no second copy.
    expect(await body(req(`/api/upload/${id}`, { as: "ann" }))).toEqual({ received: 6, name: "resume.mov" })
    expect(await body(chunk(id, 3, "def"))).toEqual({ received: 6, name: "resume.mov" })
    expect(await found("resume*.mov")).toBe(1)
  })
  test("nothing lands before the last byte, and no more than the size is taken", async () => {
    const id = await start("half.jpg", 4)
    await chunk(id, 0, "ab")
    expect(await found("half.jpg")).toBe(0)
    expect((await chunk(id, 2, "cde")).status).toBe(413)
    expect(await body(req(`/api/upload/${id}`, { as: "ann" }))).toEqual({ received: 2 })
  })
  test("another user cannot see, feed or cancel an upload", async () => {
    const id = await start("mine.jpg", 2)
    expect((await req(`/api/upload/${id}`, { as: "bob" })).status).toBe(404)
    expect((await chunk(id, 0, "zz", "bob")).status).toBe(404)
    expect((await req(`/api/upload/${id}`, { method: "DELETE", as: "bob" })).status).toBe(404)
    expect(await body(req(`/api/upload/${id}`, { as: "ann" }))).toEqual({ received: 0 })
    expect((await req(`/api/upload/${id}`, { method: "DELETE", as: "ann" })).status).toBe(200)
    expect((await req(`/api/upload/${id}`, { as: "ann" })).status).toBe(404)
  })
  test("one user may not hold more than 8 uploads open", async () => {
    signIn("kim")
    mkdirSync(join(dir, "data/library/kim"), { recursive: true })
    // Started all at once, they still count each other.
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => post("/api/upload", { name: `k${i}.jpg`, size: 1 }, "kim")))
    expect(all.filter(res => res.ok)).toHaveLength(8)
    expect(all.filter(res => res.status === 429)).toHaveLength(4)
  })
})

describe("review fixes, upload and search", () => {
  const put = (name: string, bytes: string, as: string) => upload(name, bytes, as)
  test("a user folder that is a link is refused before anything is written", async () => {
    const lib = join(dir, "data/library")
    signIn("hal")
    symlinkSync(join(lib, "bob"), join(lib, "hal"))
    expect((await put("h.jpg", "x", "hal")).status).toBe(404)
    expect(await Array.fromAsync(new Bun.Glob("uploads/**").scan(join(lib, "bob")))).toHaveLength(0)
    signIn("ivy")
    expect((await put("i.jpg", "x", "ivy")).status).toBe(404)
  })
  test("names are capped by bytes and may not hold control characters", async () => {
    expect((await put(`${"照".repeat(70)}.jpg`, "x", "ann")).status).toBe(400)
    expect((await put("a\r\nb.jpg", "x", "ann")).status).toBe(400)
  })
  test("a day the month lacks is not a date, full-width digits are", () => {
    const now = Date.parse("2026-10-26T12:00:00+08:00")
    expect(parseDateQuery("2026-02-30", now)).toBeNull()
    expect(parseDateQuery("2/30", now)).toBeNull()
    expect(parseDateQuery("１２/２５", now)).toEqual({ from: Date.parse("2025-12-25T00:00:00+08:00"), to: Date.parse("2025-12-26T00:00:00+08:00") })
  })
})

test("uploads started together cannot promise the same free space twice", async () => {
  const free = (await import("node:fs/promises")).statfs
  const space = await free(join(dir, "data/tmp"))
  const avail = space.bavail * space.bsize
  // Reserve all but 3 GB: two 2 GB uploads started together cannot both fit.
  const tight = createApp(loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_DIST: join(dir, "dist"), ROLL_ORIGIN: ROLL, ROLL_RESERVE_GB: String((avail - 3 * 1024 ** 3) / 1024 ** 3) }))
  const start = () => tight.fetch(new Request(`${ROLL}/api/upload`, { method: "POST", body: JSON.stringify({ name: "big.mov", size: 2 * 1024 ** 3 }), headers: { host: "roll.test", origin: ROLL, cookie: cookies.ann } }))
  const both = await Promise.all([start(), start()])
  expect(both.map(res => res.status).sort()).toEqual([200, 507])
})

test("an upload that would eat the reserve is refused", async () => {
  const tight = createApp(loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_DIST: join(dir, "dist"), ROLL_ORIGIN: ROLL, ROLL_RESERVE_GB: "1000000" }))
  const res = await tight.fetch(new Request(`${ROLL}/api/upload`, { method: "POST", body: JSON.stringify({ name: "big.jpg", size: 1 }), headers: { host: "roll.test", origin: ROLL, cookie: cookies.ann } }))
  expect(res.status).toBe(507)
})

describe("iOS app sign-in", () => {
  const verifier = "v".repeat(43)
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const code = async () => (await body(post("/api/auth/app/code", { challenge }, "ann"))).code as string
  test("only a signed-in page gets a code, for a well-formed challenge", async () => {
    expect((await post("/api/auth/app/code", { challenge })).status).toBe(401)
    expect((await post("/api/auth/app/code", { challenge: "short" }, "ann")).status).toBe(400)
  })
  test("the code needs the right verifier and works once", async () => {
    const wrong = await code()
    expect((await post("/api/auth/app/token", { code: wrong, verifier: "w".repeat(43) })).status).toBe(401)
    // A failed try spends the code.
    expect((await post("/api/auth/app/token", { code: wrong, verifier })).status).toBe(401)
    const right = await code()
    const { token } = await body(post("/api/auth/app/token", { code: right, verifier }))
    expect((await post("/api/auth/app/token", { code: right, verifier })).status).toBe(401)
    const me = await body(app.fetch(new Request(`${ROLL}/api/auth/me`, { headers: { host: "roll.test", cookie: `roll_session=${token}` } })))
    expect(me.user.id).toBe("ann")
  })
})

test("the iOS app may use the site's passkeys", async () => {
  const res = await req("/.well-known/apple-app-site-association")
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ webcredentials: { apps: ["68PK3GTMDD.tw.zyx.roll"] } })
})

describe("places", () => {
  const places = loadPlaces(join(import.meta.dir, "fixtures/cities.txt"))
  test("GPS turns into the nearest town, not one too far away", () => {
    expect(places.nearest(35.01, 135.76)?.label).toBe("京都")
    expect(places.nearest(25.03, 121.56)?.label).toBe("台北")
    expect(places.nearest(30, 140)).toBeNull()
  })
  test("names in any language find the town, country names find the country", () => {
    expect(places.towns("京都")).toEqual([1857910])
    expect(places.towns("kyoto")).toEqual([1857910])
    expect(places.towns("京都市")).toEqual([1857910])
    expect(places.country("日本")).toBe("JP")
    expect(places.country("Japan")).toBe("JP")
    expect(places.country("台灣")).toBe("TW")
  })
  test("one box: dates, towns and countries together, every word must match", () => {
    expect(searchClause("京都 4/15", places)?.where).toHaveLength(3)
    // A town is an area: 4 bounds per town.
    expect(searchClause("京都", places)?.args).toHaveLength(4)
    expect(searchClause("日本", places)?.args).toEqual(["JP"])
    expect(searchClause("2026 年 4 月", places)?.where).toHaveLength(2)
    expect(searchClause("京都 拉麵", places)).toBeNull()
  })
})

describe("delete", () => {
  test("moves the original and its live video into the trash, never another user's", async () => {
    const lib = join(dir, "data/library")
    const live = (await body(req("/api/photos", { as: "ann" }))).items.find((p: { live: boolean }) => p.live)
    expect((await req(`/api/photos/${live.id}`, { method: "DELETE", as: "bob" })).status).toBe(404)
    expect((await req(`/api/photos/${live.id}`, { method: "DELETE", as: "ann", headers: { origin: "http://evil.test" } })).status).toBe(403)
    expect((await req(`/api/photos/${live.id}`, { method: "DELETE", as: "ann" })).status).toBe(200)
    const trashed = await Array.fromAsync(new Bun.Glob(".trash/*/*").scan({ cwd: join(lib, "ann"), dot: true }))
    expect(trashed.map(p => p.split("/").pop()).sort()).toEqual([`${live.id}-IMG_0001.jpg`, `${live.id}-IMG_0001.mov`])
    expect((await body(req("/api/photos", { as: "ann" }))).items.find((p: { id: string }) => p.id === live.id)).toBeUndefined()
    expect((await req(`/api/photos/${live.id}/thumb`, { as: "ann" })).status).toBe(404)
    // A scan does not bring it back from the trash.
    await app.library.scan()
    await app.library.drained()
    expect((await body(req("/api/photos", { as: "ann" }))).items.find((p: { live: boolean }) => p.live)).toBeUndefined()
  })
  test("pending counts this user's files still waiting for previews", async () => {
    expect(await body(req("/api/photos/pending", { as: "ann" }))).toEqual({ files: 0, scanning: false })
  })
})

describe("review fixes, delete", () => {
  test("a photo that became a link is not deleted through it", async () => {
    const lib = join(dir, "data/library")
    const items = (await body(req("/api/photos", { as: "ann" }))).items
    const row = app.db.query("select id, path from photos where user_id = 'ann' and path like '2025/%' limit 1").get() as { id: string; path: string }
    const other = app.db.query("select path from photos where user_id = 'ann' and id != ? and kind = 'image' limit 1").get(row.id) as { path: string }
    rmSync(join(lib, "ann", row.path))
    symlinkSync(join(lib, "ann", other.path), join(lib, "ann", row.path))
    expect((await req(`/api/photos/${row.id}`, { method: "DELETE", as: "ann" })).status).toBe(409)
    expect(await Bun.file(join(lib, "ann", other.path)).exists()).toBe(true)
    expect(items.length).toBeGreaterThan(1)
  })
  test("a preview job for a deleted photo writes nothing back", async () => {
    const lib = join(dir, "data/library")
    await photo(join(lib, "ann/late.jpg"), "2025:08:01 10:00:00")
    const scanning = app.library.scan()
    await scanning
    const row = app.db.query("select id from photos where path = 'late.jpg'").get() as { id: string } | null
    // Whether or not the render already finished, deleting wins.
    if (row) {
      expect((await req(`/api/photos/${row.id}`, { method: "DELETE", as: "ann" })).status).toBe(200)
      await app.library.drained()
      expect(app.db.query("select id from photos where id = ?").get(row.id)).toBeNull()
    }
  })
  test("the longest run of words is read first", () => {
    const places = loadPlaces(join(import.meta.dir, "fixtures/cities.txt"))
    expect(searchClause("京都 2026 年 4 月", places)?.where).toHaveLength(3)
    expect(searchClause("京都 拉麵", places)).toBeNull()
  })
})

test("deletes of one photo run one at a time: the second finds nothing", async () => {
  const lib = join(dir, "data/library")
  await photo(join(lib, "ann/twice.jpg"), "2025:09:01 10:00:00")
  await app.library.scan()
  await app.library.drained()
  const row = app.db.query("select id from photos where path = 'twice.jpg'").get() as { id: string }
  const statuses = (await Promise.all([1, 2, 3].map(() => req(`/api/photos/${row.id}`, { method: "DELETE", as: "ann" })))).map(r => r.status)
  expect(statuses.sort()).toEqual([200, 404, 404])
  const trashed = await Array.fromAsync(new Bun.Glob(`.trash/*/${row.id}-*`).scan({ cwd: join(lib, "ann"), dot: true }))
  expect(trashed).toHaveLength(1)
})

test("a ward reads as its city, and the city's name reaches the ward", () => {
  const places = loadPlaces(join(import.meta.dir, "fixtures/cities.txt"))
  // Kamigyō-ku sits 2 km north of Kyoto's centre and is not in the fixture's names.
  expect(places.nearest(35.03, 135.76)?.label).toBe("京都")
  const [area] = places.areas("京都")
  expect(35.03).toBeGreaterThan(area.minLat)
  expect(35.03).toBeLessThan(area.maxLat)
  expect(places.areas("京都")[0].maxLat - 35.02107).toBeGreaterThan(0.15)
})
