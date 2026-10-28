#!/bin/sh
# Build the notes example as a ucm codebase in <dir> (default ./notes-demo), then open <dir> in your editor.
# Uses this checkout's ucm unless UCM is set (e.g. UCM=ucm for an installed one). Installs React from npm.
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$PWD/notes-demo}
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
# React and its types: definitions pin the versions installed here
npm install --silent --no-audit --no-fund react@19 react-dom@19 @types/react@19 @types/react-dom@19

# the code goes into the codebase file by file, as you'd add it from scratch files; then the files go away:
# from here on the code lives in .ucm, and the editor shows it from there
for f in model.ts markdown.tsx server.ts ui.tsx; do
  cp "$here/$f" .
  ucm add "$f"
  rm "$f"
done
cp "$here/playground.tsx" scratch.tsx
ucm test notes

cat <<MSG

The notes example is in $dir.
  ucm ls notes                what's in it
  ucm view notes.NoteList     a server component, and why it renders on the server
  ucm dev notes.App           run the app (open the URL it prints)
Open $dir in VS Code (with the ucm-ts extension) to see it in the editor.
MSG
