#!/bin/sh
# Build ucm's own codebase from packages/, then check the self-hosted build three ways:
#   1. every definition re-renders and re-hashes to itself (`ucm verify`, run by the self-hosted ucm)
#   2. the test suite passes against the self-hosted CLI and analyzer
#   3. fixed point: the self-hosted ucm imports packages/ and assigns exactly the same hashes
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/selfhost"
rm -rf .ucm
node ../packages/cli/bin/ucm.js init > /dev/null
rm -f scratch.ts
node ../packages/cli/bin/ucm.js import ../packages --into ucmts
node ucm.ts verify

cd "$REPO"
UCM_BIN=selfhost/ucm.ts UCM_CORE=selfhost/core.ts node --test --disable-warning=ExperimentalWarning 'packages/*/test/*.test.ts' | grep -E '^ℹ (tests|pass|fail) '

FIX="$(mktemp -d)"
(cd "$FIX" && node "$REPO/selfhost/ucm.ts" init > /dev/null && rm scratch.ts && node "$REPO/selfhost/ucm.ts" import "$REPO/packages" --into ucmts > /dev/null 2>&1)
sqlite3 "$REPO/selfhost/.ucm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/source-built.txt"
sqlite3 "$FIX/.ucm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/self-hosted.txt"
diff "$FIX/source-built.txt" "$FIX/self-hosted.txt"
echo "fixed point: the self-hosted ucm assigns its own source the same $(wc -l < "$FIX/source-built.txt" | tr -d ' ') hashes"
