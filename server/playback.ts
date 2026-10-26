// Playback copies: a phone video can run at 100 Mbps, too much to stream over
// a home connection. Each large video gets a 1080p HEVC copy at about 8 Mbps,
// kept in its cache folder, encoded on the Intel GPU (VA-API) so HDR stays HDR.
// Without the GPU nothing is made and players fall back to the original.
import { existsSync } from "node:fs"
import { rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config"
import type { Db, Photo } from "./db"
import { newId, run, type createLibrary } from "./library"
import { log } from "./otel"
import { resolveExisting } from "./paths"

const LONG_SIDE = 1920
const MAX_BITRATE = 12_000_000

type Probe = { width: number; height: number; bitRate: number; primaries?: string; transfer?: string; space?: string; audio: boolean }

async function probe(path: string): Promise<Probe | null> {
  const text = await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,color_primaries,color_transfer,color_space:format=bit_rate", "-of", "json", "--", path]).catch(() => "")
  if (!text) return null
  const data = JSON.parse(text) as { streams?: Record<string, unknown>[]; format?: { bit_rate?: string } }
  const video = data.streams?.find(s => s.codec_type === "video")
  if (!video) return null
  const tag = (key: string) => (typeof video[key] === "string" && /^[a-z0-9-]+$/.test(video[key] as string) ? (video[key] as string) : undefined)
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    bitRate: Number(data.format?.bit_rate) || 0,
    primaries: tag("color_primaries"),
    transfer: tag("color_transfer"),
    space: tag("color_space"),
    audio: !!data.streams?.some(s => s.codec_type === "audio"),
  }
}

export function createPlayback(config: Config, db: Db, library: ReturnType<typeof createLibrary>) {
  const file = (id: string) => join(library.cacheDir(id), "play.mp4")
  // Videos that need no copy, or failed to get one, until the next restart.
  const skip = new Set<string>()
  let busy = false

  async function make(photo: Pick<Photo, "id" | "user_id" | "path" | "version">) {
    const source = await resolveExisting(join(config.library, photo.user_id), photo.path)
    const info = await probe(source)
    if (!info || (Math.max(info.width, info.height) <= LONG_SIDE && info.bitRate <= MAX_BITRATE)) return false
    const out = join(config.tmp, `${photo.id}-${newId()}.mp4`)
    const color = [
      ...(info.primaries ? ["-color_primaries", info.primaries] : []),
      ...(info.transfer ? ["-color_trc", info.transfer] : []),
      ...(info.space ? ["-colorspace", info.space] : []),
    ]
    try {
      // The rotation stays as metadata (-noautorotate), so the GPU never has to turn frames.
      await run([
        "ffmpeg", "-v", "error", "-y", "-noautorotate", "-protocol_whitelist", "file",
        "-hwaccel", "vaapi", "-hwaccel_device", config.vaapi!, "-hwaccel_output_format", "vaapi",
        "-i", source, "-map", "0:v:0", ...(info.audio ? ["-map", "0:a:0"] : []),
        "-vf", `scale_vaapi=w=${LONG_SIDE}:h=${LONG_SIDE}:force_original_aspect_ratio=decrease:format=p010`,
        "-c:v", "hevc_vaapi", "-low_power", "1", "-profile:v", "main10", "-b:v", "8M", "-maxrate", "10M", "-tag:v", "hvc1", ...color,
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ])
      // Deleted or changed meanwhile: keep nothing.
      const now = db.query("select version from photos where id = ? and user_id = ?").get(photo.id, photo.user_id) as { version: number } | null
      if (now?.version !== photo.version || !existsSync(library.cacheDir(photo.id))) return false
      await rename(out, file(photo.id))
      return true
    } finally {
      await rm(out, { force: true })
    }
  }

  // One video at a time, so previews and the server stay quick.
  async function pump() {
    if (busy || !config.vaapi || !existsSync(config.vaapi)) return
    busy = true
    try {
      const videos = db.query("select id, user_id, path, version from photos where kind = 'video' and status = 'ready' order by taken_at desc").all() as Pick<Photo, "id" | "user_id" | "path" | "version">[]
      for (const video of videos) {
        if (skip.has(`${video.id}:${video.version}`) || (await stat(file(video.id)).catch(() => null))) continue
        const started = performance.now()
        try {
          const made = await make(video)
          if (made) log("playback.made", { id: video.id.slice(0, 4), ms: Math.round(performance.now() - started) })
          else skip.add(`${video.id}:${video.version}`)
        } catch (error) {
          skip.add(`${video.id}:${video.version}`)
          log("playback.failed", { id: video.id.slice(0, 4), error: /^Error: (\S+ exited \d+)/.exec(String(error))?.[1] ?? "error" }, "WARN")
        }
      }
    } finally {
      busy = false
    }
  }

  // The copy if there is one; null means play the original.
  async function path(id: string) {
    return (await stat(file(id)).catch(() => null)) ? file(id) : null
  }

  return { pump, path }
}
