// The library: originals under library/<user id>/, read only. A scan finds new,
// changed and removed files, reads their metadata with exiftool and makes two
// WebP sizes with vips (videos first give a frame with ffmpeg).
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, extname, join, relative, sep } from "node:path"
import type { Config } from "./config"
import type { Db, Photo } from "./db"
import type { Places } from "./places"
import { resolveExisting } from "./paths"
import { log } from "./otel"

export const IMAGE = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp", ".gif", ".tif", ".tiff", ".dng", ".avif"])
export const VIDEO = new Set([".mov", ".mp4", ".m4v"])
// Taiwan time when a file says nothing about its zone.
const DEFAULT_OFFSET = "+08:00"
// Renders a photo gets per server start before a failure is left alone.
const TRIES = 3
export const SIZES = { large: "2048x2048>", thumb: "640x2000>" } as const

type Found = { path: string; size: number; mtime: number; kind: Photo["kind"]; live: string | null }
type Meta = { takenAt: number | null; lat: number | null; lon: number | null; duration: number | null; title: string; description: string }

// For matching typed words against text: one form for both.
export const textKey = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "")
// A photo's title and description, kept apart so a word never spans the two.
export const noteKey = (title: string, description: string) => `${textKey(title)}|${textKey(description)}`

export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 2000

export const newId = () => randomBytes(9).toString("base64url")

export async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 200)}`)
  return out
}

// Camera details for the info panel, read when asked: one file, numbers as numbers.
export async function cameraInfo(path: string) {
  const text = await run(["exiftool", "-json", "-n", "-q", "-q", "-fast", "-Make", "-Model", "-LensModel", "-ISO", "-FNumber", "-ExposureTime", "-FocalLength", "-FocalLengthIn35mmFormat", "-ExposureCompensation", "-VideoFrameRate", "-CompressorName", "-ImageSize", "--", path]).catch(() => "[]")
  const tags = ((JSON.parse(text) as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>
  const str = (key: string) => (typeof tags[key] === "string" ? (tags[key] as string).trim().slice(0, 100) || null : null)
  const num = (key: string) => (typeof tags[key] === "number" && Number.isFinite(tags[key]) ? (tags[key] as number) : null)
  return {
    make: str("Make"),
    model: str("Model"),
    lens: str("LensModel"),
    iso: num("ISO"),
    fNumber: num("FNumber"),
    exposure: num("ExposureTime"),
    focal: num("FocalLength"),
    focal35: num("FocalLengthIn35mmFormat"),
    ev: num("ExposureCompensation"),
    fps: num("VideoFrameRate"),
    codec: str("CompressorName"),
    // The original's pixel size, sides in either order: "5712 4284".
    pixels: typeof tags.ImageSize === "string" ? (tags.ImageSize as string).split(/[ x]/).map(Number).filter(n => Number.isInteger(n) && n > 0) : [],
  }
}

// "2025:10:01 12:34:56" plus an offset like "+08:00", as epoch ms.
export function exifTime(value: unknown, offset?: unknown): number | null {
  if (typeof value !== "string") return null
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?/.exec(value.trim())
  if (!match || match[1] === "0000") return null
  const [, y, mo, d, h, mi, s, inline] = match
  const zone = inline ?? (typeof offset === "string" && /^(Z|[+-]\d{2}:\d{2})$/.test(offset) ? offset : DEFAULT_OFFSET)
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`)
  return Number.isFinite(ms) ? ms : null
}

export function readMeta(tags: Record<string, unknown>): Meta {
  // QuickTime CreationDate carries its zone; CreateDate in a movie is UTC.
  const takenAt =
    exifTime(tags.DateTimeOriginal, tags.OffsetTimeOriginal ?? tags.OffsetTime) ??
    exifTime(tags.CreationDate) ??
    (typeof tags.CreateDate === "string" && tags.MIMEType?.toString().startsWith("video/") ? exifTime(tags.CreateDate, "Z") : exifTime(tags.CreateDate, tags.OffsetTimeDigitized))
  const lat = typeof tags.GPSLatitude === "number" ? tags.GPSLatitude : null
  const lon = typeof tags.GPSLongitude === "number" ? tags.GPSLongitude : null
  const duration = typeof tags.Duration === "number" ? tags.Duration : null
  // XMP and QuickTime Title and Description, else IPTC ObjectName and Caption-Abstract.
  const text = (...values: unknown[]) => String(values.find(v => (typeof v === "string" || typeof v === "number") && String(v).trim()) ?? "").trim()
  const title = text(tags.Title, tags.ObjectName).slice(0, TITLE_MAX)
  const description = text(tags.Description, tags["Caption-Abstract"]).slice(0, DESCRIPTION_MAX)
  return { title, description, takenAt, lat: lat !== null && lon !== null && (lat !== 0 || lon !== 0) ? lat : null, lon: lat !== null && lon !== null && (lat !== 0 || lon !== 0) ? lon : null, duration }
}

