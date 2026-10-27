// The signed-in user's photos: the timeline and each photo's files. Every
// lookup is by id and user together, so one user never reaches another's.
import { lstat, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { Config } from "./config"
import type { Db, Photo, User } from "./db"
import { HttpError, fileResponse, json } from "./http"
import { DESCRIPTION_MAX, TITLE_MAX, cameraInfo, noteKey, textKey, type createLibrary } from "./library"
import type { createPlayback } from "./playback"
import { log } from "./otel"
import { ensureDir, resolveExisting, userRoot } from "./paths"
import type { Places } from "./places"
import { parseDateQuery } from "./search"
import { kindClause, type Smart } from "./smart"
import type { Faces } from "./faces"

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

// One search box. Each word is a date, a town, a country, a kind of photo
// (自拍, 截圖, 影片) or a person the user named, and narrows the timeline; every other word is free text,
// matched by meaning and by text in the photo (smart.ts). A word with no
// spaces may start or end with a known word: "京都拉麵" is 京都 and 拉麵.
export function searchClause(q: string, places: Places, person?: (word: string) => number | null) {
  const where: string[] = []
  const args: (string | number)[] = []
  const free: string[] = []
  const add = (word: string) => {
    const range = parseDateQuery(word)
    if (range) {
      where.push("p.taken_at >= ?", "p.taken_at < ?")
      args.push(range.from, range.to)
      return true
    }
    const kind = kindClause(word)
    if (kind) {
      where.push(`(${kind})`)
      return true
    }
    const id = person?.(word) ?? null
    if (id !== null) {
      where.push("exists (select 1 from faces f where f.photo_id = p.id and f.user_id = p.user_id and f.person_id = ?)")
      args.push(id)
      return true
    }
    const country = places.country(word)
    if (country) {
      where.push("p.country = ?")
      args.push(country)
      return true
    }
    const areas = places.areas(word)
    if (areas.length) {
      where.push(`(${areas.map(() => "(p.lat between ? and ? and p.lon between ? and ?)").join(" or ")})`)
      for (const a of areas) args.push(a.minLat, a.maxLat, a.minLon, a.maxLon)
      return true
    }
    return false
  }
  // A known word at the start or the end of one unspaced word, longest first.
  const peel = (word: string) => {
    const chars = [...word]
    for (let n = chars.length - 1; n >= 2; n--) {
      if (add(chars.slice(0, n).join(""))) return void free.push(chars.slice(n).join(""))
      if (add(chars.slice(chars.length - n).join(""))) return void free.push(chars.slice(0, chars.length - n).join(""))
    }
    free.push(word)
  }
  // Take the longest run of words that means something ("2026 年 4 月" is
  // one date), then go on after it.
  const words = q.split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; ) {
    let j = words.length
    while (j > i && !add(words.slice(i, j).join(" "))) j--
    if (j === i) {
      peel(words[i])
      i++
    } else i = j
  }
  return { where, args, free }
}

