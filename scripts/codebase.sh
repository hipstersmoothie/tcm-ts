#!/bin/sh
# tcm, working on tcm's own codebase: `pnpm tcm edit tcmts.core.semver.compatRange`, `pnpm tcm update`, `pnpm tcm mv …`.
# The codebase lives in codebase/ (not in git) and mirrors the repository: changes made through tcm are written back
# to its files as edits, which are what's committed. The first run imports the repository to make it.
#
# It runs the known-good tcm, the build the last passing `pnpm verify` tested (dist/known-good), not the repository as
# it is: a change that breaks tcm can't break the tcm making it, and a git checkout doesn't change it mid-session.
# TCM_LIVE=1 runs the repository's tcm instead (to try a change before verifying it); so does a repository with no
# known-good build yet.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TCM="$REPO/dist/known-good/node_modules/tcm-ts/bin/tcm.js"
if [ -n "${TCM_LIVE:-}" ]; then
  TCM="$REPO/cli/bin/tcm.js"
elif [ ! -f "$TCM" ]; then
  echo "tcm: no known-good build yet (\`pnpm verify\` makes one); running the repository's as it is" >&2
  TCM="$REPO/cli/bin/tcm.js"
fi
mkdir -p "$REPO/codebase"
cd "$REPO/codebase"
# (what making it prints goes to stderr: `pnpm tcm mcp`'s stdout is the protocol channel)
if [ ! -f .tcm/codebase.sqlite ]; then
  node "$TCM" init > /dev/null
  rm -f scratch.ts
  node "$TCM" import .. --into tcmts --tests --mirror >&2
fi
exec node "$TCM" "$@"
