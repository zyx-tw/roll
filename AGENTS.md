# AGENTS.md

## Layout

- `server/`: the Bun server. `app.ts` routes, `auth.ts` does passkeys, sessions and invites, `library.ts` scans originals and makes previews, `photos.ts` the timeline and media API, `paths.ts` path safety.
- `src/`: the React app (`roll.tsx`). The shell and `components/ui` come from the task-web starter and ui.zyx.tw; do not edit `components/ui`.
- `deploy/`: the systemd unit and the env file shape.

## Rules

- Every photo query takes the photo id and the signed-in user id together. Never look a photo up by id alone.
- Originals are read only. roll never writes, moves or deletes under `ROLL_LIBRARY`.
- A path from the database reaches the disk only through `resolveExisting` under that user's folder.
- Invites are made from the command line, never over HTTP. One invite makes one passkey.
- The session cookie has no `Domain`. Never widen it.
- Log events with `log()` from `server/otel.ts`. Send counts and short ids, never file names, places or tokens.
- Install, test and build on the build host, not on a laptop. The host needs `exiftool`, `vips` with HEIF and `ffmpeg`.

## Verify

```sh
bun test server
bun run typecheck && bun run lint
npm run audit -- <url> [--cookie roll_session=<token>]
```
