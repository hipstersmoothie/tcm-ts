#!/bin/sh
# Build the polls example as a ucm codebase in <dir> (default ./polls-demo), then open <dir> in your editor.
# Uses this checkout's ucm unless UCM is set (e.g. UCM=ucm for an installed one).
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$PWD/polls-demo}
# a function, not a variable: this checkout's path may contain spaces. UCM_BIN (a ucm.js to run with Node) is
# what the test suites set.
ucm() {
  if [ -n "$UCM_BIN" ]; then node "$UCM_BIN" "$@"
  elif [ -n "$UCM" ]; then $UCM "$@"
  else node "$here/../../packages/cli/bin/ucm.js" "$@"; fi
}

if [ -e "$dir/.ucm" ]; then echo "$dir already has a codebase" >&2; exit 1; fi
mkdir -p "$dir"
cd "$dir"
ucm init > /dev/null
rm -f scratch.ts

# the code goes into the codebase file by file, as you'd add it from scratch files; then the files go away:
# from here on the code lives in .ucm, and the editor shows it from there
for f in model server ui; do
  cp "$here/$f.ts" .
  ucm add "$f.ts"
  rm "$f.ts"
done
cp "$here/playground.ts" scratch.ts
ucm test polls

cat <<MSG

The polls example is in $dir.
  ucm ls polls              what's in it
  ucm view polls.vote       a definition, with where it runs
  ucm dev polls.main        run the app (open the URL it prints)
Open $dir in VS Code (with the ucm-ts extension) to see it in the editor.
MSG
