export type Photo = {
  id: string
  kind: "image" | "video"
  takenAt: number
  width: number
  height: number
  duration: number | null
  live: boolean
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

const takenFormat = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei" })

export const formatTaken = (ms: number) => takenFormat.format(ms)

export function formatDuration(seconds: number) {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
