#!/bin/sh
# Build tcm's npm package, tcm-ts, in dist/package: tcm's own codebase (selfhost/.tcm, imported from packages/
# with its tests, its releases made again from git) packed by the self-hosted tcm from its manifest
# (packages/index.ts). At a release, it's that release; otherwise the code as it is, as 0.0.0.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/selfhost"
rm -rf .tcm
node ../packages/cli/bin/tcm.js init > /dev/null
rm -f scratch.ts
node ../packages/cli/bin/tcm.js import ../packages --into tcmts --tests --mirror
rm -rf "$REPO/dist/package"
node tcm.ts pack tcm-ts --out "$REPO/dist/package"
