#!/bin/sh
# Check that hashes don't depend on the compiler: hash this repo with TypeScript 7 and with tsrs (TypeScript 7 in
# Rust, installed into a temporary directory) and diff, then run the golden hash test with tsrs.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
printf '{"private":true}\n' > "$TMP/package.json"
(cd "$TMP" && npm install --no-audit --no-fund --loglevel=error tsrs >/dev/null)
TSRS="$(cd "$TMP" && node --input-type=module -e 'import("./node_modules/tsrs/lib/getExePath.js").then((m) => console.log(m.default()))')"
cd "$REPO"
node scripts/hash-project.ts packages > "$TMP/typescript.txt"
TCM_TYPESCRIPT="$TSRS" node scripts/hash-project.ts packages > "$TMP/tsrs.txt"
if diff "$TMP/typescript.txt" "$TMP/tsrs.txt"; then echo "identical hashes ($(wc -l < "$TMP/typescript.txt" | tr -d ' ') definitions)"; else echo "hashes differ"; exit 1; fi
TCM_TYPESCRIPT="$TSRS" node --test --disable-warning=ExperimentalWarning packages/core/test/golden.test.ts | grep -E '^ℹ (pass|fail) '

