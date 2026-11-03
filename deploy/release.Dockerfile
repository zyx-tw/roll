# The release bundle: the built server and web app under /release, nothing
# else. The roll CT has no Docker; ship copies /release into the land release
# and deploy/carrel-start.sh runs it in place.
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bun build server/index.ts --target bun --outfile build/server.js

FROM scratch
COPY --from=build /app/build /release/build
COPY --from=build /app/dist /release/dist