export function createPhotos(config: Config, db: Db, library: ReturnType<typeof createLibrary>, places: Places, playback: ReturnType<typeof createPlayback>, smart: Smart, faces: Faces) {
  async function timeline(user: User, url: URL) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get("limit")) || PAGE))
    const q = url.searchParams.get("q")?.slice(0, 100) ?? ""
    const where = ["p.user_id = ?", "p.status = 'ready'"]
    const args: (string | number)[] = [user.id]
    const clause = q ? searchClause(q, places, word => faces.personId(user.id, word)) : null
    if (clause) {
      where.push(...clause.where)
      args.push(...clause.args)
    }
    const from = "from photos p left join photo_index i on i.photo_id = p.id left join photo_notes n on n.photo_id = p.id and n.user_id = p.user_id"
    if (clause?.free.length) return ranked(user, url, limit, `${from} where ${where.join(" and ")}`, args, clause.free)
    // The cursor is the last item's time and id: "<ms>_<id>".
    const cursor = /^(\d+)_([A-Za-z0-9_-]{12})$/.exec(url.searchParams.get("cursor") ?? "")
    if (cursor) {
      where.push("(p.taken_at < ? or (p.taken_at = ? and p.id < ?))")
      args.push(Number(cursor[1]), Number(cursor[1]), cursor[2])
    }
    const rows = db.query(`select p.* ${from} where ${where.join(" and ")} order by p.taken_at desc, p.id desc limit ?`).all(...args, limit + 1) as Photo[]
    const more = rows.length > limit
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    // The first page also says how many items match, for "4,429 個項目".
    const total = cursor ? undefined : (db.query(`select count(*) as n ${from} where ${where.join(" and ")}`).get(...args) as { n: number }).n
    return json({ items: items.map(photo => view(photo, places)), next: more && last ? `${last.taken_at}_${last.id}` : null, total })
  }

  // Free words rank by relevance instead of time. The cursor is an offset into
  // the ranking: "r<n>". Photos whose title or description holds every word
  // come first, newest first; then smart.ts ranks the rest, when the embed
  // service is there.
  async function ranked(user: User, url: URL, limit: number, fromWhere: string, args: (string | number)[], free: string[]) {
    const offset = Number(/^r(\d+)$/.exec(url.searchParams.get("cursor") ?? "")?.[1] ?? 0)
    const candidates = db.query(`select p.id, p.version, i.text_key, i.indexed_at as indexed, n.text_key as note_key ${fromWhere} order by p.taken_at desc, p.id desc`).all(...args) as (Parameters<Smart["rank"]>[0][number] & { note_key: string | null })[]
    const keys = free.map(textKey).filter(Boolean)
    const noted = new Set(candidates.filter(c => c.note_key && keys.length && keys.every(key => c.note_key!.split("|").some(part => part.includes(key)))).map(c => c.id))
    const rest = smart.enabled ? await smart.rank(candidates.filter(c => !noted.has(c.id)), free) : []
    const ids = [...noted, ...rest]
    const page = ids.slice(offset, offset + limit)
    const get = db.query("select * from photos where id = ? and user_id = ?")
    const items = page.map(id => get.get(id, user.id) as Photo | null).filter((p): p is Photo => p !== null)
    log("search.ranked", { candidates: candidates.length, matches: ids.length, notes: noted.size, words: free.length })
    return json({ items: items.map(photo => view(photo, places)), next: offset + limit < ids.length ? `r${offset + limit}` : null, total: offset ? undefined : ids.length })
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
    // The playback copy when there is one, else the original.
    if (part === "play") {
      const copy = photo.kind === "video" ? await playback.path(photo.id) : null
      if (copy) return fileResponse(req, copy, `${photo.id}.mp4`, Bun.file(copy).size, false).response
      part = "original"
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
  // Deletes run one at a time. Only remove() writes into the trash, so with
  // this queue the trash name it checks is still free when it renames.
  let deleting: Promise<unknown> = Promise.resolve()
  function remove(user: User, id: string) {
    const run = deleting.then(() => removeNow(user, id))
    deleting = run.catch(() => {})
    return run
  }

  async function removeNow(user: User, id: string) {
    // Looked up inside the queue: a second delete of the same photo finds nothing.
    const photo = find(user, id)
    const root = await userRoot(config.library, user.id)
    const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    const trash = await ensureDir(root, `.trash/${day}`)
    // Stop any preview job for it from writing the row back.
    library.forget(photo.id)
    try {
      await moveToTrash(root, trash, photo)
    } catch (error) {
      library.remember(photo.id)
      throw error
    }
    db.query("delete from photos where id = ? and user_id = ?").run(photo.id, user.id)
    await rm(library.cacheDir(photo.id), { recursive: true, force: true })
    log("photo.deleted", { user: user.id, id: photo.id.slice(0, 4), live: photo.live_path !== null })
    return json({ ok: true })
  }

  async function moveToTrash(root: string, trash: string, photo: Photo) {
    // Check every file first, so a Live Photo is never left half moved.
    const sources: string[] = []
    for (const rel of [photo.path, photo.live_path]) {
      if (!rel) continue
      const parent = await resolveExisting(root, dirname(rel) === "." ? "" : dirname(rel)).catch(() => null)
      if (!parent) continue
      const source = join(parent, basename(rel))
      const info = await lstat(source).catch(() => null)
      if (!info) continue
      if (!info.isFile()) throw new HttpError(409, "not a plain file")
      sources.push(source)
    }
    for (const source of sources) {
      // The photo id makes the trash name unique; a suffix covers a repeat.
      let dest = join(trash, `${photo.id}-${basename(source)}`)
      for (let i = 1; await lstat(dest).then(() => true, () => false); i++) dest = join(trash, `${photo.id}-${i}-${basename(source)}`)
      await rename(source, dest)
    }
  }

  // Sets a photo's title and description. A field left out keeps its value;
  // an empty one clears it. The row stays, so a scan never seeds it again.
  async function note(req: Request, user: User, id: string) {
    const photo = find(user, id)
    const body = (await req.json().catch(() => null)) as { title?: unknown; description?: unknown } | null
    if (!body || typeof body !== "object") throw new HttpError(400, "bad body")
    const field = (value: unknown, max: number) => {
      if (value === undefined) return undefined
      if (typeof value !== "string" || value.length > max) throw new HttpError(400, "bad field")
      return value.trim()
    }
    const title = field(body.title, TITLE_MAX)
    const description = field(body.description, DESCRIPTION_MAX)
    const old = (db.query("select title, description from photo_notes where photo_id = ? and user_id = ?").get(photo.id, user.id) as { title: string; description: string } | null) ?? { title: "", description: "" }
    const next = { title: title ?? old.title, description: description ?? old.description }
    db.query(
      `insert into photo_notes (photo_id, user_id, title, description, text_key, updated_at) values (?, ?, ?, ?, ?, ?)
       on conflict(photo_id) do update set title = excluded.title, description = excluded.description, text_key = excluded.text_key, updated_at = excluded.updated_at`,
    ).run(photo.id, user.id, next.title, next.description, noteKey(next.title, next.description), Date.now())
    log("photo.noted", { id: photo.id.slice(0, 4), title: next.title.length, description: next.description.length })
    return json(next)
  }

  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (url.pathname === "/api/photos/pending" && req.method === "GET") return json({ ...library.pending(user.id), indexing: smart.pending(user.id) + faces.pending(user.id) })
    const target = /^\/api\/photos\/([^/]+)$/.exec(url.pathname)
    if (req.method === "DELETE" && target) return remove(user, target[1])
    if (req.method === "PATCH" && target) return note(req, user, target[1])
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405)
    if (url.pathname === "/api/photos") return timeline(user, url)
    const match = /^\/api\/photos\/([^/]+)\/(thumb|large|original|live|play)$/.exec(url.pathname)
    if (match) return media(req, user, match[1], match[2])
    const one = /^\/api\/photos\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const photo = find(user, one[1])
      // The original is read only through resolveExisting, inside this user's folder.
      const original = await resolveExisting(join(config.library, user.id), photo.path)
      const { pixels, ...camera } = await cameraInfo(original)
      // The stored size is the preview's; report the original's, turned the way the preview shows it.
      const [long, short] = pixels.length === 2 ? [Math.max(...pixels), Math.min(...pixels)] : [Math.max(photo.width, photo.height), Math.min(photo.width, photo.height)]
      const [width, height] = photo.height > photo.width ? [short, long] : [long, short]
      const people = (db.query("select distinct ps.name from faces f join persons ps on ps.id = f.person_id where f.photo_id = ? and f.user_id = ? and ps.user_id = ? order by ps.name").all(photo.id, user.id, user.id) as { name: string }[]).map(r => r.name)
      const notes = db.query("select title, description from photo_notes where photo_id = ? and user_id = ?").get(photo.id, user.id) as { title: string; description: string } | null
      return json({ ...view(photo, places), title: notes?.title ?? "", description: notes?.description ?? "", name: photo.path.split("/").pop(), size: photo.size, lat: photo.lat, lon: photo.lon, people, camera: { ...camera, width, height } })
    }
    throw new HttpError(404)
  }

  return { handle }
}
