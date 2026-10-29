#!/bin/sh
# Everything a commit needs to pass: typecheck, then selfhost (tcm's codebase verified and its tests run, the
# fixed point, and the whole test suite once, against the package packed from the codebase). Prints each stage's
# result and time; each stage's whole output is in the directory it names. When everything passes, the package
# tested becomes the known-good tcm (dist/known-good) that `pnpm tcm` and the repository's MCP server run.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$(mktemp -d)"
cd "$REPO"
started=$(date +%s)
failed=0

stage() {
  name="$1"
  shift
  t0=$(date +%s)
  if "$@" > "$LOGS/$name.log" 2>&1; then result="ok"; else result="FAILED"; fi
  echo "$name: $result ($(($(date +%s) - t0))s)"
  grep -E '^ℹ (pass|fail) |^✖ |^fixed point|^verified|^tcm test|^far away|^installed' "$LOGS/$name.log" | grep -v '^✖ failing tests' | sed 's/^/  /'
  [ "$result" = ok ]
}

stage typecheck pnpm -s typecheck || failed=1
stage selfhost pnpm -s selfhost || failed=1

if [ $failed = 0 ] && [ -f dist/candidate/node_modules/tcm-ts/bin/tcm.js ]; then
  # what it was made from: the commit, and whether there were changes on top of it
  printf '%s%s, verified %s\n' "$(git rev-parse --short HEAD)" "$(git diff --quiet HEAD -- packages && echo "" || echo " with changes")" "$(date '+%Y-%m-%d %H:%M')" > dist/candidate/VERIFIED
  rm -rf dist/known-good
  mv dist/candidate dist/known-good
  echo "known-good tcm: $(cat dist/known-good/VERIFIED); pnpm tcm and the MCP server run it"
fi
echo "$([ $failed = 0 ] && echo "all passed" || echo "FAILED") in $(($(date +%s) - started))s (logs in $LOGS)"
exit $failed
