import { createApp } from "./app"
import { createInvite } from "./auth"
import { loadConfig } from "./config"
import { openDb } from "./db"
import { flush, log } from "./otel"
import { join } from "node:path"

const config = loadConfig()

// `invite <user id> [name]` prints a one-time passkey link for that user.
if (process.argv[2] === "invite") {
  const [userId, ...name] = process.argv.slice(3)
  if (!userId) {
    console.error("usage: invite <user id> [display name]")
    process.exit(2)
  }
  console.log(createInvite(config, openDb(join(config.data, "roll.db")), userId, name.join(" ")))
  process.exit(0)
}

const app = createApp(config)

// Caddy sets X-Forwarded-For to the real client; the last entry is the one it added.
function clientIp(req: Request, peer: string) {
  const forwarded = req.headers.get("x-forwarded-for")
  return forwarded ? forwarded.split(",").pop()!.trim() : peer
}

const server = Bun.serve({
  port: config.port,
  hostname: process.env.ROLL_HOSTNAME ?? "0.0.0.0",
  idleTimeout: 255,
  fetch(req, srv) {
    return app.fetch(req, clientIp(req, srv.requestIP(req)?.address ?? "unknown"))
  },
})

log("server.start", { port: server.port })

// Scan at start, then on a timer. Files arrive by rsync, outside the app.
const scan = () => app.library.scan().catch(error => log("library.scan_failed", { error: String(error) }, "ERROR"))
void scan()
setInterval(scan, config.scanMinutes * 60_000)

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.stop()
    await flush()
    process.exit(0)
  })
}
