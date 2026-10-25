export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message = "") {
    super(message)
    this.status = status
  }
}

export type HeaderMap = Record<string, string>

export function json(body: unknown, init: { status?: number; headers?: HeaderMap | Headers } = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), { ...init, headers })
}

const MAX_JSON = 64 * 1024

// Reads at most 64 KB, so an anonymous POST cannot fill memory.
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON) throw new HttpError(413)
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > MAX_JSON) throw new HttpError(413)
      chunks.push(chunk)
    }
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // Fall through to the 400 below.
  }
  throw new HttpError(400, "bad json")
}

// Types a browser may render in place. Everything else downloads, so a shared
// HTML or SVG file never runs as a page.
export function inlineSafe(type: string) {
  const mime = type.split(";")[0].trim().toLowerCase()
  if (mime === "image/svg+xml") return false
  return /^(image|video|audio)\//.test(mime) || mime === "application/pdf" || mime === "text/plain"
}

export function contentDisposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// One byte range from a Range header, or null for the whole file.
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === "" && match[2] === "")) return "invalid"
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (suffix === 0) return "invalid"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start) return "invalid"
  return { start, end }
}

export const PUBLIC_HEADERS = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" }

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

// A plain page with the browser's own look: no app, no scripts.
const BARE_STYLE = "body{font:16px/1.6 system-ui,sans-serif;margin:16px}ul{list-style:none;padding:0;margin:0}a{color:inherit}"

export function barePage(title: string, body: string, status = 200, style = BARE_STYLE) {
  const html = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`
  return new Response(html, {
    status,
    headers: {
      ...PUBLIC_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  })
}

export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"

export function fileResponse(req: Request, path: string, name: string, size: number, download: boolean, extra: HeaderMap = {}) {
  const file = Bun.file(path)
  const type = file.type || "application/octet-stream"
  const headers = new Headers(extra)
  headers.set("content-type", type)
  headers.set("accept-ranges", "bytes")
  const inline = !download && inlineSafe(type)
  headers.set("content-disposition", contentDisposition(inline ? "inline" : "attachment", name))
  // Only downloads get the sandbox. Inline types cannot run script, and Safari's
  // media viewer and Chrome's PDF viewer both break inside a sandboxed document.
  if (!inline) headers.set("content-security-policy", FILE_CSP)
  headers.set("x-content-type-options", "nosniff")
  headers.set("cache-control", "private, no-cache")
  const range = parseRange(req.headers.get("range"), size)
  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`)
    return { response: new Response(null, { status: 416, headers }), bytes: 0, partial: true }
  }
  if (req.method === "HEAD") {
    headers.set("content-length", String(size))
    return { response: new Response(null, { status: 200, headers }), bytes: 0, partial: false }
  }
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`)
    headers.set("content-length", String(range.end - range.start + 1))
    return { response: new Response(file.slice(range.start, range.end + 1), { status: 206, headers }), bytes: range.end - range.start + 1, partial: true }
  }
  headers.set("content-length", String(size))
  return { response: new Response(file, { status: 200, headers }), bytes: size, partial: false }
}


// IPv4 as is; IPv6 by its /64, since one host usually owns a whole /64.
export function limitKey(ip: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (!ip.includes(":")) return ip
  const [head, tail = ""] = ip.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left
  return `${groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`
}

// Hits per client. Too many in a window and that client gets 429.
export function createLimiter(limit = 20, windowMs = 10 * 60_000) {
  const hits = new Map<string, { count: number; reset: number }>()
  let swept = Date.now()
  return {
    blocked(ip: string) {
      const hit = hits.get(limitKey(ip))
      return !!hit && hit.reset > Date.now() && hit.count >= limit
    },
    miss(ip: string) {
      const now = Date.now()
      if (now - swept > 60_000) {
        swept = now
        for (const [key, hit] of hits) if (hit.reset <= now) hits.delete(key)
      }
      const key = limitKey(ip)
      const hit = hits.get(key)
      if (!hit || hit.reset <= now) hits.set(key, { count: 1, reset: now + windowMs })
      else hit.count++
    },
  }
}