async function exiftool(paths: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    const text = await run(["exiftool", "-json", "-n", "-q", "-q", "-fast", "-DateTimeOriginal", "-OffsetTimeOriginal", "-OffsetTime", "-OffsetTimeDigitized", "-CreationDate", "-CreateDate", "-MIMEType", "-GPSLatitude", "-GPSLongitude", "-Duration", "-Title", "-Description", "-ObjectName", "-Caption-Abstract", ...chunk]).catch(() => "[]")
    for (const tags of JSON.parse(text || "[]") as Record<string, unknown>[]) out.set(String(tags.SourceFile), tags)
  }
  return out
}

// Walks one user's folder. A photo and a short video with the same name in the
// same folder are a Live Photo: the video rides along and is not listed alone.
// A folder or file that fails to read goes into `unread`, so the scan does not
// take a hiccup for a deletion.
export async function walk(root: string, unread: string[] = []): Promise<Found[]> {
  const files: { path: string; size: number; mtime: number; ext: string }[] = []
  async function visit(dir: string) {
    // The root must read; a missing mount must not look like an empty library.
    const entries =
      dir === root
        ? await readdir(dir, { withFileTypes: true })
        : await readdir(dir, { withFileTypes: true }).catch(() => {
            unread.push(relative(root, dir).split(sep).join("/") + "/")
            return []
          })
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (!IMAGE.has(ext) && !VIDEO.has(ext)) continue
        const info = await stat(full).catch(() => null)
        const path = relative(root, full).split(sep).join("/")
        if (!info) unread.push(path)
        else files.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs), ext })
      }
    }
  }
  await visit(root)
  const stem = (path: string) => path.slice(0, path.length - extname(path).length).toLowerCase()
  const images = new Map(files.filter(f => IMAGE.has(f.ext)).map(f => [stem(f.path), f]))
  const liveOf = new Map<string, string>()
  for (const f of files) if (VIDEO.has(f.ext) && images.has(stem(f.path))) liveOf.set(images.get(stem(f.path))!.path, f.path)
  const paired = new Set(liveOf.values())
  return files
    .filter(f => !paired.has(f.path))
    .map(f => ({ path: f.path, size: f.size, mtime: f.mtime, kind: IMAGE.has(f.ext) ? "image" : "video", live: liveOf.get(f.path) ?? null }))
}

