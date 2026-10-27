#!/bin/sh
# Hash this repo's source with the analyzer running on another TypeScript version and diff against the pinned one.
# usage: scripts/compare-ts-versions.sh [typescript-version]   (default 5.9)
set -eu
VERSION="${1:-5.9}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
mkdir -p "$TMP/core"
cp -R "$REPO/packages/core/src" "$TMP/core/src"
printf '{"type":"module","dependencies":{"typescript":"%s","@types/node":"^24.0.0"}}\n' "$VERSION" > "$TMP/core/package.json"
(cd "$TMP/core" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
cd "$REPO"
for dir in packages packages/core/test/golden; do
  node scripts/hash-project.ts "$dir" >> "$TMP/pinned.txt"
  UCM_CORE="$TMP/core/src/index.ts" node scripts/hash-project.ts "$dir" >> "$TMP/other.txt"
done
if diff "$TMP/pinned.txt" "$TMP/other.txt"; then echo "identical hashes ($(wc -l < "$TMP/pinned.txt" | tr -d ' ') definitions)"; else echo "hashes differ"; exit 1; fi
