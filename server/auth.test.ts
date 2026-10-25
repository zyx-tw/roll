// Attacks on the real passkey flow, with a software authenticator.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isoCBOR } from "@simplewebauthn/server/helpers"
import { createApp } from "./app"
import { createInvite } from "./auth"
import { loadConfig } from "./config"

const ROLL = "https://roll.test"
let dir: string
let app: ReturnType<typeof createApp>
let config: ReturnType<typeof loadConfig>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (res: Response | Promise<Response>): Promise<any> => (await res).json()
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url")
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest()

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  headers.set("host", "roll.test")
  if (init.cookie) headers.set("cookie", init.cookie)
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ROLL)
  return app.fetch(new Request(ROLL + path, { ...init, headers }), "1.1.1.1")
}
const post = (p: string, v: unknown, cookie?: string) => req(p, { method: "POST", body: JSON.stringify(v), cookie })
function cookieOf(res: Response) {
  return res.headers.getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("=")).join("; ")
}

function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string }
  const credId = randomBytes(16)
  let counter = 0
  return {
    credId,
    create(challenge: string) {
      const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])
      const coseBytes = Buffer.from(isoCBOR.encode(cose as never))
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length)
      const authData = Buffer.concat([sha("roll.test"), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, coseBytes])
      const att = Buffer.from(isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never))
      const cdj = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: ROLL }))
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(cdj), attestationObject: b64u(att), transports: ["internal"] }, clientExtensionResults: {} }
    },
    get(challenge: string) {
      counter++
      const c = Buffer.alloc(4); c.writeUInt32BE(counter)
      const authData = Buffer.concat([sha("roll.test"), Buffer.from([0x05]), c])
      const cdj = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ROLL }))
      const sig = sign("sha256", Buffer.concat([authData, sha(cdj)]), privateKey)
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(authData), signature: b64u(sig) }, clientExtensionResults: {} }
    },
  }
}

async function photo(path: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  await Bun.spawn(["vips", "black", path, "50", "40"]).exited
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "roll-auth-"))
  mkdirSync(join(dir, "dist/assets"), { recursive: true })
  writeFileSync(join(dir, "dist/index.html"), "x")
  config = loadConfig({ ROLL_DATA: join(dir, "data"), ROLL_DIST: join(dir, "dist"), ROLL_ORIGIN: ROLL })
  app = createApp(config)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const inviteOf = (u: string) => new URL(createInvite(config, app.db, u, u)).searchParams.get("invite")!

test("full invite registration, single use, login, cookie attrs", async () => {
  const invite = inviteOf("ann")
  const a = authenticator()
  const o1 = await post("/api/auth/register/options", { invite })
  const o2 = await post("/api/auth/register/options", { invite })
  const c1 = cookieOf(o1), c2 = cookieOf(o2)
  const ch1 = (await read(o1)).challenge, ch2 = (await read(o2)).challenge
  const v1 = await post("/api/auth/register/verify", { invite, response: a.create(ch1) }, c1)
  expect(v1.status).toBe(200)
  const sc = v1.headers.getSetCookie().find(c => c.startsWith("roll_session="))!
  expect(sc).toContain("HttpOnly"); expect(sc).toContain("SameSite=Strict"); expect(sc).toContain("Secure"); expect(sc.toLowerCase()).not.toContain("domain")
  // second flow with same invite, different authenticator -> must fail
  const b = authenticator()
  const v2 = await post("/api/auth/register/verify", { invite, response: b.create(ch2) }, c2)
  expect(v2.status).toBe(403)
  expect((app.db.query("select count(*) n from credentials where user_id='ann'").get() as { n: number }).n).toBe(1)
  // login
  const lo = await post("/api/auth/login/options", {})
  const lv = await post("/api/auth/login/verify", { response: a.get((await read(lo)).challenge) }, cookieOf(lo))
  expect(lv.status).toBe(200)
  // flow replay: reuse the same login flow cookie
  const lv2 = await post("/api/auth/login/verify", { response: a.get("x") }, cookieOf(lo))
  expect(lv2.status).toBe(400)
})

