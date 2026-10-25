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

export function uploadFile(file: File, onProgress: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}&modified=${file.lastModified}`)
    xhr.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded / event.total)
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, xhr.responseText)))
    xhr.onerror = () => reject(new ApiError(0, "network"))
    xhr.send(file)
  })
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
