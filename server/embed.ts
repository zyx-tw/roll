// The embed service (zyx1121/embed): EmbeddingGemma 2 vectors for photos and
// queries, and the text in a photo. It keeps nothing; roll stores the results.
import type { Config } from "./config"

export type Line = { text: string; score: number }

export class EmbedDown extends Error {}

// Query vectors repeat while someone types; keep the latest few.
const QUERY_CACHE = 200

export function createEmbed(config: Config) {
  const cache = new Map<string, Float32Array>()

  async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${config.embedUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.embedToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new EmbedDown(String(error).slice(0, 100))
    }
    // A 5xx or a refused token means the service, not this input, is the problem.
    if (res.status >= 500 || res.status === 401) throw new EmbedDown(`embed ${res.status}`)
    if (!res.ok) throw new Error(`embed ${res.status}`)
    return (await res.json()) as T
  }

  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

  return {
    enabled: config.embedUrl !== null,

    async images(images: Uint8Array[]) {
      const out = await call<{ vectors: number[][] }>("/embed", { kind: "document", items: images.map(image => ({ image_b64: b64(image) })) }, 120_000 * images.length)
      return out.vectors.map(v => Float32Array.from(v))
    },

    async query(text: string) {
      const key = text.normalize("NFKC").trim()
      const hit = cache.get(key)
      if (hit) {
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }
      const out = await call<{ vectors: number[][] }>("/embed", { kind: "query", items: [{ text: key }] }, 10_000)
      const vector = Float32Array.from(out.vectors[0])
      cache.set(key, vector)
      if (cache.size > QUERY_CACHE) cache.delete(cache.keys().next().value!)
      return vector
    },

    async ocr(image: Uint8Array) {
      const out = await call<{ text: string; lines: Line[] }>("/ocr", { image_b64: b64(image) }, 120_000)
      return out.lines
    },
  }
}

export type Embed = ReturnType<typeof createEmbed>