test("concurrent verify of the same invite only spends once", async () => {
  const invite = inviteOf("cat")
  const flows = await Promise.all([0, 1, 2, 3].map(() => post("/api/auth/register/options", { invite })))
  const data = await Promise.all(flows.map(async f => ({ c: cookieOf(f), ch: (await read(f)).challenge })))
  const res = await Promise.all(data.map(d => post("/api/auth/register/verify", { invite, response: authenticator().create(d.ch) }, d.c)))
  expect(res.filter(r => r.status === 200)).toHaveLength(1)
  expect((app.db.query("select count(*) n from credentials where user_id='cat'").get() as { n: number }).n).toBe(1)
})

test("options for one user cannot be verified for another", async () => {
  const inv = inviteOf("dan")
  const inv2 = inviteOf("eve")
  const o = await post("/api/auth/register/options", { invite: inv })
  const ch = (await read(o)).challenge
  // swap invite at verify
  expect((await post("/api/auth/register/verify", { invite: inv2, response: authenticator().create(ch) }, cookieOf(o))).status).toBe(403)
  // options via invite for dan, verify with ann session cookie added
  const o2 = await post("/api/auth/register/options", { invite: inv })
  const ch2 = (await read(o2)).challenge
  const lo = await post("/api/auth/login/options", {})
  void lo
  app.db.query("insert into sessions (token_hash,user_id,created_at,expires_at) values (?,?,?,?)").run(sha("s-ann").toString("hex"), "ann", 0, Date.now() + 60000)
  expect((await post("/api/auth/register/verify", { invite: inv, response: authenticator().create(ch2) }, cookieOf(o2) + "; roll_session=s-ann")).status).toBe(403)
  // register options as ann session with dan invite yields ann
  const o3 = await post("/api/auth/register/options", { invite: inv }, "roll_session=s-ann")
  expect((await read(o3)).user.name).toBe("ann")
  // dan invite still unspent
  expect((app.db.query("select used_at from invites where user_id='dan' and used_at is not null").all()).length).toBe(0)
})

test("existing credential id cannot be re-bound to another user", async () => {
  const a = authenticator()
  const inv = inviteOf("fay")
  const o = await post("/api/auth/register/options", { invite: inv })
  expect((await post("/api/auth/register/verify", { invite: inv, response: a.create((await read(o)).challenge) }, cookieOf(o))).status).toBe(200)
  const inv2 = inviteOf("gus")
  const o2 = await post("/api/auth/register/options", { invite: inv2 })
  const r = await post("/api/auth/register/verify", { invite: inv2, response: a.create((await read(o2)).challenge) }, cookieOf(o2))
  expect(r.status).toBe(409)
  expect((app.db.query("select user_id from credentials where id=?").get(b64u(a.credId)) as { user_id: string }).user_id).toBe("fay")
  // A refused passkey does not spend the invite.
  expect(app.db.query("select used_at from invites where user_id='gus'").get()).toEqual({ used_at: null })
})

test("library isolation: symlink dir, swapped file, live", async () => {
  const lib = config.library
  app.db.query("insert into sessions (token_hash,user_id,created_at,expires_at) values (?,?,?,?)").run(sha("s-fay").toString("hex"), "fay", 0, Date.now() + 60000)
  await photo(join(lib, "ann/secret/x.jpg"))
  await photo(join(lib, "fay/mine.jpg"))
  await photo(join(lib, "fay/swap.jpg"))
  symlinkSync(join(lib, "ann"), join(lib, "fay/linkdir"))
  symlinkSync("../ann/secret/x.jpg", join(lib, "fay/rel.jpg"))
  await app.library.scan(); await app.library.drained()
  const fay = (await read((await req("/api/photos", { cookie: "roll_session=s-fay" })))).items
  expect(fay).toHaveLength(2)
  // swap a scanned file for a symlink to ann's photo
  const row = app.db.query("select id from photos where user_id='fay' and path='swap.jpg'").get() as { id: string }
  rmSync(join(lib, "fay/swap.jpg"))
  symlinkSync(join(lib, "ann/secret/x.jpg"), join(lib, "fay/swap.jpg"))
  expect((await req(`/api/photos/${row.id}/original`, { cookie: "roll_session=s-fay" })).status).toBe(404)
  const ann = app.db.query("select id from photos where user_id='ann'").get() as { id: string }
  for (const p of ["", "/thumb", "/large", "/original", "/live"]) expect((await req(`/api/photos/${ann.id}${p}`, { cookie: "roll_session=s-fay" })).status).toBe(404)
  // limit/cursor injection
  expect((await req(`/api/photos?limit=-1&cursor=0_${ann.id}`, { cookie: "roll_session=s-fay" })).status).toBe(200)
})
