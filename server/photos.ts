// The signed-in user's photos: the timeline and each photo's files. Every
// lookup is by id and user together, so one user never reaches another's.
import { join } from "node:path"
import type { Config } from "./config"
import type { Db, Photo, User } from "./db"
import { HttpError, fileResponse, json } from "./http"
import type { createLibrary } from "./library"
import { resolveExisting } from "./paths"
import { parseDateQuery } from "./search"

const PAGE = 120
const MAX_PAGE = 500
const ID = /^[A-Za-z0-9_-]{12}$/

export function view(photo: Photo) {
  return {
    id: photo.id,
    kind: photo.kind,
    takenAt: photo.taken_at,
    width: photo.width,
    height: photo.height,
    duration: photo.duration,
    live: photo.live_path !== null,
    v: photo.version,
  }
}

export function createPhotos(config: Config, db: Db, library: ReturnType<typeof createLibrary>) {
  function timeline(user: User, url: URL) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get("limit")) || PAGE))
    // The cursor is the last item's time and id: "<ms>_<id>".
    const cursor = /^(\d+)_([A-Za-z0-9_-]{12})$/.exec(url.searchParams.get("cursor") ?? "")
    const q = url.searchParams.get("q")?.slice(0, 100) ?? ""
    const range = q ? parseDateQuery(q) : null
    if (q && !range) return json({ items: [], next: null })
    const where = ["user_id = ?", "status = 'ready'"]
    const args: (string | number)[] = [user.id]
    if (range) {
      where.push("taken_at >= ?", "taken_at < ?")
      args.push(range.from, range.to)
    }
    if (cursor) {
      where.push("(taken_at < ? or (taken_at = ? and id < ?))")
      args.push(Number(cursor[1]), Number(cursor[1]), cursor[2])
    }
    const rows = db.query(`select * from photos where ${where.join(" and ")} order by taken_at desc, id desc limit ?`).all(...args, limit + 1) as Photo[]
    const more = rows.length > limit
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return json({ items: items.map(view), next: more && last ? `${last.taken_at}_${last.id}` : null })
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

  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405)
    if (url.pathname === "/api/photos") return timeline(user, url)
    const match = /^\/api\/photos\/([^/]+)\/(thumb|large|original|live)$/.exec(url.pathname)
    if (match) return media(req, user, match[1], match[2])
    const one = /^\/api\/photos\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const photo = find(user, one[1])
      return json({ ...view(photo), name: photo.path.split("/").pop(), size: photo.size, lat: photo.lat, lon: photo.lon })
    }
    throw new HttpError(404)
  }

  return { handle }
}
