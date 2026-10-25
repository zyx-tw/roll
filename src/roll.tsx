import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { ChevronLeft, ChevronRight, Download, LogOut, Play, X } from "lucide-react"
import { toast } from "sonner"
import { TaskShell } from "@/components/task-shell"
import { TaskThemeToggle } from "@/components/task-theme"
import { Button } from "@/components/ui/button"
import { ApiError, api, formatDuration, formatTaken, post, type Photo } from "@/lib/api"

type Me = { user: { id: string; name: string } | null }

export function RollApp() {
  const [me, setMe] = useState<Me | null>(null)
  const invite = new URLSearchParams(window.location.search).get("invite")

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe, () => setMe({ user: null }))
  }, [])

  const refresh = () => api<Me>("/api/auth/me").then(setMe)

  async function login() {
    try {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/login/options", {})
      const response = await startAuthentication({ optionsJSON })
      await post("/api/auth/login/verify", { response })
      await refresh()
    } catch {
      toast.error("登入失敗")
    }
  }

  async function register() {
    try {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", { invite })
      const response = await startRegistration({ optionsJSON })
      await post("/api/auth/register/verify", { invite, response })
      window.history.replaceState(null, "", "/")
      await refresh()
    } catch {
      toast.error("註冊失敗")
    }
  }

  async function logout() {
    await post("/api/auth/logout", {}).catch(() => {})
    setMe({ user: null })
  }

  const actions = (
    <>
      <TaskThemeToggle lang="zh-TW" />
      {me?.user && (
        <Button type="button" variant="ghost" size="icon" className="-m-3" onClick={logout} aria-label="登出" title="登出">
          <LogOut aria-hidden />
        </Button>
      )}
    </>
  )

  return (
    <TaskShell title="roll" lang="zh-TW" actions={actions} wide>
      {me && !me.user && (
        <section aria-label="登入" className="flex gap-3">
          {invite ? <Button onClick={register}>註冊</Button> : <Button onClick={login}>登入</Button>}
        </section>
      )}
      {me?.user && <Timeline onSignedOut={() => setMe({ user: null })} />}
    </TaskShell>
  )
}

const media = (photo: Photo, part: "thumb" | "large" | "original" | "live") => `/api/photos/${photo.id}/${part}?v=${photo.v}`

// Columns by the width the grid has: 2 on a phone, up to 5 on a wide screen.
function columnsFor(width: number) {
  if (width < 520) return 2
  if (width < 800) return 3
  if (width < 1080) return 4
  return 5
}

const GAP = 8

