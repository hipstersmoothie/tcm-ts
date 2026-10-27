# ucm-ts

[Unison](https://www.unison-lang.org)'s codebase model for plain TypeScript. Definitions are stored by the
hash of their syntax tree, and names are only pointers to hashes. So renames are free, nothing gets rebuilt,
and two versions of a dependency can live side by side. You don't need new syntax: any erasable TypeScript
file works as input, and Node runs the result directly through its built-in type stripping.

Requires Node ≥ 22.18 (tested on 24.15). The only dependency is `typescript@6`, which is used for parsing
and typechecking.

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
| `ucm dev <app>` / `ucm build <app>` / `ucm start <app>` | browser apps with server functions called by hash (see below): develop with hot reload, build immutably, serve in production, where moving the app's name deploys or rolls back |
| `ucm test [namespace] [--fresh]` | run tests: definitions named `test…` (or under a `tests` namespace) that pass by returning without throwing. A test's hash covers everything it calls, so results are cached by hash and Node version, and only tests whose code or dependencies changed re-run. The watcher runs tests from the scratch file inline. Tests that read the filesystem, clock or network can go stale in the cache; use `--fresh` |
| `ucm verify` | re-render every live definition from the store and re-hash it. This must be the identity |
| `ucm view`, `ls`, `find`, `deps`, `dependents`, `docs` | browse. Code is rendered with the *current* names |
| `ucm run <name> [args]` | run a definition. Functions are called with the args, and the result is awaited and printed |
| `ucm mv`, `alias`, `rm`, `resolve` | name operations. They never touch code |
| `ucm edit <name>...` | write definitions to a scratch file, with references following any updates. Names can span namespaces; a definition whose path isn't `<namespace>.<declared name>` gets a `// ucm: path a.b.c` comment, so `update` binds it back to the same path. You can write those comments yourself too |
| `ucm todo` | conflicts, plus dependents that need fixing after an update |
| `ucm diff [<id> \| <branch> \| <a> <b>]` | review changes by meaning: what the last command changed (or since a history entry, or between branches). Edits are shown as line diffs with each side's own names. Definitions re-hashed only because a dependency changed are listed separately, with what triggered them. Renames and aliases are recognized as such, and renaming locals or reformatting doesn't count as a change |
| `ucm remote add <name> <url\|dir> [--token t]` | a `ucm serve` URL or another codebase directory |
| `ucm push` / `ucm pull [remote] [branch]` | sync by hash: only components the other side lacks are sent. `pull` mirrors into `origin/main`. It fast-forwards your branch if you haven't changed it, and merges otherwise. `push` refuses if the remote moved since your last sync |
| `ucm merge <branch>` | three-way merge of names, against the other branch as of the last merge, sync or fork. A name changed on one side takes that side; changed differently on both sides, it becomes a conflict (`ucm todo`, `ucm resolve`). A definition only re-hashed because a dependency moved doesn't count as a change. Each one-sided update is a patch, so the other side's code is re-derived against it; what no longer typechecks goes to `todo` |
| `ucm run <name> [args] --on <remote>` | send the definition's missing closure, run it there, and stream stdout/stderr back |
| `ucm serve [--port] [--host] [--token] [--no-run] [--tls]` | serve this codebase over HTTP(S). It requires a token, and clients can run code unless `--no-run`. `--tls` uses `--tls-cert`/`--tls-key`, or a self-signed certificate it creates, and prints the certificate's fingerprint. Clients pin it with `ucm remote add … --fingerprint`, and the token is only written after the pin checks out. Serving beyond localhost without TLS is refused unless `--insecure` |
| `ucm history`, `reset <id>`, `branch`, `switch` | reflog, undo, and branches of the namespace |

## How it works

- **Dynamic `import("pkg")`** of a package or Node builtin is pinned like a static import, so it's still
  content-addressed. Lazy imports of local files or codebase modules are rejected. A computed specifier
  (`import(url)`) is allowed with a warning, because it loads code the codebase doesn't track.
- **Definitions** are top-level `function`s (overloads included), `const`s, `class`es, `type`s and `interface`s.
  Top-level destructuring (`const { a, b: [c] } = init()`) binds one definition per name; the bindings share
  the statement, so it still runs once. A type and a value can share a name, like TypeScript's own type and value spaces (`const User = z.object(…)`
  with `type User = z.infer<typeof User>`). Each half is its own definition, updated, diffed and merged
  independently. The `#codebase` shim exports both under the one name.
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
  - **The format is frozen at IR v5.** `packages/core/test/golden.test.ts` pins the hashes of a corpus that
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

**Compiler options** come from the project's `tsconfig.json`: `lib`, strictness, `types` and so on are the
project's choice. A few options are forced, with a warning when the project sets them otherwise:
- `module`/`moduleResolution` NodeNext, which import classification and `#codebase` rely on;
- `verbatimModuleSyntax` and `erasableSyntaxOnly`, which Node's type stripping needs;
- `allowImportingTsExtensions` and `noEmit`.

`ucm import <dir>` uses the tsconfig nearest that directory. Options never affect hashes, only what typechecks.

