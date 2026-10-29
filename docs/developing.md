# Developing tcm-ts

## Layout

```
packages/
  core/     extraction, canonicalization (the IR), hashing, runtime schemas from types, compiler options
  store/    the SQLite codebase store
  loader/   rendering stored definitions to .tcm/cache modules, running them, the #codebase shim
  cli/      the tcm command, placement inference, sync, merge, web (Vite plugin, dev/build/start), the
            #tcm/server runtime, the wire codec
editors/    vscode/: the VS Code extension (a thin client for `tcm lsp`; not part of the npm package)
examples/   polls/: an example app, built and run in a browser by packages/cli/test/examples.test.ts
scripts/    build.ts (npm package), docs-site.ts, docs-dev.ts, selfhost.sh, test-package.sh, compare-compilers.sh
docs/       user documentation, one page per feature area
```

The command line is declared once, in `packages/cli/src/commands.ts`: each command's arguments and options as a
[@bomb.sh/router](https://bomb.sh) route tree, parsed into a typed model per command. `tcm help`, `--help`,
usage errors and shell completion ([@bomb.sh/tab](https://bomb.sh)) are all read from those definitions, and
prompts at a terminal use [@clack/prompts](https://bomb.sh) (`ui.ts`).

TypeScript is TypeScript 7, through `packages/core/src/ts.ts`: its syntax trees (`typescript/ast`), its compiler
process (`typescript/sync`), and the few helpers TypeScript 6 had that tcm uses. Code imports it as a namespace
(`import * as ts from "./ts.ts"`, or `ts` from `@tcm/core`). Checker answers cross a process boundary, so
canonicalization asks for symbols in batches (`prefetched` in `analyze.ts`). `typescript6` (an alias of
`typescript@6`) is a dev dependency only for the VS Code TypeScript plugin's test: the plugin runs inside the
editor's TypeScript, which is still the JavaScript one.

The `#tcm/server` runtime (`packages/cli/src/server-api.ts`) is one factory function whose own source is
written to `.tcm/cache/tcm-server.js`. It must stay self-contained: everything it uses comes in through its
`deps` parameter.

## Tests

| Command | |
|---|---|
| `pnpm verify` | everything a commit needs: typecheck and the suites, then selfhost and the packed package side by side; prints each stage's result and time and names failing tests |
| `pnpm test` | all suites: hashing invariants, frozen golden hashes, and end-to-end CLI scenarios (sync, merge, web apps in real Chrome, production, jobs, data, import) |
| `pnpm typecheck` | typecheck the repo (TypeScript 7's `tsc`) |
| `pnpm selfhost` | the self-hosting check below |
| `pnpm test:package` | pack and install the npm package, then run every suite against the installed copy |
| `pnpm docs:dev` | serve the docs site locally (port 4321, or the next free one), rebuilding and reloading open pages when `docs/` or `examples/` change |
| `pnpm docs:site` | build the docs site (`docs/*.md` and the examples page) into `dist/site`; it fails on any broken link or anchor. A GitHub Actions workflow (`.github/workflows/docs.yml`) builds and deploys it to GitHub Pages on pushes to `main` |
| `pnpm compare-compilers` | hash the repo with TypeScript 7 and with [tsrs](compiler-options.md#the-compiler), and run the golden test with tsrs; hashes must match |

`pnpm verify` should pass before a commit.

Tests that call code directly are [test definitions](testing.md): the core and store tests, and the CLI's
server-component and highlighting tests, in `packages/*/test/<name>.ts` (exports named `test…`, beside the helpers
they use). They live in tcm's own codebase like the code they test, cached by hash: a change re-runs only the
tests that reach it. A `<name>.test.ts` runner next to each registers them with `node:test` for `pnpm test`. The
rest of the CLI's tests are end-to-end `node:test` files that run the `tcm` binary by path: they reach all of tcm,
so they'd re-run on any change anyway.

## Working on tcm in tcm

`pnpm tcm <command>` runs tcm on tcm's own codebase, in `codebase/` (not in git). The first run imports
`packages/` into it as a [mirror](importing.md#mirrors), with the tests, so changes made through tcm are written
back to `packages/`, and those edits are what's committed:

```sh
pnpm tcm edit tcmts.core.semver.compatRange    # into codebase/scratch.ts
pnpm tcm update                                # the codebase, its 200-odd dependents, and packages/core/src/semver.ts
pnpm tcm mv tcmts.core.semver.meetsComparator tcmts.core.semver.matchesComparator
pnpm tcm test tcmts                            # the tests the change reaches, the rest cached
```

Editing `packages/` directly still works: `pnpm tcm import ../packages --into tcmts --tests --update` takes the
edits (and links the mirror again). Delete `codebase/` to start over from `packages/`.

## Self-hosting

`pnpm selfhost` imports `packages/` into `selfhost/.tcm` and then:

1. runs `tcm verify` with the **self-hosted** tcm: every definition round-trips to its own hash;
2. runs tcm's test definitions with the self-hosted `tcm test` (imported with `--tests`), then again: the second
   run must be all cached. Afterwards, a change to one definition re-runs only the tests that reach it;
3. runs the whole test suite against the self-hosted CLI (`TCM_BIN=selfhost/tcm.ts`), which executes entirely
   from `.tcm/cache`;
4. checks the fixed point: the self-hosted tcm imports `packages/` again and assigns exactly the same hashes;
5. makes tcm's npm package from the codebase with [`tcm pack`](publishing.md) (the `tcm` bins run
   `tcmts.cli.main.runCli`, and `tcm-ts/core` exports the analyzer), installs it and runs code with it. The
   whole suite passes against that package too (`TCM_BIN=<it>/bin/tcm.js`; the script prints where it is).

Getting there took two small refactors, both now enforced by the tool. A top-level `for` loop that filled a
lookup table became an immediately-invoked function, and the CLI's top-level `try` moved into an exported
`runCli`. Running from a codebase also means a module's exports are named by hash, so code that tells another
process where to import something from says which export too: `transpileModule()` gives the module hook its
URL and export name (a function in a codebase carries its hash at runtime, and the hash names its export).

## Packaging

Node won't strip types from files under `node_modules`, so `pnpm build` (`scripts/build.ts`) transpiles the
workspace into one plain-JavaScript package, `tcm-ts`, in `dist/package`. Code tcm generates (`.tcm/cache`)
stays TypeScript, because it lives in the user's project. Publishing is done by hand.

`pnpm selfhost` makes the same package from the codebase with `tcm pack`, the step towards tcm being developed
in a codebase rather than in `packages/`.
