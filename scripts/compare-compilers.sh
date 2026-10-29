#!/bin/sh
# Check that hashes don't depend on the compiler: hash this repo and the golden corpus with TypeScript 7 and with
# tsrs (TypeScript 7 in Rust, installed into a temporary directory), and diff.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
printf '{"private":true}\n' > "$TMP/package.json"
(cd "$TMP" && npm install --no-audit --no-fund --loglevel=error tsrs >/dev/null)
TSRS="$(cd "$TMP" && node --input-type=module -e 'import("./node_modules/tsrs/lib/getExePath.js").then((m) => console.log(m.default()))')"
cd "$REPO"
for dir in packages packages/core/test/golden; do
  node scripts/hash-project.ts "$dir" >> "$TMP/typescript.txt"
  TCM_TYPESCRIPT="$TSRS" node scripts/hash-project.ts "$dir" >> "$TMP/tsrs.txt"
done
if diff "$TMP/typescript.txt" "$TMP/tsrs.txt"; then echo "identical hashes ($(wc -l < "$TMP/typescript.txt" | tr -d ' ') definitions)"; else echo "hashes differ"; exit 1; fi