export function createLibrary(config: Config, db: Db, places: Places) {
  const queue: { userId: string; found: Found; meta: Meta; id: string; version: number }[] = []
  let running = 0
  // Photos deleted while a preview job for them may still be queued or running.
  const forgotten = new Set<string>()
  // Files being rendered right now, per user, for the upload status.
  const busy = new Map<string, number>()
  // Files queued or rendering, as "<user>/<path>", so an overlapping scan does not queue them again.
  const queued = new Set<string>()
  // Failed renders per photo since start: a failed photo is tried again on later scans, up to TRIES renders.
  const failures = new Map<string, number>()
  let scanning: Promise<void> | null = null
  let idle: (() => void)[] = []

  const cacheDir = (id: string) => join(config.cache, id)

  function file(photo: Pick<Photo, "id">, size: keyof typeof SIZES) {
    return join(cacheDir(photo.id), `${size}.webp`)
  }

  // A frame or the photo itself, made into both WebP sizes.
  async function render(source: string, kind: Photo["kind"], id: string) {
    const work = join(config.tmp, `${id}-${newId()}`)
    await mkdir(work, { recursive: true })
    try {
      let still = source
      if (kind === "video") {
        still = join(work, "frame.png")
        await run(["ffmpeg", "-v", "error", "-protocol_whitelist", "file", "-i", source, "-frames:v", "1", "-y", still])
      }
      const large = join(work, "large.webp")
      const thumb = join(work, "thumb.webp")
      // vips turns the photo upright and into sRGB on the way.
      await run(["vipsthumbnail", still, "--size", SIZES.large, "--export-profile", "srgb", "-o", `${large}[Q=82,strip]`])
      await run(["vipsthumbnail", large, "--size", SIZES.thumb, "-o", `${thumb}[Q=78,strip]`])
      const width = Number((await run(["vipsheader", "-f", "width", large])).trim())
      const height = Number((await run(["vipsheader", "-f", "height", large])).trim())
      const dest = cacheDir(id)
      await rm(dest, { recursive: true, force: true })
      await mkdir(dirname(dest), { recursive: true })
      await rename(work, dest)
      return { width, height }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  async function process(job: (typeof queue)[number]) {
    const { userId, found, meta, id, version } = job
    if (forgotten.has(id)) return
    let status: Photo["status"] = "ready"
    let size = { width: 0, height: 0 }
    try {
      // Resolve again right before reading: the file may have become a
      // symlink since the scan, and nothing outside this user's folder renders.
      const source = await resolveExisting(join(config.library, userId), found.path)
      size = await render(source, found.kind, id)
    } catch (error) {
      status = "failed"
      // Tool errors quote the file path, so only the tool and its exit code go out.
      failures.set(id, (failures.get(id) ?? 0) + 1)
      log("library.render_failed", { id: id.slice(0, 4), kind: found.kind, error: /^Error: (\S+ exited \d+)/.exec(String(error))?.[1] ?? "error" }, "WARN")
    }
    // Deleted during the render: drop what it made and write no row.
    if (forgotten.has(id)) {
      await rm(cacheDir(id), { recursive: true, force: true })
      return
    }
    if (status === "ready") failures.delete(id)
    const town = meta.lat !== null && meta.lon !== null ? places.nearest(meta.lat, meta.lon) : null
    db.query(
      `insert into photos (id, user_id, path, size, mtime, kind, taken_at, width, height, duration, lat, lon, live_path, status, version, place_id, country)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(user_id, path) do update set size = excluded.size, mtime = excluded.mtime, kind = excluded.kind, taken_at = excluded.taken_at,
         width = excluded.width, height = excluded.height, duration = excluded.duration, lat = excluded.lat, lon = excluded.lon,
         live_path = excluded.live_path, status = excluded.status, version = excluded.version, place_id = excluded.place_id, country = excluded.country`,
    ).run(id, userId, found.path, found.size, found.mtime, found.kind, meta.takenAt ?? found.mtime, size.width, size.height, meta.duration, meta.lat, meta.lon, found.live, status, version, town?.id ?? null, town?.country ?? null)
    // The file's own title and description, only while the user has none.
    if (meta.title || meta.description)
      db.query("insert into photo_notes (photo_id, user_id, title, description, text_key, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(photo_id) do nothing").run(
        id, userId, meta.title, meta.description, noteKey(meta.title, meta.description), Date.now(),
      )
  }

  function pump() {
    while (running < config.workers && queue.length > 0) {
      const job = queue.shift()!
      running++
      busy.set(job.userId, (busy.get(job.userId) ?? 0) + 1)
      process(job)
        .catch(error => log("library.process_failed", { id: job.id.slice(0, 4), error: String(error).split(":")[0] }, "ERROR"))
        .finally(() => {
          queued.delete(`${job.userId}/${job.found.path}`)
          running--
          busy.set(job.userId, busy.get(job.userId)! - 1)
          pump()
        })
    }
    if (running === 0 && queue.length === 0) {
      for (const done of idle) done()
      idle = []
    }
  }

  // Resolves once every queued file is rendered.
  const drained = () => (running === 0 && queue.length === 0 ? Promise.resolve() : new Promise<void>(resolve => idle.push(resolve)))

  async function scanUser(userId: string) {
    const root = join(config.library, userId)
    // The user folder itself must be a real folder, not a link to another one.
    if (!(await lstat(root).catch(() => null))?.isDirectory()) {
      log("library.no_folder", { user: userId }, "WARN")
      return
    }
    const unread: string[] = []
    const found = await walk(root, unread)
    const known = new Map(
      (db.query("select id, path, size, mtime, kind, live_path, version, status from photos where user_id = ?").all(userId) as Pick<Photo, "id" | "path" | "size" | "mtime" | "kind" | "live_path" | "version" | "status">[]).map(p => [p.path, p]),
    )
    const seen = new Set(found.map(f => f.path))
    // A path that failed to read, or sits under a folder that did, is not gone.
    const missed = (path: string) => unread.some(u => (u.endsWith("/") ? path.startsWith(u) : path === u))
    let gone = [...known.values()].filter(p => !seen.has(p.path) && !missed(p.path))
    // A moved or renamed file keeps its row, and with it the title, albums and
    // faces: one gone row and one new file with the same size, time and kind.
    const sameFile = (p: { size: number; mtime: number; kind: string }) => `${p.size}:${p.mtime}:${p.kind}`
    const goneBy = Map.groupBy(gone, sameFile)
    const fresh = Map.groupBy(found.filter(f => !known.has(f.path)), sameFile)
    const moved = new Set<string>()
    for (const [key, files] of fresh) {
      const rows = goneBy.get(key)
      if (files.length !== 1 || rows?.length !== 1 || queued.has(`${userId}/${rows[0].path}`)) continue
      db.query("update photos set path = ?, live_path = ? where id = ? and user_id = ?").run(files[0].path, files[0].live, rows[0].id, userId)
      known.delete(rows[0].path)
      known.set(files[0].path, { ...rows[0], path: files[0].path, live_path: files[0].live })
      moved.add(rows[0].id)
    }
    gone = gone.filter(p => !moved.has(p.id))
    const changed = found.filter(f => {
      if (queued.has(`${userId}/${f.path}`)) return false
      const old = known.get(f.path)
      return !old || old.size !== f.size || old.mtime !== f.mtime || old.live_path !== f.live || (old.status === "failed" && (failures.get(old.id) ?? 0) < TRIES)
    })
    for (const photo of gone) {
      db.query("delete from photos where id = ?").run(photo.id)
      await rm(cacheDir(photo.id), { recursive: true, force: true })
    }
    const tags = await exiftool(changed.map(f => join(root, f.path)))
    for (const f of changed) {
      const old = known.get(f.path)
      queued.add(`${userId}/${f.path}`)
      queue.push({ userId, found: f, meta: readMeta(tags.get(join(root, f.path)) ?? {}), id: old?.id ?? newId(), version: (old?.version ?? 0) + 1 })
    }
    if (changed.length || gone.length || moved.size || unread.length)
      log("library.scan", { user: userId, files: found.length, changed: changed.length, removed: gone.length, moved: moved.size, unread: unread.length })
    pump()
  }

  // Photos scanned before places existed, or before the town file arrived.
  // The first scan after a start places every photo again, so a change in
  // how towns are chosen reaches old photos too.
  let placedAll = false
  function placeMissing() {
    if (!places.ready) return
    const rows = db.query(`select id, lat, lon from photos where lat is not null${placedAll ? " and place_id is null" : ""}`).all() as Pick<Photo, "id" | "lat" | "lon">[]
    placedAll = true
    const set = db.query("update photos set place_id = ?, country = ? where id = ?")
    db.transaction(() => {
      for (const row of rows) {
        const town = places.nearest(row.lat!, row.lon!)
        if (town) set.run(town.id, town.country, row.id)
      }
    })()
    if (rows.length) log("library.places", { photos: rows.length })
  }

  // One scan at a time. A call during a scan runs one more scan after it, so
  // a file that lands mid-scan (an upload) is picked up without waiting.
  let again = false
  function scan(): Promise<void> {
    if (scanning) {
      again = true
      return scanning
    }
    scanning = (async () => {
      placeMissing()
      do {
        again = false
        const users = db.query("select id from users").all() as { id: string }[]
        // One user's failure must not stop the others.
        for (const user of users) await scanUser(user.id).catch(error => log("library.scan_failed", { user: user.id, error: String(error).split(":")[0] }, "ERROR"))
      } while (again)
    })().finally(() => {
      scanning = null
      // A call that came in after the last check still gets its scan.
      if (again) void scan()
    })
    return scanning
  }

  // How many of a user's files still wait for previews, scan included.
  const pending = (userId: string) => ({
    files: queue.filter(job => job.userId === userId).length + (busy.get(userId) ?? 0),
    scanning: scanning !== null,
  })

  function forget(id: string) {
    forgotten.add(id)
    for (let i = queue.length - 1; i >= 0; i--)
      if (queue[i].id === id) {
        queued.delete(`${queue[i].userId}/${queue[i].found.path}`)
        queue.splice(i, 1)
      }
  }

  // A delete that failed: its photo may render again.
  const remember = (id: string) => void forgotten.delete(id)

  return { scan, drained, file, cacheDir, pending, forget, remember }
}
