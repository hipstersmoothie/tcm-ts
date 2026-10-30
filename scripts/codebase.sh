#!/bin/sh
# tcm, working on tcm's own codebase: `pnpm tcm edit tcmts.core.semver.compatRange`, `pnpm tcm patch …`,
# `pnpm tcm update`. The code lives in the codebase, in codebase/ (not in git); this repository only says how to get
# it. The first run gets tcm itself, when there's no known-good build here yet (tcm's server has the one it runs:
# $ORIGIN/tcm-ts.tgz), and makes the codebase by pulling it from the server (TCM_TOKEN has the server's token), with
# its history and releases.
#
# It runs the known-good tcm, the build the last passing `pnpm verify` tested (dist/known-good): a change that breaks
# tcm can't break the tcm making it. TCM_LIVE=1 runs the codebase's own tcm, as it is now (to try a change before
# verifying it): the known-good one runs it from the codebase (`tcm run tcmts.cli.main.runCli`).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
GOOD="$REPO/dist/known-good"
TCM="$GOOD/node_modules/tcm-ts/bin/tcm.js"
ORIGIN="${TCM_ORIGIN-https://tcm-server-production.up.railway.app}"
# (what setting up prints goes to stderr: `pnpm tcm mcp`'s stdout is the protocol channel)
if [ ! -f "$TCM" ]; then
  echo "tcm: no known-good build here yet; getting the one $ORIGIN runs" >&2
  mkdir -p "$GOOD"
  curl -fsSL "$ORIGIN/tcm-ts.tgz" -o "$GOOD/tcm-ts.tgz" || { echo "tcm: couldn't get $ORIGIN/tcm-ts.tgz" >&2; exit 1; }
  (cd "$GOOD" && npm init -y > /dev/null && npm install ./tcm-ts.tgz --no-audit --no-fund --loglevel=error >&2)
  echo "from $ORIGIN, $(date -u '+%Y-%m-%d %H:%M')" > "$GOOD/VERIFIED"
fi
mkdir -p "$REPO/codebase"
cd "$REPO/codebase"
if [ ! -f .tcm/codebase.sqlite ]; then
  if [ -z "${TCM_TOKEN:-}" ]; then
    echo "tcm: the codebase comes from tcm's server ($ORIGIN): set TCM_TOKEN to its token" >&2
    exit 1
  fi
  node "$TCM" init > /dev/null
  rm -f scratch.ts
  node "$TCM" remote add origin "$ORIGIN" --token "$TCM_TOKEN" >&2
  node "$TCM" pull >&2
fi
# `pnpm tcm` works in codebase/ too (its package.json is the codebase's own)
node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8")); if (!p.scripts?.tcm) fs.writeFileSync("package.json", JSON.stringify({ ...p, scripts: { ...p.scripts, tcm: "sh ../scripts/codebase.sh" } }, null, 2) + "\n");'
# run from where it was called (pnpm says where: INIT_CWD), so paths given to it are the caller's; TCM_CODEBASE says
# which codebase (tcm leaves it out of what tests run, so they work on their own)
export TCM_CODEBASE="$REPO/codebase"
cd "${INIT_CWD:-$REPO/codebase}"
if [ -n "${TCM_LIVE:-}" ]; then exec node "$TCM" run tcmts.cli.main.runCli -- "$@"; fi
exec node "$TCM" "$@"
