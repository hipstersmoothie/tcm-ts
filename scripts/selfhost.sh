#!/bin/sh
# Build tcm's own codebase from packages/, then check the self-hosted build three ways:
#   1. every definition re-renders and re-hashes to itself (`tcm verify`, run by the self-hosted tcm)
#   2. the test suite passes against the self-hosted CLI and analyzer
#   3. fixed point: the self-hosted tcm imports packages/ and assigns exactly the same hashes
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/selfhost"
rm -rf .tcm
node ../packages/cli/bin/tcm.js init > /dev/null
rm -f scratch.ts
node ../packages/cli/bin/tcm.js import ../packages --into tcmts
node tcm.ts verify

cd "$REPO"
TCM_BIN=selfhost/tcm.ts TCM_CORE=selfhost/core.ts node --test --disable-warning=ExperimentalWarning 'packages/*/test/*.test.ts' | grep -E '^ℹ (tests|pass|fail) '

FIX="$(mktemp -d)"
(cd "$FIX" && node "$REPO/selfhost/tcm.ts" init > /dev/null && rm scratch.ts && node "$REPO/selfhost/tcm.ts" import "$REPO/packages" --into tcmts > /dev/null 2>&1)
sqlite3 "$REPO/selfhost/.tcm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/source-built.txt"
sqlite3 "$FIX/.tcm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/self-hosted.txt"
diff "$FIX/source-built.txt" "$FIX/self-hosted.txt"
echo "fixed point: the self-hosted tcm assigns its own source the same $(wc -l < "$FIX/source-built.txt" | tr -d ' ') hashes"