function Timeline({ onSignedOut }: { onSignedOut: () => void }) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [next, setNext] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [width, setWidth] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (loading || next === null) return
    setLoading(true)
    try {
      const page = await api<{ items: Photo[]; next: string | null }>(`/api/photos${next ? `?cursor=${encodeURIComponent(next)}` : ""}`)
      setPhotos(list => [...list, ...page.items])
      setNext(page.next)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut()
      else toast.error("載入失敗")
    } finally {
      setLoading(false)
    }
  }, [loading, next, onSignedOut])

  useLayoutEffect(() => {
    const el = grid.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Load the next page well before the bottom comes into view.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && void load(), { rootMargin: "1600px 0px" })
    observer.observe(el)
    return () => observer.disconnect()
  }, [load])

  // Each photo goes into the shortest column, in time order, so a new page
  // only adds to the bottom and nothing above it moves.
  const layout = useMemo(() => {
    const count = columnsFor(width)
    const colWidth = width > 0 ? (width - GAP * (count - 1)) / count : 0
    const heights = new Array<number>(count).fill(0)
    const placed = photos.map((photo, index) => {
      const col = heights.indexOf(Math.min(...heights))
      const height = photo.width > 0 ? (colWidth * photo.height) / photo.width : colWidth
      const top = heights[col]
      heights[col] += height + GAP
      return { photo, index, left: col * (colWidth + GAP), top, width: colWidth, height }
    })
    return { placed, height: Math.max(0, ...heights) - GAP }
  }, [photos, width])

  return (
    <section aria-label="照片">
      <div ref={grid} className="relative w-full" style={{ height: Math.max(0, layout.height) }}>
        {layout.placed.map(({ photo, index, left, top, width: w, height: h }) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setOpen(index)}
            className="absolute overflow-hidden rounded-control bg-muted outline-offset-2 focus-visible:outline-2"
            style={{ left, top, width: w, height: h }}
            aria-label={formatTaken(photo.takenAt)}
          >
            <img src={media(photo, "thumb")} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            {photo.kind === "video" && (
              <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded-control bg-background/80 px-1.5 text-caption tabular-nums">
                <Play aria-hidden className="size-3" />
                {photo.duration !== null && formatDuration(photo.duration)}
              </span>
            )}
          </button>
        ))}
      </div>
      <div ref={sentinel} aria-hidden className="h-px" />
      {next === null && photos.length === 0 && <p className="text-body text-muted-foreground">沒有照片</p>}
      {open !== null && photos[open] && (
        <Viewer
          photos={photos}
          index={open}
          onIndex={index => {
            setOpen(index)
            if (index >= photos.length - 10) void load()
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  )
}

function Viewer({ photos, index, onIndex, onClose }: { photos: Photo[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const photo = photos[index]
  // The Live Photo that plays, by id, so moving on stops it.
  const [liveId, setLiveId] = useState<string | null>(null)
  const playingLive = liveId === photo.id
  const touch = useRef<{ x: number; y: number } | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  const go = useCallback(
    (step: number) => {
      const target = index + step
      if (target >= 0 && target < photos.length) onIndex(target)
    },
    [index, photos.length, onIndex],
  )

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      else if (event.key === "ArrowLeft") go(-1)
      else if (event.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [go, onClose])

  // Warm the neighbours, so the next swipe shows at once.
  useEffect(() => {
    for (const near of [photos[index - 1], photos[index + 1]]) if (near && near.kind === "image") new Image().src = media(near, "large")
  }, [index, photos])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={formatTaken(photo.takenAt)}
      className="fixed inset-0 z-70 flex flex-col bg-background"
      onTouchStart={event => (touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY })}
      onTouchEnd={event => {
        const start = touch.current
        touch.current = null
        if (!start) return
        const dx = event.changedTouches[0].clientX - start.x
        const dy = event.changedTouches[0].clientY - start.y
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
        else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) onClose()
      }}
    >
      <header className="flex items-center justify-between gap-4 px-5 py-4">
        <p className="text-body tabular-nums">{formatTaken(photo.takenAt)}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" render={<a href={`${media(photo, "original")}&dl=1`} />} aria-label="下載" title="下載">
            <Download aria-hidden />
          </Button>
          <Button ref={closeButton} variant="ghost" size="icon" onClick={onClose} aria-label="關閉" title="關閉">
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-16">
        {photo.kind === "video" ? (
          <video key={photo.id} src={media(photo, "original")} poster={media(photo, "large")} controls autoPlay playsInline className="max-h-full max-w-full" />
        ) : (
          <div
            className="relative flex max-h-full max-w-full items-center justify-center"
            onPointerEnter={() => photo.live && setLiveId(photo.id)}
            onPointerLeave={() => setLiveId(null)}
          >
            <img key={photo.id} src={media(photo, "large")} alt="" className="max-h-[calc(100svh-6rem)] max-w-full object-contain" />
            {photo.live && playingLive && (
              <video src={media(photo, "live")} autoPlay muted playsInline onEnded={() => setLiveId(null)} className="absolute inset-0 size-full object-contain" />
            )}
          </div>
        )}
        {index > 0 && (
          <Button variant="ghost" size="icon" onClick={() => go(-1)} aria-label="上一張" className="absolute top-1/2 left-3 hidden -translate-y-1/2 sm:inline-flex">
            <ChevronLeft aria-hidden />
          </Button>
        )}
        {index < photos.length - 1 && (
          <Button variant="ghost" size="icon" onClick={() => go(1)} aria-label="下一張" className="absolute top-1/2 right-3 hidden -translate-y-1/2 sm:inline-flex">
            <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}
