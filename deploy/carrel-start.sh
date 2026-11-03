#!/bin/sh
# carrel-deployd (from land) runs this from the release directory on every
# deploy and rollback, as the roll user, with /srv/apps/roll/env loaded. The
# release holds the built server and web app.
set -eu
export ROLL_DIST="$PWD/dist"
exec bun build/server.js
