import { join, resolve } from "node:path"

export type Config = {
  port: number
  data: string
  library: string
  cache: string
  tmp: string
  dist: string
  origin: string
  scanMinutes: number
  workers: number
  reserveBytes: number
  geonames: string
  iosApps: string[]
  appAttestDevelopment: boolean
  vaapi: string | null
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const data = resolve(env.ROLL_DATA ?? "./data")
  return {
    port: Number(env.ROLL_PORT ?? 8080),
    data,
    // Originals, one folder per user: library/<user id>/... Roll only reads them.
    library: resolve(env.ROLL_LIBRARY ?? join(data, "library")),
    cache: join(data, "cache"),
    tmp: join(data, "tmp"),
    dist: resolve(env.ROLL_DIST ?? "./dist"),
    origin: (env.ROLL_ORIGIN ?? "http://localhost:8080").replace(/\/$/, ""),
    scanMinutes: Number(env.ROLL_SCAN_MINUTES ?? 15),
    workers: Number(env.ROLL_WORKERS ?? 2),
    // Disk space an upload must leave free, for the database, previews and the other user.
    // GeoNames cities1000.txt; without it, no place names.
    geonames: resolve(env.ROLL_GEONAMES ?? join(data, "geo/cities1000.txt")),
    reserveBytes: Number(env.ROLL_RESERVE_GB ?? 10) * 1024 ** 3,
    // <team id>.<bundle id> of the iOS apps that may sign in with roll's passkeys.
    iosApps: (env.ROLL_IOS_APPS ?? "68PK3GTMDD.tw.zyx.roll").split(",").filter(Boolean),
    // Accept App Attest keys from Xcode debug builds too (TestFlight and the App Store use production).
    appAttestDevelopment: env.ROLL_APPATTEST_DEVELOPMENT === "1",
    // The GPU for playback copies; "" turns them off.
    vaapi: env.ROLL_VAAPI === "" ? null : (env.ROLL_VAAPI ?? "/dev/dri/renderD128"),
  }
}
