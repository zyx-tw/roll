// Upload: the original bytes, untouched, into library/<user>/uploads/<month>/.
// roll only ever adds files here; it never changes or deletes an original.
import { link, mkdir, unlink, utimes } from "node:fs/promises"
import { extname, join } from "node:path"
import type { Config } from "./config"
import type { User } from "./db"
import { HttpError, json } from "./http"
import { IMAGE, VIDEO, newId, type createLibrary } from "./library"
import { log } from "./otel"
import { resolveExisting } from "./paths"

const MAX_BYTES = 20 * 1024 ** 3

// The upload month in Taiwan time, e.g. "2026-10".
const month = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 7)

export function cleanName(input: string | null) {
  const name = (input ?? "").normalize("NFC").trim()
  if (!name || name.length > 200 || /[/\\\0]/.test(name) || name.startsWith(".")) throw new HttpError(400, "bad name")
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
    const root = join(config.library, user.id)
    // One level at a time, each checked before anything is made inside it, so
    // a link in the path never leads a write into another folder.
    let folder = root
    for (const rel of ["uploads", `uploads/${month(now)}`]) {
      await mkdir(join(root, rel)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      })
      folder = await resolveExisting(root, rel)
    }

    // Write to tmp first, so a scan never sees half a file.
    const part = join(config.tmp, `${newId()}.part`)
    try {
      const written = await Bun.write(part, new Response(counted))
      if (written === 0 || written !== length || (declared !== null && written !== Number(declared))) throw new HttpError(400, "short body")
      const modified = Number(url.searchParams.get("modified"))
      if (Number.isFinite(modified) && modified > 0 && modified <= now) await utimes(part, new Date(), new Date(modified))
      // link() refuses an existing name, so a name already there gets a suffix.
      const stem = name.slice(0, name.length - extname(name).length)
      const ext = extname(name)
      for (let i = 0; ; i++) {
        const final = i === 0 ? name : `${stem}_${i}${ext}`
        try {
          await link(part, join(folder, final))
          log("upload.done", { user: user.id, bytes: length, kind: VIDEO.has(ext.toLowerCase()) ? "video" : "image" })
          void library.scan()
          return json({ ok: true, name: final })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || i >= 999) throw error
        }
      }
    } finally {
      await unlink(part).catch(() => {})
    }
  }

  return { handle }
}
