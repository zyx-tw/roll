# AGENTS.md

## Layout

- `server/`: the Bun server. `app.ts` routes, `auth.ts` does passkeys, sessions and invites, `library.ts` scans originals and makes previews, `photos.ts` the timeline and media API, `search.ts` date queries, `places.ts` GPS to towns, `smart.ts` search by meaning and text in photos (through `embed.ts`, the zyx1121/embed client), `faces.ts` faces and named people, `albums.ts` albums, `upload.ts` uploads, `paths.ts` path safety.
- `src/`: the React app (`roll.tsx`). The shell and `components/ui` come from the task-web starter and ui.zyx.tw; do not edit `components/ui`.
- `deploy/`: the systemd unit and the env file shape.

## Rules

- Every photo query takes the photo id and the signed-in user id together. Never look a photo up by id alone.
- roll adds files under `ROLL_LIBRARY` only through `upload.ts` (into `<user>/uploads/<month>/`), and removes one only by moving it into `<user>/.trash/<day>/` (`photos.ts` delete). It never overwrites, edits or unlinks an original that has no other name.
- An upload writes to `tmp` first and lands with `link()`, so a scan never sees half a file and an existing name is never overwritten.
- A path from the database reaches the disk only through `resolveExisting` under that user's folder.
- Invites are made from the command line, never over HTTP. One invite makes one passkey.
- The session cookie has no `Domain`. Never widen it.
- Log events with `log()` from `server/otel.ts`. Send counts and short ids, never file names, places or tokens.
- Search results by meaning come only from photos the search already limited to this user. The embed service gets previews and video frames, never originals or names, and roll logs only counts from it.
- Albums belong to one user: a photo joins an album only when the same user owns both, and deleting an album never touches a photo.
- Faces, people and face crops belong to one user: every query takes the user id, and the matcher never overrides a face the user decided.
- Install, test and build on the build host, not on a laptop. The host needs `exiftool`, `vips` with HEIF and `ffmpeg`.

## Verify

```sh
bun test server
bun run typecheck && bun run lint
npm run audit -- <url> [--cookie roll_session=<token>]
```
