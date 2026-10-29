#!/bin/sh
# Build tcm's own codebase from packages/, then check the self-hosted build three ways:
#   1. every definition re-renders and re-hashes to itself (`tcm verify`, run by the self-hosted tcm)
#   2. the test suite passes against the self-hosted CLI and analyzer
#   3. fixed point: the self-hosted tcm imports packages/ and assigns exactly the same hashes
#   4. `tcm pack` makes tcm's npm package from the codebase, and the installed package works
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/selfhost"
rm -rf .tcm
node ../packages/cli/bin/tcm.js init > /dev/null
rm -f scratch.ts
node ../packages/cli/bin/tcm.js import ../packages --into tcmts
node tcm.ts verify

cd "$REPO"
# the suites' totals and the names of failing tests; fails if a test did
suites() {
  out="$(mktemp)"
  status=0
  "$@" > "$out" 2>&1 || status=$?
  grep -E '^ℹ (tests|pass|fail) ' "$out"
  grep '^✖ ' "$out" | grep -v '^✖ failing tests' | sort -u
  return "$status"
}
TCM_BIN=selfhost/tcm.ts TCM_CORE=selfhost/core.ts suites node --test --disable-warning=ExperimentalWarning 'packages/*/test/*.test.ts'

FIX="$(mktemp -d)"
if ! (cd "$FIX" && node "$REPO/selfhost/tcm.ts" init > /dev/null && rm scratch.ts && node "$REPO/selfhost/tcm.ts" import "$REPO/packages" --into tcmts) > "$FIX/import.log" 2>&1; then
  grep -v '^warning' "$FIX/import.log"
  exit 1
fi
sqlite3 "$REPO/selfhost/.tcm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/source-built.txt"
sqlite3 "$FIX/.tcm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/self-hosted.txt"
diff "$FIX/source-built.txt" "$FIX/self-hosted.txt"
echo "fixed point: the self-hosted tcm assigns its own source the same $(wc -l < "$FIX/source-built.txt" | tr -d ' ') hashes"

PACK="$(mktemp -d)"
(cd "$REPO/selfhost" && node tcm.ts pack core=tcmts.core.analyze.analyzeFile core=tcmts.core.analyze.analyzeProject core=tcmts.core.hash.IR_VERSION \
  --name "tcm-ts@$(node -p 'require("../package.json").version')" --bin tcm=tcmts.cli.main.runCli,tcm-ts=tcmts.cli.main.runCli \
  --with @types/node@^24 --files ../README.md,../docs --out "$PACK/package")
(cd "$PACK/package" && npm pack --silent --pack-destination "$PACK" > /dev/null)
(cd "$PACK" && npm init -y > /dev/null && npm install ./tcm-ts-*.tgz --no-audit --no-fund --loglevel=error > /dev/null)
TRY="$(mktemp -d)"
(cd "$TRY" && node "$PACK/node_modules/.bin/tcm" init > /dev/null && node "$PACK/node_modules/.bin/tcm" add > /dev/null && test "$(node "$PACK/node_modules/.bin/tcm" run square 12)" = 144)
echo "packed: tcm's package from its own codebase installs and runs (TCM_BIN=$PACK/node_modules/tcm-ts/bin/tcm.js runs the suites against it)"
