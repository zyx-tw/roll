import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { ChevronLeft, ChevronRight, Download, LogOut, Play, Search, Trash2, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { TaskShell } from "@/components/task-shell"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ApiError, api, formatDuration, formatTaken, post, uploadFile, type Photo } from "@/lib/api"

type Me = { user: { id: string; name: string } | null }

export function RollApp() {
  const [me, setMe] = useState<Me | null>(null)
  const [query, setQuery] = useState("")
  const [focus, setFocus] = useState<string | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  const [reload, setReload] = useState(0)
  const picker = useRef<HTMLInputElement>(null)
  const pickedAt = useRef(0)
  const invite = new URLSearchParams(window.location.search).get("invite")
  // Opened by the iOS app to sign in: the PKCE challenge it will prove later.
  const appChallenge = new URLSearchParams(window.location.search).get("app")
  const forApp = !!appChallenge && /^[A-Za-z0-9_-]{43,128}$/.test(appChallenge)
  const signedIn = !!me?.user

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

  async function toApp() {
    try {
      const { code } = await post<{ code: string }>("/api/auth/app/code", { challenge: appChallenge })
      window.location.href = `tw.zyx.roll://login?code=${encodeURIComponent(code)}`
    } catch {
      toast.error("登入失敗")
    }
  }

  async function logout() {
    await post("/api/auth/logout", {}).catch(() => {})
    setMe({ user: null })
  }

  // "/" or Cmd+K opens search, as on gallery.
  useEffect(() => {
    if (!signedIn) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest("input, textarea, [contenteditable]:not([contenteditable=false])")) return
      if (event.key === "/" || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault()
        setSearching(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [signedIn])

  // The picker closed with nothing. A quick close is the user changing their
  // mind; a slow one is iOS giving up on a photo it was fetching from iCloud.
  const nothingPicked = useCallback(() => {
    if (Date.now() - pickedAt.current > 3000) toast.error("沒有收到檔案", { description: "iCloud 上的照片要等 iPhone 下載完再選" })
  }, [])

  useEffect(() => {
    const input = picker.current
    if (!input) return
    input.addEventListener("cancel", nothingPicked)
    return () => input.removeEventListener("cancel", nothingPicked)
  }, [signedIn, nothingPicked])

  async function send(files: File[]) {
    const media = files.filter(file => /^(image|video)\//.test(file.type) || /\.(heic|heif|dng|mov|mp4|m4v)$/i.test(file.name))
    if (media.length === 0) return
    // Leaving the page stops the upload; ask first.
    const stay = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", stay)
    try {
      await sendAll(media)
    } finally {
      window.removeEventListener("beforeunload", stay)
    }
  }

  async function sendAll(media: File[]) {
    const id = toast.loading(`上傳中 0/${media.length}`)
    let done = 0
    let failed = 0
    for (const file of media) {
      try {
        await uploadFile(file, (fraction, waiting) =>
          toast.loading(waiting ? `連線中斷，等待重試 ${done + 1}/${media.length}` : `上傳中 ${done + 1}/${media.length}，${Math.round(fraction * 100)}%`, { id }),
        )
        done++
      } catch {
        failed++
      }
    }
    if (done === 0) {
      toast.error(`${failed} 個上傳失敗`, { id })
      return
    }
    // Uploaded is not done: the server still makes the previews.
    let left = Infinity
    for (;;) {
      const pending = await api<{ files: number; scanning: boolean }>("/api/photos/pending").catch(() => ({ files: 0, scanning: false }))
      if (pending.files < left) setReload(n => n + 1)
      left = pending.files
      if (left === 0 && !pending.scanning) break
      toast.loading(left > 0 ? `處理中，剩 ${left} 個` : "處理中", { id })
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    setReload(n => n + 1)
    if (failed) toast.error(`已上傳 ${done} 個，${failed} 個失敗`, { id })
    else toast.success(`已上傳 ${done} 個`, { id })
  }

  // Files dropped anywhere on the page upload.
  useEffect(() => {
    if (!signedIn) return
    const over = (event: DragEvent) => event.dataTransfer?.types.includes("Files") && event.preventDefault()
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      void send(Array.from(event.dataTransfer.files))
    }
    window.addEventListener("dragover", over)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragover", over)
      window.removeEventListener("drop", drop)
    }
  }, [signedIn])

  // Each button keeps its 40px hit area; only the row is pulled to the corner.
  const actions = signedIn && !forApp ? (
    <div className="-my-3 -mr-3 flex items-center">
      <Button type="button" variant="ghost" size="icon" onClick={() => setSearching(true)} aria-label="搜尋" title="搜尋">
        <Search aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={() => {
          pickedAt.current = Date.now()
          picker.current?.click()
        }} aria-label="上傳" title="上傳">
        <Upload aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={logout} aria-label="登出" title="登出">
        <LogOut aria-hidden />
      </Button>
      <input
        ref={picker}
        type="file"
        accept="image/*,video/*,.heic,.heif,.dng"
        multiple
        hidden
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          if (files.length === 0) nothingPicked()
          void send(files)
          event.target.value = ""
        }}
      />
    </div>
  ) : null

  return (
    <TaskShell title="roll" lang="zh-TW" actions={actions} wide showTitle={false} bottomCorners={false}>
      {me && !me.user && (
        <section aria-label="登入" className={forApp ? "fixed inset-0 flex items-center justify-center" : "flex gap-3"}>
          {invite ? <Button onClick={register}>註冊</Button> : <Button onClick={login}>登入</Button>}
        </section>
      )}
      {me?.user && forApp && (
        <section aria-label="回到 roll" className="fixed inset-0 flex items-center justify-center">
          <Button onClick={toApp}>回到 roll</Button>
        </section>
      )}
      {me?.user && !forApp && (
        <>
          {query && (
            <div className="mb-6 flex items-center gap-2 text-body">
              <span>{query}</span>
              <Button type="button" variant="ghost" size="icon" onClick={() => setQuery("")} aria-label="清除搜尋" title="清除搜尋">
                <X aria-hidden />
              </Button>
            </div>
          )}
          <Timeline key={`${query}:${reload}`} query={query} focus={focus} onSignedOut={() => setMe({ user: null })} />
          <SearchDialog
            key={searching ? "open" : "closed"}
            open={searching}
            initial={query}
            onClose={() => setSearching(false)}
            onSubmit={(next, photoId) => {
              setQuery(next)
              setFocus(photoId)
            }}
          />
        </>
      )}
    </TaskShell>
  )
}

