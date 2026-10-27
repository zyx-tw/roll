// Smart search: after previews exist, each photo version is read once by the
// embed service. A photo gives one vector and its text (OCR); a video gives a
// vector for a few frames. EXIF adds front camera and screenshot. Searching
// ranks a user's photos by meaning, with text found in a photo first.
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config"
import type { Db, Photo } from "./db"
import { EmbedDown, type Embed } from "./embed"
import { newId, run, textKey, type createLibrary } from "./library"
import { log } from "./otel"
import { resolveExisting } from "./paths"

// Changes when what goes into a vector changes (model, preview size, frames):
// every photo is read again.
export const MODEL = "embeddinggemma-2@914f7f8/large2048/f3"
// Where in a video the frames are taken, as fractions of its length.
const FRAMES = [0.15, 0.5, 0.85]
// A photo whose meaning is this many standard deviations above the mean of
// the photos searched counts as a match (as on gallery).
const SPREAD = 1.5
// Even a narrow search shows its best few...
const AT_LEAST = 3
// ...but nothing below this cosine: a query for something the library does
// not hold must find nothing. Measured on 323 photos (EmbeddingGemma 2): the
// best photo for something present scored 0.69 to 0.74 (拉麵, 夜景, 鳥居,
// 飛機), for something absent 0.63 to 0.66 (貓, 雪, 婚禮, 游泳池).
export const FLOOR = 0.67

export { textKey }

// Words that pick a kind of photo. Each is a SQL condition on photos p and photo_index i.
const KINDS: [string[], string][] = [
  [["自拍", "selfie", "selfies"], "i.front = 1"],
  [["截圖", "截屏", "螢幕截圖", "屏幕截图", "screenshot", "screenshots"], "i.screenshot = 1"],
  [["影片", "視頻", "视频", "video", "videos"], "p.kind = 'video'"],
  [["照片", "相片", "photo", "photos"], "p.kind = 'image'"],
  [["原況", "原況照片", "實況", "live"], "p.live_path is not null"],
  [["全景", "panorama"], "p.kind = 'image' and p.width >= 2.5 * p.height"],
]
const KIND_BY_WORD = new Map(KINDS.flatMap(([words, sql]) => words.map(word => [word, sql] as const)))
export const kindClause = (word: string) => KIND_BY_WORD.get(word.normalize("NFKC").toLowerCase()) ?? null

const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

// iOS writes "Screenshot" into a screenshot's UserComment; a PNG with no camera
// is a screenshot from anywhere else. The front camera says so in its lens.
export function readKind(tags: Record<string, unknown>, path: string) {
  const comment = typeof tags.UserComment === "string" ? tags.UserComment.trim().toLowerCase() : ""
  const lens = typeof tags.LensModel === "string" ? tags.LensModel : ""
  const screenshot = comment === "screenshot" || (/\.png$/i.test(path) && typeof tags.Make !== "string")
  return { front: /front/i.test(lens) ? 1 : 0, screenshot: screenshot ? 1 : 0 }
}

