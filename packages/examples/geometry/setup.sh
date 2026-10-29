#!/bin/sh
# Build the geometry example as a tcm codebase in <dir> (default ./geometry-demo), with a history: two packages
# (geo, a library, and atlas, a command built on it), their releases, a contribution merged through a hub, and an
# unreleased change waiting for its release. Then open <dir> in VS Code (with the tcm-ts extension).
# Uses this checkout's tcm unless TCM is set (e.g. TCM=tcm for an installed one).
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$PWD/geometry-demo}
# a function, not a variable: this checkout's path may contain spaces. TCM_BIN (a tcm.js to run with Node) is
# what the test suites set.
bin=${TCM_BIN:-$(cd "$here/../.." && pwd)/packages/cli/bin/tcm.js}
tcm() {
  if [ -z "$TCM_BIN" ] && [ -n "$TCM" ]; then $TCM "$@"
  else node "$bin" "$@"; fi
}
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ -e "$dir/.tcm" ]; then echo "$dir already has a codebase" >&2; exit 1; fi
mkdir -p "$dir"
cd "$dir"
export TCM_AUTHOR=${TCM_AUTHOR:-ada}

step "A codebase, and a hub to share it through (another codebase; a tcm serve URL works the same)"
tcm init > /dev/null
rm -f scratch.ts
mkdir .hub
(cd .hub && tcm init > /dev/null && rm -f scratch.ts)
tcm remote add origin .hub

step "geo and atlas, each a package: a namespace with a manifest"
for f in geo.ts atlas.ts; do
  cp "$here/$f" .
  tcm add "$f"
  rm "$f"
done
tcm test

step "Their first releases, declared stable (1.0.0), with a summary each; the rest of the notes tcm writes"
tcm release geo@1.0.0 --notes "$here/notes/geo-1.0.0.md"
tcm release atlas@1.0.0 --notes "$here/notes/atlas-1.0.0.md"
tcm push

step "geo 1.1: perimeters, and rounded distances. Additions, so tcm makes it a minor release"
cp "$here/steps/1.1-geo.ts" geo.ts && tcm update geo.ts && rm geo.ts
tcm release check geo
tcm release geo --notes "$here/notes/geo-1.1.0.md"
cp "$here/steps/1.1-atlas.ts" atlas.ts && tcm add atlas.ts && rm atlas.ts
tcm release atlas --notes "$here/notes/atlas-1.1.0.md"
tcm push

step "A contribution: hexagons, proposed on a branch, reviewed and merged on the hub"
tcm branch hexagons
tcm switch hexagons
cp "$here/steps/hexagons.ts" geo.ts && tcm update geo.ts && rm geo.ts
tcm contribute --title "Hexagons" --description "Regular hexagons, by their side."
tcm contribution view 1
tcm contribution comment 1 "Lovely. That's a new case of Shape, so it's geo 2.0." --about geo.Shape
tcm contribution merge 1
tcm switch main
tcm pull > /dev/null

step "geo 2.0: the new case of Shape is breaking, and the notes name the contribution that brought it"
tcm release geo --notes "$here/notes/geo-2.0.0.md"
tcm push

step "What's next: an unreleased change to geo, and a draft of its notes for you to write"
cp "$here/steps/next.ts" geo.ts && tcm update geo.ts && rm geo.ts
tcm release check geo
tcm release geo --draft
cp "$here/playground.ts" scratch.ts

# the editor runs the same tcm
mkdir -p .vscode
case "$bin" in *.js|*.ts) printf '{\n  "tcm.path": "%s"\n}\n' "$bin" > .vscode/settings.json ;; esac
[ -z "$TCM_BIN" ] && [ -n "$TCM" ] && printf '{\n  "tcm.path": "%s"\n}\n' "$TCM" > .vscode/settings.json

cat <<MSG

The geometry example is in $dir.
  tcm releases                 the two packages and their releases
  tcm changelog geo            geo's changelog, written from its releases
  tcm release check geo        what geo's next release would be, and why
  tcm history                  how it got here
  tcm pack atlas@1.1.0         an npm package of atlas 1.1, depending on geo
Open $dir in VS Code (with the tcm-ts extension): the Releases view, release-geo.md, the playground.
MSG
