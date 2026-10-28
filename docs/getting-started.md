# Getting started

Requires Node ≥ 22.18 (tested on 24.15). The only dependency is `typescript@6`, which is used for parsing and
typechecking. Node runs the generated code directly through its built-in type stripping.

```sh
# from a checkout: build the npm package and install it globally
pnpm install && pnpm build
npm install -g "$(cd dist/package && npm pack --silent)"   # binaries: ucm and ucm-ts

# or, while hacking on ucm itself, run the TypeScript source directly
alias ucm="node $PWD/packages/cli/bin/ucm.js"

mkdir demo && cd demo
ucm init          # .ucm/codebase.sqlite, package.json "#codebase" imports, tsconfig, scratch.ts
ucm               # watch: typecheck + hash scratch files, evaluate bare expressions
ucm add           # save new definitions from scratch.ts
```

The binary is also installed as `ucm-ts`, since Unison's own CLI is called `ucm` too.

## Scratch files

A scratch file is ordinary TypeScript, and `node scratch.ts` runs it as is. Saved definitions are imported
through a generated shim:

```ts
// ucm: namespace lib
import { square } from "#codebase";            // root namespace
import { sortWith } from "#codebase/lib";       // namespace lib
import { basename } from "node:path";           // builtins and npm packages work as usual

export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 0);

sumSquares([1, 2, 3])                           // watch expression: the watcher prints 14
```

- `// ucm: namespace lib` puts the file's definitions under `lib` (or pass `--into lib`).
- A bare expression at the top level is a **watch expression**, like Unison's `> expr`: the watcher evaluates
  and prints it, and it's never stored.
- `#codebase` is a shim generated from the database (`.ucm/codebase/`), wired up through `package.json`
  `imports`. Editors autocomplete it and go-to-definition lands in the generated code.

## The loop

1. **Watch.** `ucm` (or `ucm check` once) typechecks the scratch file and reports each definition as `new`,
   `identical`, `update`, `alias` or `conflict`, then evaluates watch expressions and tests defined in the file.
2. **Add.** `ucm add` saves new definitions. It refuses to rebind a name to different code; that's `update`.
3. **Update.** `ucm update` re-points changed names and re-hashes every dependent. A dependent's text doesn't
   change, only the hash it refers to, so if it still typechecks it gets a new hash automatically. Dependents
   that stop typechecking keep their old hash and go to `ucm todo`.
4. **Edit.** `ucm edit <name>...` writes definitions back into a scratch file with current names. A definition
   whose path isn't `<namespace>.<declared name>` gets a `// ucm: path a.b.c` comment, so `update` binds it
   back to the same path. You can write those comments yourself too.
5. **Browse.** `ucm view`, `ls`, `find`, `deps`, `dependents` and `docs` render code with the *current* names.
   `ucm find ':(xs: T[]) => T'` searches by type ([search](search.md)).
   `ucm mv`, `alias` and `rm` change names and never touch code.

Leading JSDoc on a definition is stored as its documentation (`ucm docs <name>`); it isn't part of the hash.

Next: the [CLI reference](cli.md), or [browser apps](apps.md) for the app platform.
