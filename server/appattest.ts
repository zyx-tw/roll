// App Attest: proof from Apple that a request comes from the genuine roll app
// on a real device, so a code handed to the tw.zyx.roll scheme cannot buy a
// full session for an app that merely claims the scheme.
// https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
import { X509Certificate as NodeCert, createHash } from "node:crypto"
import { decodeAttestationObject } from "@simplewebauthn/server/helpers"

const PRODUCTION = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)])
const DEVELOPMENT = Buffer.from("appattestdevelop")

// Apple App Attestation Root CA, from apple.com/certificateauthority, valid to 2045-03-15.
// SHA-256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
export const APPLE_ROOT = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`

const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest()
}

// DER-encoded OID 1.2.840.113635.100.8.2, where Apple puts the nonce.
const NONCE_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02])

// One DER element at `at`: its tag, where its content starts and ends.
function tlv(der: Buffer, at: number) {
  if (at + 2 > der.length) throw new Error("short")
  const tag = der[at]
  let length = der[at + 1]
  let start = at + 2
  if (length & 0x80) {
    const bytes = length & 0x7f
    if (bytes < 1 || bytes > 3) throw new Error("bad length")
    length = 0
    for (let i = 0; i < bytes; i++) length = (length << 8) | der[start + i]
    start += bytes
  }
  if (start + length > der.length) throw new Error("bad length")
  return { tag, start, end: start + length }
}

// The children of the DER element whose content spans [start, end).
function children(der: Buffer, start: number, end: number) {
  const out: ReturnType<typeof tlv>[] = []
  for (let at = start; at < end; ) {
    const el = tlv(der, at)
    if (el.end > end) throw new Error("bad nesting")
    out.push(el)
    at = el.end
  }
  return out
}

// The nonce in the leaf, read from the signed TBSCertificate's extensions:
// Certificate { tbs { ..., [3] { Extensions { Extension { OID, [critical], OCTET STRING {
//   SEQUENCE { [1] { OCTET STRING } } } } } } } }. Never a search over raw bytes.
function certNonce(der: Buffer) {
  const cert = tlv(der, 0)
  if (cert.tag !== 0x30 || cert.end !== der.length) return null
  const [tbs] = children(der, cert.start, cert.end)
  if (tbs?.tag !== 0x30) return null
  const wrapper = children(der, tbs.start, tbs.end).find(el => el.tag === 0xa3)
  if (!wrapper) return null
  const [list] = children(der, wrapper.start, wrapper.end)
  if (list?.tag !== 0x30) return null
  const found = children(der, list.start, list.end).filter(ext => {
    const [oid] = children(der, ext.start, ext.end)
    return oid?.tag === 0x06 && der.subarray(oid.start - 2, oid.end).equals(NONCE_OID)
  })
  if (found.length !== 1) return null
  const parts = children(der, found[0].start, found[0].end)
  const value = parts.at(-1)
  if (!value || value.tag !== 0x04 || parts.length > 3) return null
  const [seq] = children(der, value.start, value.end)
  if (seq?.tag !== 0x30 || seq.end !== value.end) return null
  const [tagged] = children(der, seq.start, seq.end)
  if (tagged?.tag !== 0xa1 || tagged.end !== seq.end) return null
  const [octets] = children(der, tagged.start, tagged.end)
  if (octets?.tag !== 0x04 || octets.end !== tagged.end || octets.end - octets.start !== 32) return null
  return der.subarray(octets.start, octets.end)
}

export type AttestOptions = { appIds: string[]; allowDevelopment?: boolean; root?: string; now?: Date }

// True when the attestation for keyId binds clientDataHash and comes from one
// of appIds ("<team id>.<bundle id>"). Anything malformed is false.
export function verifyAttestation(attestation: Uint8Array, keyId: Uint8Array, clientDataHash: Uint8Array, options: AttestOptions) {
  try {
    const object = decodeAttestationObject(new Uint8Array(attestation))
    if ((object.get("fmt") as string) !== "apple-appattest") return false
    const statement = object.get("attStmt")
    const x5c = statement.get("x5c") as Uint8Array[] | undefined
    const authData = Buffer.from(object.get("authData") as Uint8Array)
    if (!x5c || x5c.length !== 2 || authData.length < 55) return false

    // 1. Two plain DER certificates, nothing more: what is verified is exactly
    //    what is read. The chain ends at Apple's App Attestation root through an
    //    intermediate CA that is not the root, the leaf is not a CA, and every
    //    certificate is current.
    const now = options.now ?? new Date()
    const root = new NodeCert(options.root ?? APPLE_ROOT)
    const ders = x5c.map(der => Buffer.from(der))
    const [leaf, middle] = ders.map(der => new NodeCert(der))
    if (!ders.every((der, i) => [leaf, middle][i].raw.equals(der))) return false
    if (leaf.ca || !middle.ca || middle.fingerprint256 === root.fingerprint256 || leaf.fingerprint256 === middle.fingerprint256) return false
    for (const cert of [leaf, middle, root]) {
      if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) return false
    }
    if (!middle.checkIssued(root) || !middle.verify(root.publicKey)) return false
    if (!leaf.checkIssued(middle) || !leaf.verify(middle.publicKey)) return false

    // 2. The leaf carries sha256(authData || clientDataHash) as its nonce.
    const nonce = certNonce(ders[0])
    if (!nonce || !nonce.equals(sha256(authData, clientDataHash))) return false

    // 3. The key id is the hash of the leaf's P-256 public key (the 65-byte uncompressed point).
    if (leaf.publicKey.asymmetricKeyType !== "ec" || leaf.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false
    const spki = leaf.publicKey.export({ type: "spki", format: "der" })
    if (spki.length !== 91 || spki[26] !== 0x04) return false
    const point = spki.subarray(26)
    if (!sha256(point).equals(Buffer.from(keyId))) return false

    // 4. authData: our app id, a fresh key (counter 0), the right environment, the same key id.
    const rpIdHash = authData.subarray(0, 32)
    if (!options.appIds.some(id => sha256(Buffer.from(id)).equals(rpIdHash))) return false
    if (authData.readUInt32BE(33) !== 0) return false
    const aaguid = authData.subarray(37, 53)
    if (!aaguid.equals(PRODUCTION) && !(options.allowDevelopment && aaguid.equals(DEVELOPMENT))) return false
    const idLength = authData.readUInt16BE(53)
    if (!authData.subarray(55, 55 + idLength).equals(Buffer.from(keyId))) return false
    return true
  } catch {
    return false
  }
}
