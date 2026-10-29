#!/bin/sh
# Everything a commit needs to pass: typecheck and the suites, then selfhost and the packed package side by side
# (they're independent, and mostly wait on installs, builds and browsers). Prints each stage's result and time;
# each stage's whole output is in the directory it names.
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
  grep -E '^ℹ (pass|fail) |^✖ |^fixed point|^verified|^tcm test' "$LOGS/$name.log" | grep -v '^✖ failing tests' | sort -u | sed 's/^/  /'
  [ "$result" = ok ]
}

stage typecheck pnpm -s typecheck || failed=1
stage test pnpm -s test || failed=1
# selfhost and the package each run the suites; together they take about as long as the slower one
(stage selfhost pnpm -s selfhost > "$LOGS/selfhost.summary"; echo $? > "$LOGS/selfhost.status") &
(stage package pnpm -s test:package > "$LOGS/package.summary"; echo $? > "$LOGS/package.status") &
wait
cat "$LOGS/selfhost.summary" "$LOGS/package.summary"
[ "$(cat "$LOGS/selfhost.status")" = 0 ] || failed=1
[ "$(cat "$LOGS/package.status")" = 0 ] || failed=1

echo "$([ $failed = 0 ] && echo "all passed" || echo "FAILED") in $(($(date +%s) - started))s (logs in $LOGS)"
exit $failed
