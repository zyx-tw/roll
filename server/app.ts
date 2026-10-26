import { mkdirSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { createAuth } from "./auth"
import { createEmbed } from "./embed"
import type { Config } from "./config"
import { openDb } from "./db"
import { HttpError, json } from "./http"
import { createLibrary } from "./library"
import { log } from "./otel"
import { cleanRel, within } from "./paths"
import { createPhotos } from "./photos"
import { createPlayback } from "./playback"
import { loadPlaces } from "./places"
import { createSmart } from "./smart"
import { createUpload } from "./upload"

const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

export function createApp(config: Config) {
  for (const dir of [config.data, config.library, config.cache, config.tmp]) mkdirSync(dir, { recursive: true })
  const db = openDb(join(config.data, "roll.db"))
  const auth = createAuth(config, db)
  const places = loadPlaces(config.geonames)
  const library = createLibrary(config, db, places)
  const playback = createPlayback(config, db, library)
  const smart = createSmart(config, db, library, createEmbed(config))
  const photos = createPhotos(config, db, library, places, playback, smart)
  const upload = createUpload(config, library)
  const host = new URL(config.origin).host

  // The SPA and its hashed assets.
  async function serveStatic(pathname: string) {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      throw new HttpError(400, "bad path")
    }
    const rel = cleanRel(decoded)
    const asset = rel.startsWith("assets/") || /^[\w.-]+\.(ico|png|svg|webmanifest)$/.test(rel)
    const path = asset ? join(config.dist, rel) : join(config.dist, "index.html")
    if (!within(config.dist, path) || !(await lstat(path).then(s => s.isFile(), () => false))) throw new HttpError(404)
    const headers = new Headers({
      "content-security-policy": APP_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    })
    return new Response(Bun.file(path), { headers })
  }

  async function route(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url)
    if (req.headers.get("host") !== host) throw new HttpError(421)

    // Lets the iOS app use the same passkeys as the site.
    if (url.pathname === "/.well-known/apple-app-site-association") return json({ webcredentials: { apps: config.iosApps } })

    if (url.pathname.startsWith("/api/")) {
      // Cookies are SameSite=Strict; the Origin check covers older browsers and non-browser clients.
      if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== config.origin) throw new HttpError(403)
      if (url.pathname.startsWith("/api/auth/")) return auth.handle(req, url.pathname, ip)
      const user = auth.session(req)
      if (!user) throw new HttpError(401)
      const isUpload = url.pathname === "/api/upload" || url.pathname.startsWith("/api/upload/")
      if (user.scope === "upload" && !isUpload) throw new HttpError(403)
      if (url.pathname.startsWith("/api/photos")) return photos.handle(req, url, user)
      if (isUpload) return upload.handle(req, url, user)
      throw new HttpError(404)
    }
    return serveStatic(url.pathname)
  }

  async function fetch(req: Request, ip = "unknown"): Promise<Response> {
    const started = performance.now()
    let response: Response
    try {
      response = await route(req, ip)
    } catch (error) {
      if (error instanceof HttpError) {
        response = json({ error: error.message || String(error.status) }, { status: error.status })
      } else {
        log("http.error", { error: String(error), path: new URL(req.url).pathname.startsWith("/api/") ? new URL(req.url).pathname : "page" }, "ERROR")
        response = json({ error: "internal" }, { status: 500 })
      }
    }
    if (response.status >= 500) log("http.5xx", { status: response.status, ms: Math.round(performance.now() - started) }, "ERROR")
    return response
  }

  return { fetch, db, library, playback, smart }
}
