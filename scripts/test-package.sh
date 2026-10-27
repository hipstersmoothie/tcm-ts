#!/bin/sh
# Build and pack the npm package, install it like a user would, and run the whole test suite against the
# installed copy, which runs from inside node_modules as plain JavaScript.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
node "$REPO/scripts/build.ts"
(cd "$REPO/dist/package" && npm pack --silent --pack-destination "$TMP" > /dev/null)
(cd "$TMP" && npm init -y > /dev/null && npm install ./ucm-ts-*.tgz --no-audit --no-fund --loglevel=error > /dev/null)
PKG="$TMP/node_modules/ucm-ts"
echo "installed $(ls "$TMP"/ucm-ts-*.tgz | xargs basename) into $TMP"
cd "$REPO"
UCM_BIN="$PKG/bin/ucm.js" UCM_CORE="$PKG/core/index.js" node --test --disable-warning=ExperimentalWarning 'packages/*/test/*.test.ts' | grep -E '^ℹ (tests|pass|fail) '
