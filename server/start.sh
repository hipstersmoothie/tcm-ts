#!/bin/sh
# Serve the codebase on the volume, making it the first time, and the docs site to anyone. Railway terminates TLS
# in front of it, so it serves plain HTTP inside (--insecure); clients use the https:// domain. It never runs code
# for them.
set -eu
: "${TCM_TOKEN:?set TCM_TOKEN: the token clients push and pull with}"
TCM=/app/node_modules/tcm-ts/bin/tcm.js
DIR="${TCM_DIR:-/data/tcm-ts}"
mkdir -p "$DIR"
cd "$DIR"
if [ ! -f .tcm/codebase.sqlite ]; then
  node "$TCM" init > /dev/null
  rm -f scratch.ts
fi
exec node "$TCM" serve --host 0.0.0.0 --port "${PORT:-7737}" --insecure --no-run --site /app/site
