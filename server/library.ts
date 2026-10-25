// The library: originals under library/<user id>/, read only. A scan finds new,
// changed and removed files, reads their metadata with exiftool and makes two
// WebP sizes with vips (videos first give a frame with ffmpeg).
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, extname, join, relative, sep } from "node:path"
import type { Config } from "./config"
import type { Db, Photo } from "./db"
import { resolveExisting } from "./paths"
import { log } from "./otel"

const IMAGE = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp", ".gif", ".tif", ".tiff", ".dng", ".avif"])
const VIDEO = new Set([".mov", ".mp4", ".m4v"])
// Taiwan time when a file says nothing about its zone.
const DEFAULT_OFFSET = "+08:00"
export const SIZES = { large: "2048x2048>", thumb: "640x2000>" } as const

type Found = { path: string; size: number; mtime: number; kind: Photo["kind"]; live: string | null }
type Meta = { takenAt: number | null; lat: number | null; lon: number | null; duration: number | null }

export const newId = () => randomBytes(9).toString("base64url")

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 200)}`)
  return out
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
  return { takenAt, lat: lat !== null && lon !== null && (lat !== 0 || lon !== 0) ? lat : null, lon: lat !== null && lon !== null && (lat !== 0 || lon !== 0) ? lon : null, duration }
}

async function exiftool(paths: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    const text = await run(["exiftool", "-json", "-n", "-q", "-q", "-fast", "-DateTimeOriginal", "-OffsetTimeOriginal", "-OffsetTime", "-OffsetTimeDigitized", "-CreationDate", "-CreateDate", "-MIMEType", "-GPSLatitude", "-GPSLongitude", "-Duration", ...chunk]).catch(() => "[]")
    for (const tags of JSON.parse(text || "[]") as Record<string, unknown>[]) out.set(String(tags.SourceFile), tags)
  }
  return out
}

// Walks one user's folder. A photo and a short video with the same name in the
// same folder are a Live Photo: the video rides along and is not listed alone.
export async function walk(root: string): Promise<Found[]> {
  const files: { path: string; size: number; mtime: number; ext: string }[] = []
  async function visit(dir: string) {
    // The root must read; a missing mount must not look like an empty library.
    const entries = dir === root ? await readdir(dir, { withFileTypes: true }) : await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (!IMAGE.has(ext) && !VIDEO.has(ext)) continue
        const info = await stat(full).catch(() => null)
        if (info) files.push({ path: relative(root, full).split(sep).join("/"), size: info.size, mtime: Math.floor(info.mtimeMs), ext })
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

export function createLibrary(config: Config, db: Db) {
  const queue: { userId: string; found: Found; meta: Meta; id: string; version: number }[] = []
  let running = 0
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
      log("library.render_failed", { id: id.slice(0, 4), kind: found.kind, error: /^Error: (\S+ exited \d+)/.exec(String(error))?.[1] ?? "error" }, "WARN")
    }
    db.query(
      `insert into photos (id, user_id, path, size, mtime, kind, taken_at, width, height, duration, lat, lon, live_path, status, version)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(user_id, path) do update set size = excluded.size, mtime = excluded.mtime, kind = excluded.kind, taken_at = excluded.taken_at,
         width = excluded.width, height = excluded.height, duration = excluded.duration, lat = excluded.lat, lon = excluded.lon,
         live_path = excluded.live_path, status = excluded.status, version = excluded.version`,
    ).run(id, userId, found.path, found.size, found.mtime, found.kind, meta.takenAt ?? found.mtime, size.width, size.height, meta.duration, meta.lat, meta.lon, found.live, status, version)
  }

  function pump() {
    while (running < config.workers && queue.length > 0) {
      const job = queue.shift()!
      running++
      process(job).finally(() => {
        running--
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
    const found = await walk(root)
    const known = new Map(
      (db.query("select id, path, size, mtime, live_path, version from photos where user_id = ?").all(userId) as Pick<Photo, "id" | "path" | "size" | "mtime" | "live_path" | "version">[]).map(p => [p.path, p]),
    )
    const changed = found.filter(f => {
      const old = known.get(f.path)
      return !old || old.size !== f.size || old.mtime !== f.mtime || old.live_path !== f.live
    })
    const seen = new Set(found.map(f => f.path))
    const gone = [...known.values()].filter(p => !seen.has(p.path))
    for (const photo of gone) {
      db.query("delete from photos where id = ?").run(photo.id)
      await rm(cacheDir(photo.id), { recursive: true, force: true })
    }
    const tags = await exiftool(changed.map(f => join(root, f.path)))
    for (const f of changed) {
      const old = known.get(f.path)
      queue.push({ userId, found: f, meta: readMeta(tags.get(join(root, f.path)) ?? {}), id: old?.id ?? newId(), version: (old?.version ?? 0) + 1 })
    }
    if (changed.length || gone.length) log("library.scan", { user: userId, files: found.length, changed: changed.length, removed: gone.length })
    pump()
  }

  // One scan at a time; a call during a scan waits for it.
  function scan() {
    scanning ??= (async () => {
      const users = db.query("select id from users").all() as { id: string }[]
      // One user's failure must not stop the others.
      for (const user of users) await scanUser(user.id).catch(error => log("library.scan_failed", { user: user.id, error: String(error).split(":")[0] }, "ERROR"))
    })().finally(() => {
      scanning = null
    })
    return scanning
  }

  return { scan, drained, file, cacheDir }
}
