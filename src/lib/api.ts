export type Photo = {
  id: string
  kind: "image" | "video"
  takenAt: number
  width: number
  height: number
  duration: number | null
  live: boolean
  place: string | null
  v: number
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json")
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? String(res.status))
  return body as T
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) })

const CHUNK = 8 * 1024 ** 2
const MAX_TRIES = 12

const STALL_MS = 60_000

// Sends one chunk; progress counts bytes of this chunk only. A slow link is
// fine; a chunk that makes no progress for a minute is given up and retried.
function sendChunk(id: string, offset: number, blob: Blob, onBytes: (loaded: number) => void) {
  return new Promise<{ received: number; name?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let stall = setTimeout(() => xhr.abort(), STALL_MS)
    const done = () => clearTimeout(stall)
    xhr.open("PUT", `/api/upload/${id}?offset=${offset}`)
    xhr.upload.onprogress = event => {
      clearTimeout(stall)
      stall = setTimeout(() => xhr.abort(), STALL_MS)
      onBytes(event.loaded)
    }
    xhr.onload = () => {
      done()
      let body: { received?: number; name?: string; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Not JSON: a proxy page.
      }
      if (xhr.status < 300) resolve({ received: body.received ?? offset + blob.size, name: body.name })
      else reject(Object.assign(new ApiError(xhr.status, body.error ?? String(xhr.status)), { received: body.received }))
    }
    xhr.onerror = () => {
      done()
      reject(new ApiError(0, "network"))
    }
    xhr.onabort = () => reject(new ApiError(0, "stalled"))
    xhr.send(blob)
  })
}

// Waits until the page is on screen and the phone is online again.
function backOnline(ms: number) {
  return new Promise<void>(resolve => {
    const check = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        document.removeEventListener("visibilitychange", check)
        window.removeEventListener("online", check)
        clearTimeout(timer)
        resolve()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("visibilitychange", check)
      window.addEventListener("online", check)
      check()
    }, ms)
  })
}

// A transient failure: the network, a timeout, a chunk still being written, a restart or a busy server.
const retryable = (error: unknown) => error instanceof ApiError && [0, 408, 409, 429].includes(error.status) || (error instanceof ApiError && error.status >= 500)

// Uploads a file in chunks. A dropped connection or a phone that sleeps
// resumes from the last chunk the server has, not from the start.
export async function uploadFile(file: File, onProgress: (fraction: number, waiting: boolean) => void) {
  const begin = () => post<{ id: string }>("/api/upload", { name: file.name, size: file.size, modified: file.lastModified }).then(r => r.id)
  let id = await begin()
  let received = 0
  let tries = 0
  while (received < file.size) {
    try {
      const result = await sendChunk(id, received, file.slice(received, received + CHUNK), loaded => onProgress((received + loaded) / file.size, false))
      received = result.received
      tries = 0
    } catch (error) {
      const told = (error as { received?: number }).received
      // The server says where the file stands: carry on from there.
      if (error instanceof ApiError && error.status === 409 && typeof told === "number") {
        received = told
        continue
      }
      // The server lost the upload, after a restart: start this file again.
      if (error instanceof ApiError && error.status === 404) {
        if (++tries > MAX_TRIES) throw error
        id = await begin()
        received = 0
        continue
      }
      if (!retryable(error) || ++tries > MAX_TRIES) {
        void api(`/api/upload/${id}`, { method: "DELETE" }).catch(() => {})
        throw error
      }
      onProgress(received / file.size, true)
      await backOnline(Math.min(1000 * 2 ** tries, 30_000))
      // A finished upload reports received = size, which ends the loop.
      const state = await api<{ received: number }>(`/api/upload/${id}`).catch(() => null)
      if (state) received = state.received
    }
  }
}

const takenParts = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Taipei" })

// "2026 年 4 月 16 日 週四 09:28": numbers and words spaced apart.
export function formatTaken(ms: number) {
  const part = Object.fromEntries(takenParts.formatToParts(ms).map(p => [p.type, p.value]))
  return `${part.year} 年 ${part.month} 月 ${part.day} 日 ${part.weekday} ${part.hour}:${part.minute}`
}

export function formatDuration(seconds: number) {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
