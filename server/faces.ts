// People: the embed service finds faces in each photo's large preview; the
// user names a group of them; faces close enough to a named one get the same
// name. Everything here belongs to one user: a face, a group and a person are
// only ever looked up with the user's id. Thresholds come from gallery's test
// on 274 lab photos (buffalo_l, cosine similarity).
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config"
import type { Db, Photo, User } from "./db"
import { EmbedDown, type Embed } from "./embed"
import { HttpError, json } from "./http"
import { newId, run, type createLibrary } from "./library"
import { log } from "./otel"

export const FACE_MODEL = "buffalo_l/large2048"
// Less sure faces are mostly hands, bottles and backs of heads.
const MIN_SCORE = 0.7
// Smaller faces (in large preview pixels) are too blurry to tell apart.
const MIN_SIDE = 40
// A face this close to one the user named gets the same name.
const MATCH = 0.5
// Faces this close are grouped for naming, when one of them has at least
// GROUP_CORE such neighbours, itself included.
const GROUP = 0.45
const GROUP_CORE = 3
const MAX_GROUPS = 40
const GROUP_SAMPLE = 12
const NAME_MAX = 40

type FaceRow = { id: string; photo_id: string; vector: Uint8Array; person_id: number | null; labeled_by: string | null }

const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}
// Two boxes this much the same (intersection over union) are one face found again.
const SAME_FACE = 0.5
export function overlap(a: number[], b: number[]) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const both = w * h
  const area = (box: number[]) => (box[2] - box[0]) * (box[3] - box[1])
  return both > 0 ? both / (area(a) + area(b) - both) : 0
}

const toVector = (blob: Uint8Array) => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))

// Groups of faces likely to be one person (DBSCAN on cosine similarity),
// largest first. Faces in no group are left out.
export function group(vectors: Float32Array[]) {
  const neighbours = vectors.map((_, i) => [i])
  for (let i = 0; i < vectors.length; i++)
    for (let j = i + 1; j < vectors.length; j++)
      if (dot(vectors[i], vectors[j]) >= GROUP) {
        neighbours[i].push(j)
        neighbours[j].push(i)
      }
  const label = new Array<number>(vectors.length).fill(-1)
  const groups: number[][] = []
  for (let i = 0; i < vectors.length; i++) {
    if (label[i] !== -1 || neighbours[i].length < GROUP_CORE) continue
    const members: number[] = []
    const queue = [i]
    label[i] = groups.length
    while (queue.length > 0) {
      const j = queue.pop()!
      members.push(j)
      if (neighbours[j].length < GROUP_CORE) continue
      for (const k of neighbours[j])
        if (label[k] === -1) {
          label[k] = groups.length
          queue.push(k)
        }
    }
    groups.push(members)
  }
  return groups.sort((a, b) => b.length - a.length)
}

export function cleanName(name: unknown) {
  if (typeof name !== "string") return null
  const clean = name.normalize("NFKC").replace(/\s+/g, " ").trim()
  return clean && [...clean].length <= NAME_MAX ? clean : null
}

