#!/usr/bin/env bash
# The release bundle as deployed: copy /release out of the image and run it
# with the same Bun the CT has (vips, ffmpeg and exiftool are not needed to start). ci runs it with the image loaded as
# ghcr.io/zyx-tw/roll:ci.
set -euo pipefail
image=${1:-ghcr.io/zyx-tw/roll:ci}
dir=$(mktemp -d)
cid=$(docker create "$image" /none)
docker cp "$cid:/release/." "$dir/"
docker rm "$cid" >/dev/null
trap 'docker logs roll || true' EXIT

docker run -d --name roll -p 127.0.0.1:8080:8080 -v "$dir:/app:ro" -w /app \
  -e ROLL_DATA=/tmp/roll -e ROLL_DIST=/app/dist -e ROLL_PORT=8080 \
  -e ROLL_ORIGIN=http://localhost:8080 \
  oven/bun:1.4.2 bun build/server.js >/dev/null
for i in $(seq 1 30); do curl -s -o /dev/null localhost:8080/ && break; sleep 0.5; done

code() { curl -s -o /dev/null -w "%{http_code}" "localhost:8080$1"; }
test "$(code /)" = 200
test "$(code /api/photos)" = 401
trap - EXIT
docker rm -f roll >/dev/null
echo "smoke passed"