export function createSmart(config: Config, db: Db, library: ReturnType<typeof createLibrary>, embed: Embed) {
  let running: Promise<void> | null = null
  // Vectors by photo id and version, so a search does not read them all from disk.
  const vectors = new Map<string, { version: number; list: Float32Array[] }>()

  const next = db.query(
    `select p.* from photos p left join photo_index i on i.photo_id = p.id
     where p.status = 'ready' and (i.photo_id is null or i.version != p.version or i.model != ?)
     order by p.taken_at desc limit 1`,
  )

  async function frames(photo: Photo) {
    const source = await resolveExisting(join(config.library, photo.user_id), photo.path)
    const work = join(config.tmp, `frames-${newId()}`)
    await mkdir(work, { recursive: true })
    try {
      const out: Uint8Array[] = []
      for (const [n, at] of FRAMES.entries()) {
        const file = join(work, `${n}.jpg`)
        const seconds = (photo.duration ?? 0) * at
        await run(["ffmpeg", "-v", "error", "-protocol_whitelist", "file", "-ss", seconds.toFixed(2), "-i", source, "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "3", "-y", file])
        out.push(await readFile(file))
      }
      return out
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  async function exifKind(photo: Photo) {
    const source = await resolveExisting(join(config.library, photo.user_id), photo.path)
    const text = await run(["exiftool", "-json", "-q", "-q", "-fast", "-UserComment", "-LensModel", "-Make", "--", source]).catch(() => "[]")
    return readKind(((JSON.parse(text) as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>, photo.path)
  }

  async function index(photo: Photo) {
    const started = performance.now()
    let list: Float32Array[] = []
    let lines: { text: string }[] = []
    let kind = { front: 0, screenshot: 0 }
    let error: string | null = null
    try {
      kind = await exifKind(photo)
      if (photo.kind === "video") list = await embed.images(await frames(photo))
      else {
        const large = await readFile(library.file(photo, "large"))
        ;[list, lines] = await Promise.all([embed.images([large]), embed.ocr(large)])
      }
    } catch (err) {
      // The service being down is retried on the next round; a bad file is not.
      if (err instanceof EmbedDown) throw err
      error = String(err).split(":")[0].slice(0, 60)
    }
    const text = lines.map(line => line.text).join("\n")
    db.transaction(() => {
      // The photo may have gone or changed while it was read.
      const now = db.query("select version from photos where id = ? and user_id = ?").get(photo.id, photo.user_id) as { version: number } | null
      if (!now || now.version !== photo.version) return
      db.query("delete from photo_vectors where photo_id = ?").run(photo.id)
      const insert = db.query("insert into photo_vectors (photo_id, frame, vector) values (?, ?, ?)")
      list.forEach((vector, frame) => insert.run(photo.id, frame, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)))
      db.query(
        `insert into photo_index (photo_id, user_id, version, model, front, screenshot, text, text_key, error, indexed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(photo_id) do update set user_id = excluded.user_id, version = excluded.version, model = excluded.model, front = excluded.front,
           screenshot = excluded.screenshot, text = excluded.text, text_key = excluded.text_key, error = excluded.error, indexed_at = excluded.indexed_at`,
      ).run(photo.id, photo.user_id, photo.version, MODEL, kind.front, kind.screenshot, text, textKey(text), error, Date.now())
      vectors.set(photo.id, { version: photo.version, list })
    })()
    log("smart.indexed", { id: photo.id.slice(0, 4), kind: photo.kind, vectors: list.length, chars: text.length, ms: Math.round(performance.now() - started), failed: error ?? undefined }, error ? "WARN" : "INFO")
  }

  // Reads every photo that has no index for its version, newest first, one at
  // a time (the service runs one photo at a time anyway). Stops when the
  // service is down; the next scan starts it again.
  function pump() {
    if (!embed.enabled || running) return running ?? Promise.resolve()
    running = (async () => {
      let photo: Photo | null
      while ((photo = next.get(MODEL) as Photo | null)) {
        try {
          await index(photo)
        } catch (error) {
          log("smart.embed_down", { error: String(error).slice(0, 80) }, "WARN")
          return
        }
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  function load(id: string, version: number) {
    const hit = vectors.get(id)
    if (hit && hit.version === version) return hit.list
    const rows = db.query("select vector from photo_vectors where photo_id = ? order by frame").all(id) as { vector: Uint8Array }[]
    const list = rows.map(row => new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)))
    vectors.set(id, { version, list })
    return list
  }

  // Ranks candidate photos (already limited to this user and the other
  // words' filters) for the free words: text found in a photo first, then
  // meaning above the bar. Returns ids in order.
  async function rank(candidates: { id: string; version: number; text_key: string | null; indexed: number | null }[], free: string[]) {
    const keys = free.map(textKey).filter(Boolean)
    const byText = candidates.filter(c => c.text_key && keys.every(key => c.text_key!.includes(key)))
    let query: Float32Array | null = null
    try {
      query = await embed.query(free.join(" "))
    } catch (error) {
      log("smart.query_failed", { error: String(error).slice(0, 80) }, "WARN")
    }
    const scored: { id: string; score: number }[] = []
    if (query) {
      for (const c of candidates) {
        if (c.indexed === null) continue
        let best = -1
        for (const vector of load(c.id, c.version)) best = Math.max(best, dot(query, vector))
        if (best > -1) scored.push({ id: c.id, score: best })
      }
    }
    const score = new Map(scored.map(s => [s.id, s.score]))
    const textIds = new Set(byText.map(c => c.id))
    const meaning: string[] = []
    if (scored.length) {
      const mean = scored.reduce((sum, s) => sum + s.score, 0) / scored.length
      const sd = Math.sqrt(scored.reduce((sum, s) => sum + (s.score - mean) ** 2, 0) / scored.length)
      const sorted = scored.filter(s => !textIds.has(s.id)).sort((a, b) => b.score - a.score)
      sorted.forEach((s, i) => {
        if (s.score >= FLOOR && (s.score >= mean + SPREAD * sd || i < AT_LEAST)) meaning.push(s.id)
      })
    }
    const textOrder = [...textIds].sort((a, b) => (score.get(b) ?? -1) - (score.get(a) ?? -1))
    return [...textOrder, ...meaning]
  }

  // Photos still waiting to be read; none when search by meaning is off.
  const pending = (userId: string) =>
    !embed.enabled ? 0 : (db.query("select count(*) as n from photos p left join photo_index i on i.photo_id = p.id where p.user_id = ? and p.status = 'ready' and (i.photo_id is null or i.version != p.version or i.model != ?)").get(userId, MODEL) as { n: number }).n

  return { enabled: embed.enabled, pump, rank, pending }
}

export type Smart = ReturnType<typeof createSmart>
