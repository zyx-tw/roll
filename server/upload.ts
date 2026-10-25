// Upload: the original bytes, untouched, into library/<user>/uploads/<month>/.
// roll only ever adds files here; it never changes or deletes an original.
//
// A file arrives in chunks, so a phone that drops the connection or sleeps
// picks up where it stopped instead of sending the whole video again:
//   POST   /api/upload          {name, size, modified}  -> {id, received}
//   PUT    /api/upload/<id>?offset=<n>  one chunk       -> {received} or {received, name}
//   GET    /api/upload/<id>                             -> {received}
//   DELETE /api/upload/<id>                             -> {ok}
// Uploads in progress live in memory; a restart drops them and the client starts over.
import { appendFile, lstat, realpath, statfs, truncate, unlink, utimes, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import type { Config } from "./config"
import type { User } from "./db"
import { HttpError, json, readJson } from "./http"
import { IMAGE, VIDEO, newId, type createLibrary } from "./library"
import { log } from "./otel"
import { ensureDir, linkFree, userRoot, within } from "./paths"

const MAX_BYTES = 20 * 1024 ** 3
export const MAX_CHUNK = 16 * 1024 ** 2
const MAX_OPEN = 8
const IDLE_MS = 24 * 3_600_000

// The upload month in Taiwan time, e.g. "2026-10".
const month = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 7)

export function cleanName(input: unknown) {
  const name = (typeof input === "string" ? input : "").normalize("NFC").trim()
  // Filesystems count bytes, not characters: 200 leaves room for a "_n" suffix.
  // eslint-disable-next-line no-control-regex
  if (!name || Buffer.byteLength(name) > 200 || /[/\\\x00-\x1f\x7f]/.test(name) || name.startsWith(".")) throw new HttpError(400, "bad name")
  const ext = extname(name).toLowerCase()
  if (!IMAGE.has(ext) && !VIDEO.has(ext)) throw new HttpError(415, "not a photo or video")
  return name
}

type Pending = { id: string; userId: string; name: string; size: number; modified: number; part: string; received: number; busy: boolean; touched: number }

export function createUpload(config: Config, library: ReturnType<typeof createLibrary>) {
  const pending = new Map<string, Pending>()

  async function drop(entry: Pending) {
    pending.delete(entry.id)
    await unlink(entry.part).catch(() => {})
  }

  // Uploads nobody touched for a day are given up.
  async function sweep(now: number) {
    for (const entry of pending.values()) if (!entry.busy && now - entry.touched > IDLE_MS) await drop(entry)
  }

  async function start(req: Request, user: User) {
    const input = await readJson(req)
    const name = cleanName(input.name)
    const size = input.size
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw new HttpError(400, "bad size")
    if (size > MAX_BYTES) throw new HttpError(413)
    const now = Date.now()
    await sweep(now)
    // A link in place of the user folder is refused before anything is written.
    await userRoot(config.library, user.id)
    const mine = [...pending.values()].filter(entry => entry.userId === user.id)
    if (mine.length >= MAX_OPEN) throw new HttpError(429, "too many uploads")
    // Room for this file and every other upload still on its way.
    const owed = [...pending.values()].reduce((sum, entry) => sum + entry.size - entry.received, 0)
    const space = await statfs(config.tmp)
    if (space.bavail * space.bsize < size + owed + config.reserveBytes) {
      log("upload.no_space", { user: user.id }, "WARN")
      throw new HttpError(507)
    }
    const modified = Number(input.modified)
    const id = newId()
    // Written in tmp first, so a scan never sees half a file.
    const part = join(config.tmp, `${id}.part`)
    await writeFile(part, new Uint8Array(0), { flag: "wx" })
    pending.set(id, { id, userId: user.id, name, size, modified: Number.isFinite(modified) && modified > 0 && modified <= now ? modified : 0, part, received: 0, busy: false, touched: now })
    return json({ id, received: 0 })
  }

  // Reads one chunk whole; a body cut off midway adds nothing.
  async function readChunk(req: Request, room: number) {
    const declared = req.headers.get("content-length")
    if (declared !== null && Number(declared) > Math.min(MAX_CHUNK, room)) throw new HttpError(413)
    if (!req.body) throw new HttpError(400, "empty chunk")
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of req.body) {
      length += chunk.byteLength
      if (length > MAX_CHUNK || length > room) throw new HttpError(413)
      chunks.push(chunk)
    }
    if (length === 0 || (declared !== null && length !== Number(declared))) throw new HttpError(400, "short chunk")
    return Buffer.concat(chunks, length)
  }

  async function finish(entry: Pending, user: User) {
    const root = await userRoot(config.library, user.id)
    const realRoot = await realpath(root)
    const folder = await ensureDir(root, `uploads/${month(Date.now())}`)
    if (entry.modified) await utimes(entry.part, new Date(), new Date(entry.modified))
    // linkFree never overwrites: a name already there gets a suffix.
    const final = await linkFree(entry.part, folder, entry.name)
    const dest = join(folder, final)
    // Check again where it landed, in case a folder was swapped meanwhile.
    if (!within(realRoot, await realpath(dirname(dest)))) {
      // Remove only our own link: same inode as the .part file.
      const [mine, there] = await Promise.all([lstat(entry.part), lstat(dest).catch(() => null)])
      if (there && there.ino === mine.ino && there.dev === mine.dev) await unlink(dest)
      throw new HttpError(404)
    }
    log("upload.done", { user: user.id, bytes: entry.size, kind: VIDEO.has(extname(entry.name).toLowerCase()) ? "video" : "image" })
    void library.scan()
    return final
  }

  async function chunk(req: Request, url: URL, user: User, entry: Pending) {
    if (entry.busy) throw new HttpError(409, "busy")
    const offset = Number(url.searchParams.get("offset"))
    // The client and server disagree on where the file stands: tell it.
    if (offset !== entry.received) return json({ error: "offset", received: entry.received }, { status: 409 })
    entry.busy = true
    try {
      const bytes = await readChunk(req, entry.size - entry.received)
      try {
        await appendFile(entry.part, bytes)
      } catch (error) {
        // Never leave a half-written chunk behind the count.
        await truncate(entry.part, entry.received).catch(() => {})
        throw error
      }
      entry.received += bytes.byteLength
      entry.touched = Date.now()
      if (entry.received < entry.size) return json({ received: entry.received })
      try {
        const name = await finish(entry, user)
        return json({ received: entry.received, name })
      } finally {
        await drop(entry)
      }
    } finally {
      entry.busy = false
    }
  }

  async function handle(req: Request, url: URL, user: User): Promise<Response> {
    if (url.pathname === "/api/upload") {
      if (req.method !== "POST") throw new HttpError(405)
      return start(req, user)
    }
    const id = url.pathname.slice("/api/upload/".length)
    const entry = pending.get(id)
    // Someone else's upload looks the same as none at all.
    if (!entry || entry.userId !== user.id) throw new HttpError(404)
    if (req.method === "GET") return json({ received: entry.received })
    if (req.method === "PUT") return chunk(req, url, user, entry)
    if (req.method === "DELETE") {
      if (!entry.busy) await drop(entry)
      return json({ ok: true })
    }
    throw new HttpError(405)
  }

  return { handle }
}
