#!/bin/sh
# Build tcm's npm package, tcm-ts, in dist/package: tcm's own codebase (selfhost/.tcm, imported from packages/
# with its tests) packed by the self-hosted tcm with `tcm pack`. What's published is what the codebase holds.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/selfhost"
rm -rf .tcm
node ../packages/cli/bin/tcm.js init > /dev/null
rm -f scratch.ts
node ../packages/cli/bin/tcm.js import ../packages --into tcmts --tests
rm -rf "$REPO/dist/package"
node tcm.ts pack \
  core=tcmts.core.analyze.analyzeFile core=tcmts.core.analyze.analyzeProject core=tcmts.core.hash.IR_VERSION \
  --name "tcm-ts@$(node -p 'require("../package.json").version')" \
  --description "Unison's content-addressed codebase model for plain TypeScript" \
  --bin tcm=tcmts.cli.main.runCli,tcm-ts=tcmts.cli.main.runCli \
  --with @types/node@^24 --files ../README.md,../docs --out "$REPO/dist/package"
