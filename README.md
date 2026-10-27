# ucm-ts

[Unison](https://www.unison-lang.org)'s codebase model for plain TypeScript. Definitions are stored by the
hash of their syntax tree, and names are only pointers to hashes. So renames are free, nothing gets rebuilt,
and two versions of a dependency can live side by side. You don't need new syntax: any erasable TypeScript
file works as input, and Node runs the result directly through its built-in type stripping.

Requires Node ≥ 22.18 (tested on 24.15). The only dependency is `typescript@6`, which is used for parsing
and typechecking.

```sh
pnpm install
alias ucm="node $PWD/packages/cli/bin/ucm.js"   # or: npm link

mkdir demo && cd demo
ucm init          # .ucm/codebase.sqlite, package.json "#codebase" imports, tsconfig, scratch.ts
ucm               # watch: typecheck + hash scratch files, evaluate bare expressions
ucm add           # save new definitions from scratch.ts
```

## The workflow

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

| Command | |
|---|---|
| `ucm` / `ucm check [file]` | report each definition as `new` / `identical` / `update` / `alias` / `conflict`, then evaluate watch expressions |
| `ucm add` / `ucm update` | save. `update` re-points names and re-hashes every dependent; dependents that stop typechecking keep their old hash and go to `todo` |
| `ucm import <dir> [--into ns]` | add an existing project. Each file becomes a namespace (`core/src/analyze.ts` → `core.analyze`); imports between files, barrels and workspace packages resolve to hashes; test files are skipped |
| `ucm migrate` | rebuild a codebase written with an older hash format. Every stored definition is re-rendered against its migrated dependencies and re-hashed; names, history, branches, patches, todo and remotes carry over; the old `.ucm` is kept as a backup |
| `ucm verify` | re-render every live definition from the store and re-hash it. This must be the identity |
| `ucm view`, `ls`, `find`, `deps`, `dependents`, `docs` | browse. Code is rendered with the *current* names |
| `ucm run <name> [args]` | run a definition. Functions are called with the args, and the result is awaited and printed |
| `ucm mv`, `alias`, `rm`, `resolve` | name operations. They never touch code |
| `ucm edit <name>...` | write definitions to a scratch file, with references following any updates. Names can span namespaces; a definition whose path isn't `<namespace>.<declared name>` gets a `// ucm: path a.b.c` comment, so `update` binds it back to the same path. You can write those comments yourself too |
| `ucm todo` | conflicts, plus dependents that need fixing after an update |
| `ucm diff [<id> \| <branch> \| <a> <b>]` | review changes by meaning: what the last command changed (or since a history entry, or between branches). Edits are shown as line diffs with each side's own names. Definitions re-hashed only because a dependency changed are listed separately, with what triggered them. Renames and aliases are recognized as such, and renaming locals or reformatting doesn't count as a change |
| `ucm remote add <name> <url\|dir> [--token t]` | a `ucm serve` URL or another codebase directory |
| `ucm push` / `ucm pull [remote] [branch]` | sync by hash: only components the other side lacks are sent. `pull` mirrors into `origin/main` and fast-forwards your branch if you haven't changed it. `push` refuses if the remote moved since your last sync. There's no merge yet: use `ucm diff main origin/main` |
| `ucm run <name> [args] --on <remote>` | send the definition's missing closure, run it there, and stream stdout/stderr back |
| `ucm serve [--port] [--host] [--token] [--no-run]` | serve this codebase over HTTP. It listens on localhost and requires a token. Clients can run code unless `--no-run` |
| `ucm history`, `reset <id>`, `branch`, `switch` | reflog, undo, and branches of the namespace |

## How it works

- **Definitions** are top-level `function`s (overloads included), `const`s, `class`es, `type`s and `interface`s.
  Classes hash as one unit. Top-level `let`/`var`, enums, namespaces, decorators and `declare` are rejected
  with a reason.
- **Hashing** (`packages/core/src/canonicalize.ts`): every definition is lowered to an S-expression IR built
  from syntax-kind *names*, not numbers, with every child labelled by its slot (`name`, `body`, …).
  - Comments, formatting and `export` are dropped.
  - Literals are normalized: `1_000` = `0x3e8`, and `'a'` = `"a"`.
  - Locals become de Bruijn levels, so renaming a local doesn't change the hash.
  - Every identifier is resolved through the type checker. A reference to another definition becomes
    `Ref <hash>`, an npm import becomes `Ext npm:<pkg>@<exact version>`, and a global becomes `G name`.
  - Property names stay structural.
  - Type annotations are part of the hash.
  - Mutually recursive definitions are hashed as a cycle (Tarjan SCC + Unison-style ordering), including
    cycles that span files.
  - **Identity is preserved.** In JavaScript every declaration has its own identity: `new Map()` twice is two
    maps, and two identical classes fail each other's `instanceof`. So every function, class and value is
    hashed with a *lineage salt*, the codebase path where it was first added. Updates and renames reuse the
    existing salt, so renames stay free and re-adding the same file reproduces the same hashes. Identical code
    added at two paths is two definitions. Types have no runtime identity and stay unsalted, so they still
    deduplicate.
  - **Names are hashed exactly where JavaScript can observe them** (`.name`): function and class
    declarations, `const f = () => …`, and local functions or bindings that name an anonymous function
    (`function helper() {}`, `(cb = () => {}) =>`). Generated code keeps these names, so `ucm mv` changes the
    codebase path but not `.name`. All other locals and parameters stay alpha-renamable.
  - **The format is frozen at IR v4.** `packages/core/test/golden.test.ts` pins the hashes of a corpus that
    covers most syntax. `pnpm compare-ts 5.8` re-hashes the repo and the corpus on another TypeScript
    version: 5.8.3, 5.9.3 and 6.0.3 produce identical hashes.
- **Storage** (`packages/store`): `node:sqlite`. It holds definitions (IR, original source text, spans of
  every reference), dependency edges, signatures, docs, names per branch, a name log, patches and todo.
- **Execution** (`packages/loader`): each component becomes `.ucm/cache/<hash>.ts`, with the current names
  spliced into the stored source and `import { h_<hash> as name } from "./<hash>.ts"` for dependencies.
  - npm dependencies are installed under per-version aliases (`npm__pkg__1.2.3`), so pinned versions coexist.
  - Node runs these files with no build step and no loader hooks.
  - The cache and the `.ucm/codebase` shim are derived data: both are rebuilt from the database.

**Sync never trusts the sender.** Received definitions are checked before anything is stored:
- each component must arrive complete;
- every reference must resolve;
- rendering, typechecking and hashing locally must reproduce the claimed hashes.

Dependencies and signatures are recomputed locally. Nothing received is executed during checking, and npm
installs use `--ignore-scripts`. Tampered source sent under an existing hash is rejected; `sync.test.ts`
checks this.

Tests: `pnpm test` runs the hashing invariants, the frozen golden hashes and an end-to-end CLI scenario.
`pnpm typecheck` checks the repo.

## Self-hosting

`pnpm selfhost` imports `packages/` into `selfhost/.ucm` (142 definitions) and then:

1. runs `ucm verify` with the **self-hosted** ucm: every definition round-trips to its own hash;
2. runs the whole test suite against the self-hosted CLI and analyzer (`UCM_BIN=selfhost/ucm.ts
   UCM_CORE=selfhost/core.ts`), which execute entirely from `.ucm/cache`;
3. checks the fixed point: the self-hosted ucm imports `packages/` again and assigns exactly the same hashes.

Getting there took two small refactors, both now enforced by the tool. A top-level `for` loop that filled a
lookup table became an immediately-invoked function, and the CLI's top-level `try` moved into an exported
`runCli`. `ucm import` refuses top-level statements, because quietly skipping one could leave a definition
half-initialized.

## Not done yet

The design and milestones are in the plan. Still open:

- Top-level destructuring (`const { a, b } = …`) is rejected rather than stored as a multi-member component.
- A type and a value cannot share a name (`const User = z.object(…)` with `type User = …`). TypeScript
  won't merge a type re-export and a value re-export in the `#codebase` shim. Supporting it means generating
  merged declarations with forwarded type parameters.
- `import.meta` is location-dependent: it is evaluated inside `.ucm/cache`, so ucm warns about it.
  ucm-ts's own `createRequire(import.meta.url)` still finds `@types/node`, because the cache sits inside
  the repo.
- `ucm import` uses ucm's compiler options, not the project's `tsconfig.json`, and skips test files.
- `find` searches signature *text*; structural type search (signature IR) isn't built.
- No `merge` between branches.
- Watch results aren't cached by hash.
- The watcher uses `createProgram` with `oldProgram` reuse, not a LanguageService.
- No namespace **merge**: a diverged `pull` leaves your branch alone and mirrors the remote into
  `origin/<branch>` for review.
- To share one definition under two names, use `ucm alias`. Adding the same code twice creates two.
- TypeScript 7 (the Go compiler) has a different API and isn't supported.
- Behaviour of transitive npm dependencies is not part of a hash; only the direct `name@version` is.
