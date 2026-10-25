// Upload: the original bytes, untouched, into library/<user>/uploads/<month>/.
// roll only ever adds files here; it never changes or deletes an original.
import { lstat, realpath, statfs, unlink, utimes } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import type { Config } from "./config"
import type { User } from "./db"
import { HttpError, json } from "./http"
import { IMAGE, VIDEO, newId, type createLibrary } from "./library"
import { log } from "./otel"
import { ensureDir, linkFree, userRoot, within } from "./paths"

const MAX_BYTES = 20 * 1024 ** 3

// The upload month in Taiwan time, e.g. "2026-10".
const month = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 7)

export function cleanName(input: string | null) {
  const name = (input ?? "").normalize("NFC").trim()
  // Filesystems count bytes, not characters: 200 leaves room for a "_n" suffix.
  // eslint-disable-next-line no-control-regex
  if (!name || Buffer.byteLength(name) > 200 || /[/\\\x00-\x1f\x7f]/.test(name) || name.startsWith(".")) throw new HttpError(400, "bad name")
  const ext = extname(name).toLowerCase()
  if (!IMAGE.has(ext) && !VIDEO.has(ext)) throw new HttpError(415, "not a photo or video")
  return name
}

export function createUpload(config: Config, library: ReturnType<typeof createLibrary>) {
  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (req.method !== "PUT") throw new HttpError(405)
    const name = cleanName(url.searchParams.get("name"))
    // HTTP/2 may leave content-length out, so count the bytes as they stream.
    const declared = req.headers.get("content-length")
    if (declared !== null && Number(declared) > MAX_BYTES) throw new HttpError(413)
    if (!req.body) throw new HttpError(400)
    let length = 0
    const counted = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          length += chunk.byteLength
          if (length > MAX_BYTES) controller.error(new HttpError(413))
          else controller.enqueue(chunk)
        },
      }),
    )

    const now = Date.now()
    const root = await userRoot(config.library, user.id)
    const realRoot = await realpath(root)
    const folder = await ensureDir(root, `uploads/${month(now)}`)
    const space = await statfs(config.tmp)
    if (space.bavail * space.bsize < (declared !== null ? Number(declared) : 0) + config.reserveBytes) {
      log("upload.no_space", { user: user.id }, "WARN")
      throw new HttpError(507)
    }

    // Write to tmp first, so a scan never sees half a file.
    const part = join(config.tmp, `${newId()}.part`)
    try {
      const written = await Bun.write(part, new Response(counted))
      if (written === 0 || written !== length || (declared !== null && written !== Number(declared))) throw new HttpError(400, "short body")
      const modified = Number(url.searchParams.get("modified"))
      if (Number.isFinite(modified) && modified > 0 && modified <= now) await utimes(part, new Date(), new Date(modified))
      // linkFree never overwrites: a name already there gets a suffix.
      const final = await linkFree(part, folder, name)
      const dest = join(folder, final)
      // Check again where it landed, in case a folder was swapped meanwhile.
      if (!within(realRoot, await realpath(dirname(dest)))) {
        // Remove only our own link: same inode as the .part file.
        const [mine, there] = await Promise.all([lstat(part), lstat(dest).catch(() => null)])
        if (there && there.ino === mine.ino && there.dev === mine.dev) await unlink(dest)
        throw new HttpError(404)
      }
      log("upload.done", { user: user.id, bytes: length, kind: VIDEO.has(extname(name).toLowerCase()) ? "video" : "image" })
      void library.scan()
      return json({ ok: true, name: final })
    } finally {
      await unlink(part).catch(() => {})
    }
  }

  return { handle }
}
