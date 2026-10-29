#!/bin/sh
# tcm, working on tcm's own codebase: `pnpm tcm edit tcmts.core.semver.compatRange`, `pnpm tcm update`, `pnpm tcm mv …`.
# The codebase lives in codebase/ (not in git) and mirrors packages/: changes made through tcm are written back to
# packages/ as edits, which are what's committed. The first run imports packages/ to make it.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$REPO/codebase"
cd "$REPO/codebase"
# (what making it prints goes to stderr: `pnpm tcm mcp`'s stdout is the protocol channel)
if [ ! -f .tcm/codebase.sqlite ]; then
  node "$REPO/packages/cli/bin/tcm.js" init > /dev/null
  rm -f scratch.ts
  node "$REPO/packages/cli/bin/tcm.js" import ../packages --into tcmts --tests --mirror >&2
fi
exec node "$REPO/packages/cli/bin/tcm.js" "$@"
