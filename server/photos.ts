// The signed-in user's photos: the timeline and each photo's files. Every
// lookup is by id and user together, so one user never reaches another's.
import { lstat, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { Config } from "./config"
import type { Db, Photo, User } from "./db"
import { HttpError, fileResponse, json } from "./http"
import type { createLibrary } from "./library"
import { log } from "./otel"
import { ensureDir, resolveExisting, userRoot } from "./paths"
import type { Places } from "./places"
import { parseDateQuery } from "./search"

const PAGE = 120
const MAX_PAGE = 500
const ID = /^[A-Za-z0-9_-]{12}$/

export function view(photo: Photo, places?: Places) {
  return {
    id: photo.id,
    kind: photo.kind,
    takenAt: photo.taken_at,
    width: photo.width,
    height: photo.height,
    duration: photo.duration,
    live: photo.live_path !== null,
    place: places?.label(photo.place_id) ?? null,
    v: photo.version,
  }
}

// One search box: each word is a date, a town or a country, and every word
// must match. A word that is none of these matches nothing for now; meaning
// (semantic search) comes next.
export function searchClause(q: string, places: Places) {
  const where: string[] = []
  const args: (string | number)[] = []
  const add = (word: string) => {
    const range = parseDateQuery(word)
    if (range) {
      where.push("taken_at >= ?", "taken_at < ?")
      args.push(range.from, range.to)
      return true
    }
    const country = places.country(word)
    if (country) {
      where.push("country = ?")
      args.push(country)
      return true
    }
    const towns = places.towns(word)
    if (towns.length) {
      where.push(`place_id in (${towns.map(() => "?").join(",")})`)
      args.push(...towns)
      return true
    }
    return false
  }
  // Take the longest run of words that means something ("2026 年 4 月" is
  // one date), then go on after it. Every run must mean something.
  const words = q.split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; ) {
    let j = words.length
    while (j > i && !add(words.slice(i, j).join(" "))) j--
    if (j === i) return null
    i = j
  }
  return { where, args }
}

export function createPhotos(config: Config, db: Db, library: ReturnType<typeof createLibrary>, places: Places) {
  function timeline(user: User, url: URL) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get("limit")) || PAGE))
    // The cursor is the last item's time and id: "<ms>_<id>".
    const cursor = /^(\d+)_([A-Za-z0-9_-]{12})$/.exec(url.searchParams.get("cursor") ?? "")
    const q = url.searchParams.get("q")?.slice(0, 100) ?? ""
    const where = ["user_id = ?", "status = 'ready'"]
    const args: (string | number)[] = [user.id]
    if (q) {
      const clause = searchClause(q, places)
      if (!clause) return json({ items: [], next: null })
      where.push(...clause.where)
      args.push(...clause.args)
    }
    if (cursor) {
      where.push("(taken_at < ? or (taken_at = ? and id < ?))")
      args.push(Number(cursor[1]), Number(cursor[1]), cursor[2])
    }
    const rows = db.query(`select * from photos where ${where.join(" and ")} order by taken_at desc, id desc limit ?`).all(...args, limit + 1) as Photo[]
    const more = rows.length > limit
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return json({ items: items.map(photo => view(photo, places)), next: more && last ? `${last.taken_at}_${last.id}` : null })
  }

  function find(user: User, id: string) {
    if (!ID.test(id)) throw new HttpError(404)
    const photo = db.query("select * from photos where id = ? and user_id = ?").get(id, user.id) as Photo | null
    if (!photo) throw new HttpError(404)
    return photo
  }

  async function media(req: Request, user: User, id: string, part: string) {
    const photo = find(user, id)
    if (part === "thumb" || part === "large") {
      if (photo.status !== "ready") throw new HttpError(404)
      const path = library.file(photo, part)
      const info = Bun.file(path)
      if (!(await info.exists())) throw new HttpError(404)
      // The URL carries ?v=<version>, so a changed photo gets a new URL.
      const { response } = fileResponse(req, path, `${photo.id}.webp`, info.size, false)
      // The browser may keep a preview, but only for this sign-in: logout clears it.
      response.headers.set("cache-control", "private, max-age=31536000, immutable")
      response.headers.set("vary", "Cookie")
      return response
    }
    const rel = part === "original" ? photo.path : part === "live" ? photo.live_path : null
    if (!rel) throw new HttpError(404)
    const root = join(config.library, user.id)
    const path = await resolveExisting(root, rel)
    const file = Bun.file(path)
    const name = rel.split("/").pop()!
    return fileResponse(req, path, name, file.size, req.method === "GET" && new URL(req.url).searchParams.get("dl") === "1").response
  }

  // Delete moves the original (and its Live Photo video) into
  // <user>/.trash/<day>/, which scans skip, in one rename each: the file is
  // never without a name. Only a plain file is moved, never through a link.
  async function remove(user: User, id: string) {
    const photo = find(user, id)
    const root = await userRoot(config.library, user.id)
    const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    const trash = await ensureDir(root, `.trash/${day}`)
    // Stop any preview job for it from writing the row back.
    library.forget(photo.id)
    for (const rel of [photo.path, photo.live_path]) {
      if (!rel) continue
      const parent = await resolveExisting(root, dirname(rel) === "." ? "" : dirname(rel)).catch(() => null)
      if (!parent) continue
      const source = join(parent, basename(rel))
      const info = await lstat(source).catch(() => null)
      if (!info) continue
      if (!info.isFile()) throw new HttpError(409, "not a plain file")
      // The photo id makes the trash name unique; a suffix covers a repeat.
      let dest = join(trash, `${photo.id}-${basename(rel)}`)
      for (let i = 1; await lstat(dest).then(() => true, () => false); i++) dest = join(trash, `${photo.id}-${i}-${basename(rel)}`)
      await rename(source, dest)
    }
    db.query("delete from photos where id = ? and user_id = ?").run(photo.id, user.id)
    await rm(library.cacheDir(photo.id), { recursive: true, force: true })
    log("photo.deleted", { user: user.id, id: photo.id.slice(0, 4), live: photo.live_path !== null })
    return json({ ok: true })
  }

  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (url.pathname === "/api/photos/pending" && req.method === "GET") return json(library.pending(user.id))
    const target = /^\/api\/photos\/([^/]+)$/.exec(url.pathname)
    if (req.method === "DELETE" && target) return remove(user, target[1])
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405)
    if (url.pathname === "/api/photos") return timeline(user, url)
    const match = /^\/api\/photos\/([^/]+)\/(thumb|large|original|live)$/.exec(url.pathname)
    if (match) return media(req, user, match[1], match[2])
    const one = /^\/api\/photos\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const photo = find(user, one[1])
      return json({ ...view(photo, places), name: photo.path.split("/").pop(), size: photo.size, lat: photo.lat, lon: photo.lon })
    }
    throw new HttpError(404)
  }

  return { handle }
}