**Packaging:** Node won't strip types from files under `node_modules`, so `pnpm build` (`scripts/build.ts`)
transpiles the workspace into one plain-JavaScript package, `ucm-ts`, in `dist/package`. Code ucm
generates (`.ucm/cache`) stays TypeScript, because it lives in your project. `pnpm test:package` packs and
installs that package, then runs the whole test suite against the installed copy. The binary is also
available as `ucm-ts`, since Unison's own CLI is called `ucm` too.

Tests: `pnpm test` runs the hashing invariants, the frozen golden hashes and an end-to-end CLI scenario.
`pnpm typecheck` checks the repo.

## Browser apps: no network boundary to write

```ts
// ucm: namespace app
import { readFileSync } from "node:fs";

export async function hostCount(): Promise<number> {       // uses node:fs → runs on the server
  return readFileSync("/etc/hosts", "utf8").split("\n").length;
}
export const render = (n: number) => `hosts: ${n}`;        // runs anywhere
export async function main() {                             // uses document → runs in the browser
  document.querySelector("#app")!.textContent = render(await hostCount());
}
```

`ucm dev app.main` serves this through Vite 8. Nothing is annotated: there's no `"use server"`, no routes, no
fetch calls and no API layer.

**How placement is inferred** (`ucm view` shows it for every definition):
- A definition runs **on the server** if it uses Node (`node:*`, `process`, `Buffer`, a server-only npm package),
  or uses something that does and can't be called remotely.
- It runs **in the browser** if it uses the DOM.
- Otherwise it runs **anywhere**.
- An **async** server function is a cut point. Browser code calling it gets a stub that calls it by hash, and
  the code around the call stays in the browser.
- A **synchronous** server function used from the browser is an error that names it ("Make app.machine
  async"), because a network call can't be synchronous.

**What this guarantees:**
- **Server code never reaches the browser.** The Vite plugin swaps whole server components for stubs before
  they're resolved.
- **The browser can call only the app's own server functions.** The endpoint surface is exactly the server
  functions the app calls, listed when `ucm dev` starts. Anything else, and cross-origin calls, are refused.
- **No client/server version skew.** Calls go by hash, as Unison's typed service calls do, and a hash never
  changes meaning.
- **Plain data crosses the wire:** JSON plus `Date`, `Map`, `Set`, `BigInt` and `undefined`. Anything else is
  refused with a message.
- **Hot reload:** `ucm update` in another shell reloads the browser.
- **Testable in one process:** in `ucm test` everything runs locally, the counterpart of Unison's local
  `Remote` handler.

**Arguments are checked against the parameter types.** A server function the browser can call is a public
endpoint, and TypeScript types are gone at runtime. So ucm derives a runtime schema from each server function's
parameters (objects, arrays, tuples, unions, literals, dates, maps, sets, recursive types). Calls with wrong
types, missing fields, unexpected extra fields, or too many arguments are refused with a 400 that says
what's wrong, before the function runs.

**Production: deploy and roll back by moving a name.**
- `ucm build <app>` writes an immutable, content-addressed build to `.ucm/apps/<app hash>/`. Its assets are
  served under `/_app/<hash>/`.
- `ucm start <app>` serves the build the app's name points to now. When the name moves (`ucm update`, `mv`,
  `reset`, `pull`), it builds the new version if needed and switches to it, so deploying and rolling back are
  both moving a name, like Unison's service names pointing at service hashes.
- **There is no version skew.** Earlier builds stay served, and their server functions stay callable. A tab
  opened before a deploy keeps loading its own assets and calling the exact code it was built against, until
  it reloads. `prod.test.ts` deploys v2 and checks the v1 tab still works, then rolls back.
- **`ucm apps` lists builds; `ucm apps prune --keep N` removes old ones.** It keeps the current build plus the
  N newest others; `ucm start --keep N` does this after every deploy. A tab still on a pruned build gets
  `410 Gone` from its next server call, and the browser runtime reloads the page onto the current version.
- **Pushing is deploying.** `ucm push prod` to a server running `ucm start` sends only the definitions it
  lacks. The server verifies them by re-hashing, then its `ucm start` sees the name move, builds and switches.
  There's no deploy script and no restart.

**Module-level state is placed by who uses it.** That follows from inference, not annotation, and every app
report shows it:
- **Server state:** `const visits = new Map()` used only by server functions has one copy, shared by every
  client.
- **Browser state:** used only by browser code, each tab has its own copy.
- **Used by both sides:** the server and every tab silently get separate copies, so ucm warns.

Only fresh mutable objects count (`new …`, `[]`, `{}`); `as const`, frozen and computed values don't.

**Not yet:**
- **Server-only npm packages are found by a heuristic:** no browser build, and an entry that imports Node
  builtins.

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

- `import.meta` is location-dependent: it is evaluated inside `.ucm/cache`, so ucm warns about it.
  ucm-ts's own `createRequire(import.meta.url)` still finds `@types/node`, because the cache sits inside
  the repo.
- `ucm import` skips test files.
- `find` searches signature *text*; structural type search (signature IR) isn't built.
- No `merge` between branches.
- Watch results aren't cached by hash.
- The watcher uses `createProgram` with `oldProgram` reuse, not a LanguageService.
- To share one definition under two names, use `ucm alias`. Adding the same code twice creates two.
- TypeScript 7 (the Go compiler) has a different API and isn't supported.
- Behaviour of transitive npm dependencies is not part of a hash; only the direct `name@version` is.
