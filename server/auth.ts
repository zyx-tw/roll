import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
} from "@simplewebauthn/server"
import type { Config } from "./config"
import type { Credential, Db, User } from "./db"
import { HttpError, createLimiter, json, readJson } from "./http"
import { log } from "./otel"

const SESSION_COOKIE = "roll_session"
const FLOW_COOKIE = "roll_flow"
const SESSION_DAYS = 30
const INVITE_DAYS = 7
const FLOW_MS = 5 * 60_000
const MAX_FLOWS = 1000

type Flow = { challenge: string; kind: "register" | "login"; userId: string | null; expires: number }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

export function cookies(req: Request) {
  const out = new Map<string, string>()
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

// A user id names a library folder, so it is a short lowercase slug.
export const USER_ID = /^[a-z][a-z0-9-]{0,31}$/

// Creates the user when missing and returns a one-time link that registers a
// passkey for that user. Run from the server's command line, never over HTTP.
export function createInvite(config: Config, db: Db, userId: string, name: string) {
  if (!USER_ID.test(userId)) throw new Error("user id must be a lowercase slug")
  const now = Date.now()
  db.query("insert into users (id, name, created_at) values (?, ?, ?) on conflict(id) do nothing").run(userId, name || userId, now)
  const token = randomBytes(32).toString("base64url")
  db.query("insert into invites (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)").run(sha256(token), userId, now, now + INVITE_DAYS * 86_400_000)
  return `${config.origin}/?invite=${token}`
}

export function createAuth(config: Config, db: Db) {
  const secure = config.origin.startsWith("https:")
  const rpID = new URL(config.origin).hostname
  const flows = new Map<string, Flow>()
  const limiter = createLimiter(60)

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`

  // The signed-in user, or null.
  function session(req: Request): User | null {
    const token = cookies(req).get(SESSION_COOKIE)
    if (!token) return null
    const row = db
      .query("select users.* from sessions join users on users.id = sessions.user_id where sessions.token_hash = ? and sessions.expires_at > ?")
      .get(sha256(token), Date.now()) as User | null
    return row
  }

  function newSession(userId: string, headers: Headers) {
    const token = randomBytes(32).toString("base64url")
    const now = Date.now()
    db.query("delete from sessions where expires_at < ?").run(now)
    db.query("insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)").run(sha256(token), userId, now, now + SESSION_DAYS * 86_400_000)
    headers.append("set-cookie", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400))
    headers.append("set-cookie", cookie(FLOW_COOKIE, "", 0))
  }

  function startFlow(kind: Flow["kind"], challenge: string, userId: string | null, headers: Headers) {
    const now = Date.now()
    // Every flow lives FLOW_MS, so insertion order is expiry order: drop from the front.
    for (const [id, flow] of flows) {
      if (flow.expires >= now && flows.size < MAX_FLOWS) break
      flows.delete(id)
    }
    const id = randomBytes(24).toString("base64url")
    flows.set(id, { challenge, kind, userId, expires: now + FLOW_MS })
    headers.append("set-cookie", cookie(FLOW_COOKIE, id, FLOW_MS / 1000))
  }

  function takeFlow(req: Request, kind: Flow["kind"]) {
    const id = cookies(req).get(FLOW_COOKIE)
    const flow = id ? flows.get(id) : undefined
    if (id) flows.delete(id)
    if (!flow || flow.kind !== kind || flow.expires < Date.now()) throw new HttpError(400, "expired")
    return flow
  }

  // The invite behind a token, if it is unused and unexpired.
  function invite(token: unknown) {
    if (typeof token !== "string" || token.length > 128) return null
    const hash = sha256(token)
    const row = db.query("select token_hash, user_id from invites where token_hash = ? and used_at is null and expires_at > ?").get(hash, Date.now()) as
      | { token_hash: string; user_id: string }
      | null
    // The lookup is by hash; compare again in constant time for good measure.
    return row && timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash)) ? row : null
  }

  // Who a new passkey belongs to: the signed-in user, or the user an invite names.
  function registrant(req: Request, token: unknown) {
    const user = session(req)
    if (user) return { userId: user.id, invite: null }
    const found = invite(token)
    return found ? { userId: found.user_id, invite: found.token_hash } : null
  }

  async function handle(req: Request, path: string, ip: string): Promise<Response> {
    if (path === "/api/auth/me" && req.method === "GET") {
      const user = session(req)
      return json({ user: user && { id: user.id, name: user.name } })
    }
    if (req.method !== "POST") throw new HttpError(405)
    if (limiter.blocked(ip)) {
      log("auth.throttled", {}, "WARN")
      throw new HttpError(429)
    }
    limiter.miss(ip)

    if (path === "/api/auth/logout") {
      const token = cookies(req).get(SESSION_COOKIE)
      if (token) db.query("delete from sessions where token_hash = ?").run(sha256(token))
      return json({ ok: true }, { headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0) } })
    }

    if (path === "/api/auth/register/options") {
      const body = await readJson(req)
      const who = registrant(req, body.invite)
      if (!who) {
        log("auth.register_denied", {}, "WARN")
        throw new HttpError(403)
      }
      const user = db.query("select * from users where id = ?").get(who.userId) as User
      const existing = db.query("select id, transports from credentials where user_id = ?").all(who.userId) as Pick<Credential, "id" | "transports">[]
      const options = await generateRegistrationOptions({
        rpName: "roll",
        rpID,
        userName: user.id,
        userDisplayName: user.name,
        userID: new TextEncoder().encode(user.id),
        attestationType: "none",
        excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      })
      const headers = new Headers()
      startFlow("register", options.challenge, who.userId, headers)
      return json(options, { headers })
    }

    if (path === "/api/auth/register/verify") {
      const body = await readJson(req)
      const flow = takeFlow(req, "register")
      const who = registrant(req, body.invite)
      // The invite or session must still name the user the options were made for.
      if (!who || who.userId !== flow.userId) throw new HttpError(403)
      let verification
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as never,
          expectedChallenge: flow.challenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        })
      } catch {
        verification = { verified: false as const }
      }
      if (!verification.verified || !verification.registrationInfo) {
        log("auth.register_failed", {}, "WARN")
        throw new HttpError(400, "not verified")
      }
      const { credential } = verification.registrationInfo
      const now = Date.now()
      db.transaction(() => {
        // Spend the invite in the same step, so one link makes one passkey.
        if (who.invite && db.query("update invites set used_at = ? where token_hash = ? and used_at is null").run(now, who.invite).changes !== 1) throw new HttpError(403)
        db.query("insert into credentials (id, user_id, public_key, counter, transports, created_at) values (?, ?, ?, ?, ?, ?)").run(
          credential.id,
          who.userId,
          credential.publicKey,
          credential.counter,
          credential.transports ? JSON.stringify(credential.transports) : null,
          now,
        )
      })()
      log("auth.registered", { user: who.userId, via: who.invite ? "invite" : "session" })
      const headers = new Headers()
      newSession(who.userId, headers)
      return json({ ok: true }, { headers })
    }

    if (path === "/api/auth/login/options") {
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required" })
      const headers = new Headers()
      startFlow("login", options.challenge, null, headers)
      return json(options, { headers })
    }

    if (path === "/api/auth/login/verify") {
      const body = await readJson(req)
      const flow = takeFlow(req, "login")
      const response = body.response as { id?: unknown } | undefined
      const row = typeof response?.id === "string" ? (db.query("select * from credentials where id = ?").get(response.id) as Credential | null) : null
      if (!row) {
        log("auth.login_failed", { reason: "unknown_credential" }, "WARN")
        throw new HttpError(401)
      }
      let verification
      try {
        verification = await verifyAuthenticationResponse({
          response: body.response as never,
          expectedChallenge: flow.challenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: row.id,
            publicKey: new Uint8Array(row.public_key),
            counter: row.counter,
            transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransport[]) : undefined,
          },
        })
      } catch {
        verification = { verified: false as const }
      }
      if (!verification.verified) {
        log("auth.login_failed", { reason: "not_verified" }, "WARN")
        throw new HttpError(401)
      }
      db.query("update credentials set counter = ? where id = ?").run(verification.authenticationInfo.newCounter, row.id)
      log("auth.login", { user: row.user_id })
      const headers = new Headers()
      newSession(row.user_id, headers)
      return json({ ok: true }, { headers })
    }

    throw new HttpError(404)
  }

  return { handle, session }
}