const media = (photo: Photo, part: "thumb" | "large" | "original" | "live" | "play") => `/api/photos/${photo.id}/${part}?v=${photo.v}`

// Columns by the width the grid has: 2 on a phone, up to 5 on a wide screen.
function columnsFor(width: number) {
  if (width < 520) return 2
  if (width < 800) return 3
  if (width < 1080) return 4
  return 5
}

const GAP = 8

function Timeline({ query, focus, onSignedOut }: { query: string; focus?: string; onSignedOut: () => void }) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [next, setNext] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [width, setWidth] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  // A photo picked in search opens once its page has loaded.
  const [focused, setFocused] = useState(false)
  if (focus && !focused && open === null) {
    const index = photos.findIndex(p => p.id === focus)
    if (index >= 0) {
      setFocused(true)
      setOpen(index)
    }
  }
  const sentinel = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (loading || next === null) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (query) params.set("q", query)
      if (next) params.set("cursor", next)
      const page = await api<{ items: Photo[]; next: string | null }>(`/api/photos?${params}`)
      setPhotos(list => [...list, ...page.items])
      setNext(page.next)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut()
      else toast.error("載入失敗")
    } finally {
      setLoading(false)
    }
  }, [loading, next, query, onSignedOut])

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
      {next === null && photos.length === 0 && <p className="text-body text-muted-foreground">{query ? "沒有符合的照片" : "沒有照片"}</p>}
      {open !== null && photos[open] && (
        <Viewer
          photos={photos}
          index={open}
          onDeleted={id => {
            const at = photos.findIndex(p => p.id === id)
            const rest = photos.filter(p => p.id !== id)
            setPhotos(rest)
            setOpen(rest.length === 0 ? null : Math.min(at, rest.length - 1))
          }}
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

function Viewer({ photos, index, onIndex, onClose, onDeleted }: { photos: Photo[]; index: number; onIndex: (index: number) => void; onClose: () => void; onDeleted: (id: string) => void }) {
  const photo = photos[index]
  // The Live Photo that plays, by id, so moving on stops it.
  const [liveId, setLiveId] = useState<string | null>(null)
  const playingLive = liveId === photo.id
  // The photo the delete dialog was opened for, so nothing else can be deleted.
  const [confirming, setConfirming] = useState<Photo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const touch = useRef<{ x: number; y: number } | null>(null)

  async function remove(target: Photo) {
    setDeleting(true)
    try {
      await api(`/api/photos/${target.id}`, { method: "DELETE" })
      setConfirming(null)
      onDeleted(target.id)
    } catch {
      toast.error("刪除失敗")
    } finally {
      setDeleting(false)
    }
  }
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
      if (confirming) return
      if (event.key === "Escape") onClose()
      else if (event.key === "ArrowLeft") go(-1)
      else if (event.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [go, onClose, confirming])

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
      onTouchStart={event => (touch.current = confirming ? null : { x: event.touches[0].clientX, y: event.touches[0].clientY })}
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
      {/* Same geometry as the page's top corners: 20px in, 24px line, buttons pulled by their padding. */}
      <header className="relative flex items-center justify-between gap-4 py-5 pr-48 pl-5">
        <p className="text-body tabular-nums">
          {formatTaken(photo.takenAt)}
          {photo.place && <span className="text-muted-foreground">，{photo.place}</span>}
        </p>
        <div className="absolute top-5 right-5 -my-3 -mr-3 flex items-center">
          <Button variant="ghost" size="icon" onClick={() => setConfirming(photo)} aria-label="刪除" title="刪除">
            <Trash2 aria-hidden />
          </Button>
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
          <video key={photo.id} src={media(photo, "play")} poster={media(photo, "large")} controls autoPlay playsInline className="max-h-full max-w-full" />
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
      <AlertDialog open={confirming !== null} onOpenChange={next => !next && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>刪除這{confirming?.kind === "video" ? "部影片" : "張照片"}？</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button variant="destructive" onClick={() => confirming && remove(confirming)} disabled={deleting}>刪除</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Results as you type, like gallery.winlab.tw. Enter shows them on the
// timeline; a picked photo opens there.
function SearchDialog({ open, initial, onClose, onSubmit }: { open: boolean; initial: string; onClose: () => void; onSubmit: (query: string, photoId?: string) => void }) {
  const [value, setValue] = useState(initial)
  const [results, setResults] = useState<Photo[] | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const text = value.trim()
    if (!open || !text) return
    const ticket = ++latest.current
    const timer = setTimeout(async () => {
      const page = await api<{ items: Photo[] }>(`/api/photos?limit=60&q=${encodeURIComponent(text)}`).catch(() => ({ items: [] }))
      // A slower answer to an older query never replaces a newer one.
      if (ticket === latest.current) setResults(page.items)
    }, 300)
    return () => clearTimeout(timer)
  }, [value, open])

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(value.trim())
    onClose()
  }

  const shown = value.trim() ? results : null
  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent size="wide" showCloseButton={false}>
        <DialogTitle className="sr-only">搜尋</DialogTitle>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
            <Input
              value={value}
              onChange={event => setValue(event.target.value)}
              autoFocus
              autoComplete="off"
              enterKeyHint="search"
              aria-label="搜尋照片"
              className="pl-9"
            />
          </div>
          {shown && shown.length === 0 && <p className="text-center text-body text-muted-foreground">找不到符合「{value.trim()}」的照片</p>}
          {shown && shown.length > 0 && (
            <ul className="grid max-h-120 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {shown.map(photo => (
                <li key={photo.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSubmit(value.trim(), photo.id)
                      onClose()
                    }}
                    className="block aspect-square w-full overflow-hidden rounded-control bg-muted outline-offset-2 focus-visible:outline-2"
                    aria-label={formatTaken(photo.takenAt)}
                  >
                    <img src={media(photo, "thumb")} alt="" loading="lazy" className="size-full object-cover" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
