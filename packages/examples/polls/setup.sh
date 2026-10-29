#!/bin/sh
# Build the polls example as a tcm codebase in <dir> (default ./polls-demo), then open <dir> in your editor.
# Uses this checkout's tcm unless TCM is set (e.g. TCM=tcm for an installed one).
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$PWD/polls-demo}
# a function, not a variable: this checkout's path may contain spaces. TCM_BIN (a tcm.js to run with Node) is
# what the test suites set.
tcm() {
  if [ -n "$TCM_BIN" ]; then node "$TCM_BIN" "$@"
  elif [ -n "$TCM" ]; then $TCM "$@"
  else node "$here/../../cli/bin/tcm.js" "$@"; fi
}

if [ -e "$dir/.tcm" ]; then echo "$dir already has a codebase" >&2; exit 1; fi
mkdir -p "$dir"
cd "$dir"
tcm init > /dev/null
rm -f scratch.ts

# the code goes into the codebase file by file, as you'd add it from scratch files; then the files go away:
# from here on the code lives in .tcm, and the editor shows it from there
for f in model server ui; do
  cp "$here/$f.ts" .
  tcm add "$f.ts"
  rm "$f.ts"
done
cp "$here/playground.ts" scratch.ts
tcm test polls

cat <<MSG

The polls example is in $dir.
  tcm ls polls              what's in it
  tcm view polls.vote       a definition, with where it runs
  tcm dev polls.main        run the app (open the URL it prints)
Open $dir in VS Code (with the tcm-ts extension) to see it in the editor.
MSG
