// App Attest checks, against a stand-in chain built here (Apple's root key is not ours).
import "reflect-metadata"
import { describe, expect, test } from "bun:test"
import { createHash, webcrypto } from "node:crypto"
import * as x509 from "@peculiar/x509"
import { isoCBOR } from "@simplewebauthn/server/helpers"
import { APPLE_ROOT, verifyAttestation } from "./appattest"

x509.cryptoProvider.set(webcrypto as unknown as Crypto)
const APP = "68PK3GTMDD.tw.zyx.roll"
const EC = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const
const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256")
  for (const p of parts) h.update(p)
  return h.digest()
}
const day = 86_400_000

async function chain() {
  const rootKeys = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"])
  const midKeys = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"])
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01", name: "CN=Test Root", keys: rootKeys, signingAlgorithm: EC,
    notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 365 * day),
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  })
  const mid = await x509.X509CertificateGenerator.create({
    serialNumber: "02", subject: "CN=Test Mid", issuer: root.subject, publicKey: midKeys.publicKey, signingKey: rootKeys.privateKey, signingAlgorithm: EC,
    notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 365 * day),
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  })
  return { root, mid, midKeys }
}

type Tweak = { appId?: string; counter?: number; aaguid?: Buffer; nonceFor?: Uint8Array; keyIdInAuth?: Buffer; fmt?: string }

async function attest(c: Awaited<ReturnType<typeof chain>>, clientDataHash: Uint8Array, tweak: Tweak = {}) {
  const leafKeys = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"])
  const point = Buffer.from(await webcrypto.subtle.exportKey("raw", leafKeys.publicKey))
  const keyId = sha256(point)
  const authData = Buffer.alloc(55 + 32)
  sha256(Buffer.from(tweak.appId ?? APP)).copy(authData, 0)
  authData[32] = 0x40
  authData.writeUInt32BE(tweak.counter ?? 0, 33)
  ;(tweak.aaguid ?? Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)])).copy(authData, 37)
  authData.writeUInt16BE(32, 53)
  ;(tweak.keyIdInAuth ?? keyId).copy(authData, 55)
  const nonce = sha256(authData, tweak.nonceFor ?? clientDataHash)
  const ext = new x509.Extension("1.2.840.113635.100.8.2", false, Buffer.concat([Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), nonce]))
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03", subject: "CN=leaf", issuer: c.mid.subject, publicKey: leafKeys.publicKey, signingKey: c.midKeys.privateKey, signingAlgorithm: EC,
    notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 30 * day), extensions: [ext],
  })
  const object = new Map<string, unknown>([
    ["fmt", tweak.fmt ?? "apple-appattest"],
    ["attStmt", new Map<string, unknown>([["x5c", [new Uint8Array(leaf.rawData), new Uint8Array(c.mid.rawData)]], ["receipt", new Uint8Array(4)]])],
    ["authData", new Uint8Array(authData)],
  ])
  return { attestation: isoCBOR.encode(object as never), keyId }
}

describe("App Attest", () => {
  const hash = sha256(Buffer.from("challenge.code"))
  test("a proof from the trusted chain for our app passes", async () => {
    const c = await chain()
    const { attestation, keyId } = await attest(c, hash)
    expect(verifyAttestation(attestation, keyId, hash, { appIds: [APP], root: c.root.toString("pem") })).toBe(true)
  })
  test("Apple's real root does not trust a made-up chain", async () => {
    const c = await chain()
    const { attestation, keyId } = await attest(c, hash)
    expect(APPLE_ROOT).toContain("BEGIN CERTIFICATE")
    expect(verifyAttestation(attestation, keyId, hash, { appIds: [APP] })).toBe(false)
  })
  test("every field that does not match is refused", async () => {
    const c = await chain()
    const root = c.root.toString("pem")
    const ok = { appIds: [APP], root }
    const cases: Tweak[] = [
      { appId: "68PK3GTMDD.tw.evil.app" },
      { counter: 1 },
      { aaguid: Buffer.from("appattestdevelop") },
      { nonceFor: sha256(Buffer.from("other")) },
      { keyIdInAuth: Buffer.alloc(32, 7) },
      { fmt: "packed" },
    ]
    for (const tweak of cases) {
      const { attestation, keyId } = await attest(c, hash, tweak)
      expect(verifyAttestation(attestation, keyId, hash, ok)).toBe(false)
    }
    // A proof for another code, another key, or garbage.
    const { attestation, keyId } = await attest(c, hash)
    expect(verifyAttestation(attestation, keyId, sha256(Buffer.from("challenge.other")), ok)).toBe(false)
    expect(verifyAttestation(attestation, Buffer.alloc(32, 1), hash, ok)).toBe(false)
    expect(verifyAttestation(new Uint8Array([1, 2, 3]), keyId, hash, ok)).toBe(false)
    // Expired by the time it is checked.
    expect(verifyAttestation(attestation, keyId, hash, { ...ok, now: new Date(Date.now() + 400 * day) })).toBe(false)
  })
  test("a root posing as the chain, or bytes after a certificate, are refused", async () => {
    const c = await chain()
    const root = c.root.toString("pem")
    const { attestation, keyId } = await attest(c, hash)
    const object = (await import("@simplewebauthn/server/helpers")).decodeAttestationObject(new Uint8Array(attestation))
    const authData = object.get("authData") as Uint8Array
    const forged = (x5c: Uint8Array[]) =>
      isoCBOR.encode(new Map<string, unknown>([["fmt", "apple-appattest"], ["attStmt", new Map<string, unknown>([["x5c", x5c], ["receipt", new Uint8Array(4)]])], ["authData", authData]]) as never)
    const rootDer = new Uint8Array(c.root.rawData)
    const nonce = sha256(Buffer.from(authData), hash)
    const tail = Buffer.concat([Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02, 0x04, 0x26, 0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), nonce])
    // The root PEM with a forged nonce after it, as leaf and as intermediate.
    const pemWithTail = new Uint8Array(Buffer.concat([Buffer.from(root), tail]))
    expect(verifyAttestation(forged([pemWithTail, new Uint8Array(Buffer.from(root))]), keyId, hash, { appIds: [APP], root })).toBe(false)
    // The root DER with trailing bytes, and the root as its own intermediate.
    expect(verifyAttestation(forged([new Uint8Array(Buffer.concat([rootDer, tail])), rootDer]), keyId, hash, { appIds: [APP], root })).toBe(false)
    expect(verifyAttestation(forged([new Uint8Array(c.mid.rawData), rootDer]), keyId, hash, { appIds: [APP], root })).toBe(false)
    // The intermediate as the leaf.
    expect(verifyAttestation(forged([new Uint8Array(c.mid.rawData), new Uint8Array(c.mid.rawData)]), keyId, hash, { appIds: [APP], root })).toBe(false)
  })
  test("development keys pass only when allowed", async () => {
    const c = await chain()
    const { attestation, keyId } = await attest(c, hash, { aaguid: Buffer.from("appattestdevelop") })
    expect(verifyAttestation(attestation, keyId, hash, { appIds: [APP], root: c.root.toString("pem"), allowDevelopment: true })).toBe(true)
  })
})
