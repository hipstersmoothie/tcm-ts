#!/bin/sh
# tcm, working on tcm's own codebase: `pnpm tcm edit tcmts.core.semver.compatRange`, `pnpm tcm update`, `pnpm tcm mv …`.
# The codebase lives in codebase/ (not in git) and mirrors the repository: changes made through tcm are written back
# to its files as edits, which are what's committed. The first run makes it from tcm's server (TCM_ORIGIN, Railway
# by default) when TCM_TOKEN has its token: the codebase with its history and releases, pulled, then the files
# linked as its mirror (what they changed since, as updates). Without a token, or a server to pull from, it imports
# the files instead.
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
ORIGIN="${TCM_ORIGIN-https://tcm-server-production.up.railway.app}"
mkdir -p "$REPO/codebase"
cd "$REPO/codebase"
# (what making it prints goes to stderr: `pnpm tcm mcp`'s stdout is the protocol channel)
if [ ! -f .tcm/codebase.sqlite ]; then
  node "$TCM" init > /dev/null
  rm -f scratch.ts
  if [ -n "$ORIGIN" ] && [ -n "${TCM_TOKEN:-}" ] && node "$TCM" remote add origin "$ORIGIN" --token "$TCM_TOKEN" >&2 && node "$TCM" pull >&2; then
    node "$TCM" import .. --into tcmts --tests --mirror --update >&2
  else
    echo "tcm: making the codebase from the files (TCM_TOKEN, the server's token, makes it from $ORIGIN)" >&2
    node "$TCM" import .. --into tcmts --tests --mirror >&2
  fi
fi
exec node "$TCM" "$@"
