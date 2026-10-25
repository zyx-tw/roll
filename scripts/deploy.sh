#!/usr/bin/env bash
# Test and build on the sandbox, then ship build/ and dist/ to the roll CT and restart.
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude build --exclude data ./ sandbox:work/roll/
ssh sandbox 'set -o pipefail; cd ~/work/roll && export PATH=$HOME/.bun/bin:$PATH && bun install --frozen-lockfile >/dev/null && bun test server 2>&1 | tail -3 && bun run build >/dev/null 2>&1 && rm -rf build && bun build server/index.ts --target bun --outfile build/server.js >/dev/null'
ssh sandbox 'cd ~/work/roll && tar czf - build dist' | ssh roll 'set -e; sudo rm -rf /opt/roll.new /opt/roll.old; sudo mkdir /opt/roll.new; sudo tar xzf - -C /opt/roll.new; [ -d /opt/roll ] && sudo mv /opt/roll /opt/roll.old; sudo mv /opt/roll.new /opt/roll; sudo systemctl restart roll; sleep 1; systemctl is-active roll'