export function createFaces(config: Config, db: Db, library: ReturnType<typeof createLibrary>, embed: Embed) {
  let running: Promise<void> | null = null

  const next = db.query(
    `select p.* from photos p left join face_scans s on s.photo_id = p.id
     where p.status = 'ready' and p.kind = 'image' and (s.photo_id is null or s.version != p.version or s.model != ?)
     order by p.taken_at desc limit 1`,
  )

  // Names every face nobody decided on (or that was matched before) after the
  // faces this user named. The matcher never overrides the user.
  function match(userId: string) {
    const named = (db.query("select vector, person_id from faces where user_id = ? and labeled_by = 'user' and person_id is not null").all(userId) as FaceRow[]).map(f => ({
      person: f.person_id!,
      vector: toVector(f.vector),
    }))
    const open = db.query("select id, vector, person_id from faces where user_id = ? and (labeled_by is null or labeled_by = 'auto')").all(userId) as FaceRow[]
    const set = db.query("update faces set person_id = ?, labeled_by = ? where id = ? and user_id = ? and (labeled_by is null or labeled_by = 'auto')")
    let changed = 0
    db.transaction(() => {
      for (const face of open) {
        const vector = toVector(face.vector)
        let best: number | null = null
        let bestScore = MATCH
        for (const n of named) {
          const score = dot(vector, n.vector)
          if (score >= bestScore) {
            best = n.person
            bestScore = score
          }
        }
        if (best === face.person_id) continue
        set.run(best, best === null ? null : "auto", face.id, userId)
        changed++
      }
    })()
    return changed
  }

  async function scan(photo: Photo) {
    const large = await readFile(library.file(photo, "large"))
    const found = (await embed.faces(large)).filter(face => face.score >= MIN_SCORE && Math.min(face.box[2] - face.box[0], face.box[3] - face.box[1]) >= MIN_SIDE)
    db.transaction(() => {
      const now = db.query("select version from photos where id = ? and user_id = ?").get(photo.id, photo.user_id) as { version: number } | null
      if (!now || now.version !== photo.version) return
      // What the user decided on the old faces carries over to the new face in the same place.
      // The same place alone is not enough: the photo may have been replaced, so the face must also look the same.
      const decided = (db.query("select box, vector, person_id from faces where photo_id = ? and user_id = ? and labeled_by = 'user'").all(photo.id, photo.user_id) as { box: string; vector: Uint8Array; person_id: number | null }[]).map(f => ({
        box: JSON.parse(f.box) as number[],
        vector: toVector(f.vector),
        person: f.person_id,
      }))
      db.query("delete from faces where photo_id = ? and user_id = ?").run(photo.id, photo.user_id)
      const insert = db.query("insert into faces (id, photo_id, user_id, box, score, vector, person_id, labeled_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      for (const face of found) {
        const vector = Float32Array.from(face.vector)
        const box = face.box.map(n => Math.round(n))
        const same = decided.find(d => overlap(d.box, box) >= SAME_FACE && dot(d.vector, vector) >= MATCH)
        insert.run(newId(), photo.id, photo.user_id, JSON.stringify(box), face.score, new Uint8Array(vector.buffer), same?.person ?? null, same ? "user" : null, Date.now())
      }
      db.query("insert into face_scans (photo_id, version, model) values (?, ?, ?) on conflict(photo_id) do update set version = excluded.version, model = excluded.model").run(photo.id, photo.version, FACE_MODEL)
    })()
    if (found.length) match(photo.user_id)
    log("faces.scanned", { id: photo.id.slice(0, 4), faces: found.length })
  }

  // Scans every photo version not scanned yet, newest first. Stops while the
  // service is down; a file that fails is marked scanned with no faces.
  function pump() {
    if (!embed.enabled || running) return running ?? Promise.resolve()
    running = (async () => {
      let photo: Photo | null
      while ((photo = next.get(FACE_MODEL) as Photo | null)) {
        try {
          await scan(photo)
        } catch (error) {
          if (error instanceof EmbedDown) {
            log("faces.embed_down", { error: String(error).slice(0, 80) }, "WARN")
            return
          }
          log("faces.scan_failed", { id: photo.id.slice(0, 4), error: String(error).split(":")[0].slice(0, 60) }, "WARN")
          db.query("insert into face_scans (photo_id, version, model) values (?, ?, ?) on conflict(photo_id) do update set version = excluded.version, model = excluded.model").run(photo.id, photo.version, FACE_MODEL)
        }
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  // A person by name, for search: one of this user's people.
  const personId = (userId: string, word: string) => {
    const name = cleanName(word)
    if (!name) return null
    const row = db.query("select id from persons where user_id = ? and name = ? collate nocase").get(userId, name) as { id: number } | null
    return row?.id ?? null
  }

  function people(user: User) {
    const named = db
      .query(
        `select ps.id, ps.name, count(distinct f.photo_id) as photos,
           (select f2.id from faces f2 where f2.person_id = ps.id and f2.user_id = ps.user_id order by f2.labeled_by = 'user' desc, f2.score desc limit 1) as cover
         from persons ps join faces f on f.person_id = ps.id and f.user_id = ps.user_id
         where ps.user_id = ? group by ps.id order by photos desc, ps.name`,
      )
      .all(user.id) as { id: number; name: string; photos: number; cover: string }[]
    const open = db.query("select id, photo_id, vector from faces where user_id = ? and labeled_by is null").all(user.id) as FaceRow[]
    const groups = group(open.map(face => toVector(face.vector)))
      .slice(0, MAX_GROUPS)
      .map(members => ({ size: members.length, faces: members.slice(0, GROUP_SAMPLE).map(i => open[i].id), all: members.map(i => open[i].id) }))
    return json({ people: named, groups })
  }

  // Names faces as one person, made if new; name null marks them as not
  // someone to name. Only this user's faces change.
  function name(user: User, faceIds: unknown, rawName: unknown) {
    if (!Array.isArray(faceIds) || faceIds.length === 0 || faceIds.length > 2000 || !faceIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{12}$/.test(id))) throw new HttpError(400, "bad faces")
    const clean = rawName === null ? null : cleanName(rawName)
    if (rawName !== null && !clean) throw new HttpError(400, "bad name")
    let changed = 0
    db.transaction(() => {
      let person: number | null = null
      if (clean) {
        db.query("insert into persons (user_id, name, created_at) values (?, ?, ?) on conflict(user_id, name) do nothing").run(user.id, clean, Date.now())
        person = (db.query("select id from persons where user_id = ? and name = ?").get(user.id, clean) as { id: number }).id
      }
      const set = db.query("update faces set person_id = ?, labeled_by = 'user' where id = ? and user_id = ?")
      for (const id of faceIds as string[]) changed += set.run(person, id, user.id).changes
    })()
    if (changed === 0) throw new HttpError(404)
    const matched = match(user.id)
    log("faces.named", { faces: changed, matched, dismissed: clean === null })
    return json({ named: changed, matched })
  }

  // Renames a person; a name already taken merges the two.
  function rename_(user: User, id: number, rawName: unknown) {
    const clean = cleanName(rawName)
    if (!clean) throw new HttpError(400, "bad name")
    const person = db.query("select id from persons where id = ? and user_id = ?").get(id, user.id)
    if (!person) throw new HttpError(404)
    db.transaction(() => {
      const other = db.query("select id from persons where user_id = ? and name = ? and id != ?").get(user.id, clean, id) as { id: number } | null
      if (other) {
        db.query("update faces set person_id = ? where person_id = ? and user_id = ?").run(other.id, id, user.id)
        db.query("delete from persons where id = ? and user_id = ?").run(id, user.id)
      } else db.query("update persons set name = ? where id = ? and user_id = ?").run(clean, id, user.id)
    })()
    return json({ ok: true })
  }

  // Forgets a person: their faces go back to unnamed (and may group again).
  function forget(user: User, id: number) {
    const gone = db.transaction(() => {
      db.query("update faces set person_id = null, labeled_by = null where person_id = ? and user_id = ?").run(id, user.id)
      return db.query("delete from persons where id = ? and user_id = ?").run(id, user.id).changes
    })()
    if (!gone) throw new HttpError(404)
    match(user.id)
    return json({ ok: true })
  }

  // A square crop around one face, from the large preview, cached beside it.
  async function crop(user: User, faceId: string) {
    if (!/^[A-Za-z0-9_-]{12}$/.test(faceId)) throw new HttpError(404)
    // The row is the photo's, plus the face's box.
    const face = db.query("select f.box, p.* from faces f join photos p on p.id = f.photo_id where f.id = ? and f.user_id = ? and p.user_id = ?").get(faceId, user.id, user.id) as (Photo & { box: string }) | null
    if (!face) throw new HttpError(404)
    // Beside the photo's previews, so a new render of the photo drops it.
    const path = join(library.cacheDir(face.id), `face-${faceId}.webp`)
    if (!(await Bun.file(path).exists())) {
      const [x1, y1, x2, y2] = JSON.parse(face.box) as number[]
      const side = Math.round(Math.max(x2 - x1, y2 - y1) * 1.6)
      const left = Math.max(0, Math.min(face.width - side, Math.round((x1 + x2) / 2 - side / 2)))
      const top = Math.max(0, Math.min(face.height - side, Math.round((y1 + y2) / 2 - side / 2)))
      const size = Math.min(side, face.width, face.height)
      const tmp = join(config.tmp, `face-${newId()}.webp`)
      await mkdir(config.tmp, { recursive: true })
      try {
        await run(["vips", "crop", library.file(face, "large"), `${tmp}[Q=80,strip]`, String(Math.max(0, left)), String(Math.max(0, top)), String(size), String(size)])
        await run(["vipsthumbnail", tmp, "--size", "256x256", "-o", `${tmp}.small.webp[Q=80,strip]`])
        await rename(`${tmp}.small.webp`, path)
      } finally {
        await rm(tmp, { force: true })
      }
    }
    return new Response(Bun.file(path), { headers: { "content-type": "image/webp", "cache-control": "private, max-age=86400", vary: "Cookie" } })
  }

  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (url.pathname === "/api/people" && req.method === "GET") return people(user)
    if (url.pathname === "/api/people/name" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { faces?: unknown; name?: unknown } | null
      return name(user, body?.faces, body?.name ?? null)
    }
    const person = /^\/api\/people\/(\d+)$/.exec(url.pathname)
    if (person && req.method === "PATCH") return rename_(user, Number(person[1]), ((await req.json().catch(() => null)) as { name?: unknown } | null)?.name)
    if (person && req.method === "DELETE") return forget(user, Number(person[1]))
    const face = /^\/api\/faces\/([^/]+)$/.exec(url.pathname)
    if (face && req.method === "GET") return crop(user, face[1])
    throw new HttpError(404)
  }

  const pending = (userId: string) =>
    !embed.enabled ? 0 : (db.query("select count(*) as n from photos p left join face_scans s on s.photo_id = p.id where p.user_id = ? and p.status = 'ready' and p.kind = 'image' and (s.photo_id is null or s.version != p.version or s.model != ?)").get(userId, FACE_MODEL) as { n: number }).n

  return { pump, handle, personId, pending, match }
}

export type Faces = ReturnType<typeof createFaces>
