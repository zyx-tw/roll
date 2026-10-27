// Albums: a user's named sets of their own photos. A photo may sit in many
// albums; removing it from one, or deleting an album, never touches the photo.
// Every query takes the user id, and a photo joins an album only when the
// same user owns both.
import type { Db, Photo, User } from "./db"
import { HttpError, json, readJson } from "./http"
import { newId } from "./library"
import { log } from "./otel"
import { view } from "./photos"
import type { Places } from "./places"

const ID = /^[A-Za-z0-9_-]{12}$/
export const NAME_MAX = 100
const BATCH_MAX = 500

type Album = { id: string; user_id: string; name: string; created_at: number }

export function createAlbums(db: Db, places: Places) {
  function find(user: User, id: string) {
    if (!ID.test(id)) throw new HttpError(404)
    const album = db.query("select * from albums where id = ? and user_id = ?").get(id, user.id) as Album | null
    if (!album) throw new HttpError(404)
    return album
  }

  function name(value: unknown) {
    if (typeof value !== "string") throw new HttpError(400, "bad name")
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > NAME_MAX) throw new HttpError(400, "bad name")
    return trimmed
  }

  function taken(user: User, value: string, except = "") {
    if (db.query("select 1 from albums where user_id = ? and name = ? and id != ?").get(user.id, value, except)) throw new HttpError(409, "name taken")
  }

  // Each album with its count and its cover: the photo added last.
  function list(user: User) {
    const albums = db.query("select * from albums where user_id = ? order by created_at desc, id").all(user.id) as Album[]
    const count = db.query("select count(*) as n from album_photos ap join photos p on p.id = ap.photo_id and p.user_id = ap.user_id where ap.album_id = ? and ap.user_id = ? and p.status = 'ready'")
    const cover = db.query(
      "select p.* from album_photos ap join photos p on p.id = ap.photo_id and p.user_id = ap.user_id where ap.album_id = ? and ap.user_id = ? and p.status = 'ready' order by ap.added_at desc, p.taken_at desc limit 1",
    )
    return json({
      albums: albums.map(a => {
        const top = cover.get(a.id, user.id) as Photo | null
        return { id: a.id, name: a.name, count: (count.get(a.id, user.id) as { n: number }).n, cover: top ? view(top, places) : null }
      }),
    })
  }

  async function create(req: Request, user: User) {
    const value = name((await readJson(req)).name)
    taken(user, value)
    const id = newId()
    db.query("insert into albums (id, user_id, name, created_at) values (?, ?, ?, ?)").run(id, user.id, value, Date.now())
    log("album.created", { id: id.slice(0, 4) })
    return json({ id, name: value, count: 0, cover: null }, { status: 201 })
  }

  async function rename(req: Request, user: User, id: string) {
    const album = find(user, id)
    const value = name((await readJson(req)).name)
    taken(user, value, album.id)
    db.query("update albums set name = ? where id = ? and user_id = ?").run(value, album.id, user.id)
    return json({ id: album.id, name: value })
  }

  function remove(user: User, id: string) {
    const album = find(user, id)
    db.query("delete from albums where id = ? and user_id = ?").run(album.id, user.id)
    log("album.deleted", { id: album.id.slice(0, 4) })
    return json({ ok: true })
  }

  // { add: [photo ids], remove: [photo ids] }. Ids the user does not own are skipped.
  async function photos(req: Request, user: User, id: string) {
    const album = find(user, id)
    const body = await readJson(req)
    const ids = (value: unknown) => {
      if (value === undefined) return []
      if (!Array.isArray(value) || value.length > BATCH_MAX || !value.every(v => typeof v === "string" && ID.test(v))) throw new HttpError(400, "bad ids")
      return [...new Set(value as string[])]
    }
    const add = ids(body.add)
    const drop = ids(body.remove)
    const insert = db.query("insert into album_photos (album_id, photo_id, user_id, added_at) select ?, p.id, p.user_id, ? from photos p where p.id = ? and p.user_id = ? on conflict do nothing")
    const unlink = db.query("delete from album_photos where album_id = ? and photo_id = ? and user_id = ?")
    let added = 0
    let removed = 0
    db.transaction(() => {
      const now = Date.now()
      for (const photo of add) added += insert.run(album.id, now, photo, user.id).changes
      for (const photo of drop) removed += unlink.run(album.id, photo, user.id).changes
    })()
    log("album.photos", { id: album.id.slice(0, 4), added, removed })
    return json({ added, removed })
  }

  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (url.pathname === "/api/albums") {
      if (req.method === "GET") return list(user)
      if (req.method === "POST") return create(req, user)
      throw new HttpError(405)
    }
    const one = /^\/api\/albums\/([^/]+)$/.exec(url.pathname)
    if (one) {
      if (req.method === "PATCH") return rename(req, user, one[1])
      if (req.method === "DELETE") return remove(user, one[1])
      throw new HttpError(405)
    }
    const members = /^\/api\/albums\/([^/]+)\/photos$/.exec(url.pathname)
    if (members && req.method === "POST") return photos(req, user, members[1])
    throw new HttpError(404)
  }

  return { handle }
}
