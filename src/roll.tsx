import { useEffect, useState } from "react"
import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { toast } from "sonner"
import { TaskShell } from "@/components/task-shell"
import { Button } from "@/components/ui/button"
import { api, post } from "@/lib/api"

type Me = { user: { id: string; name: string } | null }

// The web is only where passkeys are made and used: an invite registers one,
// and the iOS app opens this page to sign in. Photos live in the app.
export function RollApp() {
  const [me, setMe] = useState<Me | null>(null)
  const invite = new URLSearchParams(window.location.search).get("invite")
  // Opened by the iOS app to sign in: the PKCE challenge it will prove later.
  const appChallenge = new URLSearchParams(window.location.search).get("app")
  const forApp = !!appChallenge && /^[A-Za-z0-9_-]{43,128}$/.test(appChallenge)

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

  return (
    <TaskShell title="roll" lang="zh-TW" wide showTitle={false} bottomCorners={false}>
      <section aria-label="roll" className="fixed inset-0 flex flex-col items-center justify-center gap-3">
        {me && !me.user && (invite ? <Button onClick={register}>註冊</Button> : <Button onClick={login}>登入</Button>)}
        {me?.user && forApp && <Button onClick={toApp}>回到 roll</Button>}
        {me?.user && !forApp && (
          <>
            <p className="text-body">請用 roll App</p>
            <Button variant="ghost" onClick={logout}>登出</Button>
          </>
        )}
      </section>
    </TaskShell>
  )
}
