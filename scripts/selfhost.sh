#!/bin/sh
# tcm checks itself, from its own codebase (built from packages/ by `pnpm build`, which also packs tcm-ts from it):
#   1. every definition re-renders and re-hashes to itself (`tcm verify`, run by the self-hosted tcm)
#   2. tcm's test definitions pass under the self-hosted `tcm test`, and a second run is all cached
#   3. fixed point: the self-hosted tcm imports packages/ and assigns exactly the same hashes
#   4. the self-hosted tcm works far from this repository
#   5. the package packed from the codebase installs, and the whole test suite passes against it: the one run of
#      the suites a commit needs (it covers the source, the codebase and the packaging at once). It's installed in
#      dist/candidate, which `pnpm verify` keeps as the known-good tcm when everything passes.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
sh "$REPO/scripts/build.sh"
cd "$REPO/selfhost"
node tcm.ts verify
# the tests written as definitions (packages/*/test/*.ts), run from the codebase and cached by hash (the suites run
# once, below, against the package)
first="$(NO_COLOR=1 node tcm.ts test tcmts --definitions)" || { echo "$first"; exit 1; }
echo "tcm test: $(printf '%s\n' "$first" | tail -1)"
second="$(NO_COLOR=1 node tcm.ts test tcmts --definitions | tail -1)"
passed="${second%% passed*}"
case "$second" in *"passed, 0 failed ($passed cached)") echo "tcm test again: $second" ;; *) echo "a second tcm test run wasn't all cached: $second"; exit 1 ;; esac

FIX="$(mktemp -d)"
if ! (cd "$FIX" && node "$REPO/selfhost/tcm.ts" init > /dev/null && rm scratch.ts && node "$REPO/selfhost/tcm.ts" import "$REPO/packages" --into tcmts --tests) > "$FIX/import.log" 2>&1; then
  grep -v '^warning' "$FIX/import.log"
  exit 1
fi
sqlite3 "$REPO/selfhost/.tcm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/source-built.txt"
sqlite3 "$FIX/.tcm/codebase.sqlite" "SELECT path || ' ' || hash FROM names ORDER BY path" > "$FIX/self-hosted.txt"
diff "$FIX/source-built.txt" "$FIX/self-hosted.txt"
echo "fixed point: the self-hosted tcm assigns its own source the same $(wc -l < "$FIX/source-built.txt" | tr -d ' ') hashes"

# the self-hosted tcm works far from this repository: nothing it needs is found by walking up to its node_modules
FAR="$(mktemp -d)"
(cd "$FAR" && node "$REPO/selfhost/tcm.ts" init > /dev/null && printf 'export const platform = () => process.platform;\n' > scratch.ts && node "$REPO/selfhost/tcm.ts" add > "$FAR/add.log" 2>&1) || { cat "$FAR/add.log"; exit 1; }
echo "far away: the self-hosted tcm makes a codebase in $FAR and checks code against @types/node there"

PACK="$REPO/dist/candidate"
rm -rf "$PACK"
mkdir -p "$PACK"
(cd "$REPO/dist/package" && npm pack --silent --pack-destination "$PACK" > /dev/null)
(cd "$PACK" && npm init -y > /dev/null && npm install ./tcm-ts-*.tgz --no-audit --no-fund --loglevel=error > /dev/null)
echo "installed $(basename "$PACK"/tcm-ts-*.tgz), packed from the codebase, into $PACK"

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
TCM_BIN="$PACK/node_modules/tcm-ts/bin/tcm.js" suites node --test --disable-warning=ExperimentalWarning 'packages/*/test/**/*.test.ts'
