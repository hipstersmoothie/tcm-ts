# Developing tcm-ts

## Layout

```
packages/
  core/     extraction, canonicalization (the IR), hashing, runtime schemas from types, compiler options
  store/    the SQLite codebase store
  loader/   rendering stored definitions to .tcm/cache modules, running them, the #codebase shim
  cli/      the tcm command, placement inference, sync, merge, web (Vite plugin, dev/build/start), the
            #tcm/server runtime, the wire codec
packages/editors/  vscode/: the VS Code extension (a thin client for `tcm lsp`; not part of the npm package), files of
            tcm's codebase (tcmts.editors, kept as written: a .tcm-files directory)
packages/examples/  polls, notes, geometry: example projects, files of tcm's codebase (tcmts.examples, kept as
            written: their directory has a .tcm-files mark), built by their setup scripts, run by e2e/examples.ts
scripts/    codebase.sh (`pnpm tcm`): verifying, the docs site and comparing compilers are definitions (packages/dev.ts)
packages/docs/  user documentation, one page per feature area: files of tcm's codebase (tcmts.docs)
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
| `pnpm verify` | everything a commit needs, from tcm's codebase ([below](#verifying-a-change)); names failing tests. When all pass, the package tested becomes the [known-good tcm](#the-known-good-tcm) |
| `pnpm test` | every test from source with `node:test`, through the runners beside them: hashing invariants, frozen golden hashes, and end-to-end CLI scenarios (sync, merge, web apps in real Chrome, production, jobs, data, import) |
| `pnpm typecheck` | typecheck the repo (TypeScript 7's `tsc`) |
| `pnpm docs:dev` | serve the docs site locally (port 4321, or the next free one), building it again and reloading open pages when a page or an example changes |
| `pnpm docs:site` | build the docs site (`tcmts.docs`, from the codebase, and the examples page) into `dist/site`; it fails on any broken link or anchor. A GitHub Actions workflow (`.github/workflows/docs.yml`) builds and deploys it to GitHub Pages on pushes to `main` |
| `pnpm compare-compilers` | hash tcm's source with TypeScript 7 and with [tsrs](compiler-options.md#the-compiler), and run the golden tests with tsrs; hashes must match (`tcmts.dev.compareCompilers`) |

`pnpm verify` should pass before a commit: it checks the codebase, its tests against its own tcm, and the
package packed from it, [below](#verifying-a-change).

tcm's tests are [test definitions](testing.md), in its own codebase like the code they test. Those that call code
directly (the core and store tests, the CLI's server-component and highlighting tests) are in
`packages/*/test/<name>.ts`, cached by hash: a change re-runs only the tests that reach it. The end-to-end tests,
which run tcm as a program, are in `packages/cli/test/e2e/<name>.ts` (helpers in `harness.ts`): they're the
`tcm-ts` package's [suites](testing.md#suites-testing-a-command-as-a-program), each run as a program of its own
against the codebase's own tcm and cached by the code it ran. A `<name>.test.ts` runner beside each file
registers its tests with `node:test` for `pnpm test`.

## Working on tcm in tcm

`pnpm tcm <command>` runs tcm on tcm's own codebase, in `codebase/` (not in git). The first run imports
`packages/` into it as a [mirror](importing.md#mirrors), with the tests, so changes made through tcm are written
back to `packages/`, and those edits are what's committed:

```sh
pnpm tcm edit tcmts.core.semver.compatRange    # into codebase/scratch.ts
pnpm tcm update                                # the codebase, its 200-odd dependents, and packages/core/src/semver.ts
pnpm tcm mv tcmts.core.semver.meetsComparator tcmts.core.semver.matchesComparator
pnpm tcm test tcmts                            # the tests and suites the change reaches, the rest cached
```

Agents work on tcm the same way: the repository's `.mcp.json` runs [`tcm mcp`](agents.md) on this codebase
(`pnpm tcm mcp`), so an MCP client opened in the repository gets tcm's tools and instructions.

Editing `packages/` directly still works, and so do git's changes to it (a pull, a checkout): the next
`pnpm tcm` command imports what changed first. Delete `codebase/` to start over from `packages/` (and if a newer
known-good tcm can't open it).

### The known-good tcm

The tcm doing the work isn't the one being changed. `pnpm tcm` (and so the MCP server) runs the build the last
passing `pnpm verify` tested, kept in `dist/known-good` (`VERIFIED` there says what it was made from). A change
that breaks tcm, even its mirror, can't break the tcm writing it to `packages/`, and a git checkout doesn't change
the tcm that's running. `pnpm verify` replaces it when everything passes.

The code being changed is what runs everywhere else: `tcm test tcmts` runs the codebase's own test definitions,
and its end-to-end tests as [suites](testing.md#suites-testing-a-command-as-a-program) against the codebase's own
tcm (`tcmts.cli.test.e2e`, in `packages/cli/test/e2e/`), each only if code it ran changed. And `TCM_LIVE=1 pnpm tcm <command>` runs `packages/` as it is, to try a change before verifying it. Before
the first `pnpm verify`, there's no known-good build, and `pnpm tcm` says so and runs `packages/`.

## Verifying a change

`pnpm verify` is `pnpm tcm run tcmts.dev.verify`: a definition in tcm's codebase (`packages/dev.ts`), run with
the codebase's own tcm, which `tcm run` gives it as `TCM_BIN`. It checks, printing each stage's result and time:

1. **codebase**: nothing needs fixing (`tcm todo`), and every definition renders and re-hashes to itself
   (`tcm verify`);
2. **files**, while the codebase is mirrored to `packages/`: the files hash to what it holds (`tcm mirror
   --check`: the fixed point, this tcm reading its own source as the codebase it is), and typecheck (`tsc`);
3. **tests**: `tcm test tcmts`, the test definitions and the end-to-end tests, each run against this tcm;
4. **docs**: the docs site builds from the codebase's pages, every link and anchor resolving;
5. **package**: the `tcm-ts` package packed from the codebase installs (into `dist/candidate`), works far from
   the repository (it makes a codebase in a temporary directory), and passes the end-to-end tests too
   (`tcm test --bin tcm=<it>`).

Tests run again only where code they ran changed, against each build, so a small change verifies in well under a
minute; one that every test runs (the `Codebase` class, say) takes a few. When everything passes, the package
becomes the [known-good tcm](#the-known-good-tcm).

Getting tcm to run from its own codebase took two small refactors, both now enforced by the tool. A top-level
`for` loop that filled a lookup table became an immediately-invoked function, and the CLI's top-level `try`
moved into an exported `runCli`. Running from a codebase also means a module's exports are named by hash, so
code that tells another process where to import something from says which export too: `transpileModule()` gives
the module hook its URL and export name (a function in a codebase carries its hash at runtime, and the hash names
its export).

## Packaging

`tcm-ts`, the npm package, is a [package](publishing.md#packages) of tcm's own codebase: its manifest is
`packages/index.ts` (the `tcm` and `tcm-ts` bins run `tcmts.cli.main.runCli`, `tcm-ts/core` exports the
analyzer). `pnpm build` packs it into `dist/package` from tcm's codebase (`codebase/`, its releases made again from git
when it was made), with dependencies pinned at the codebase's locked versions. At a release it's that
release; otherwise it's the code as it is, as `0.0.0`.

Releasing is [`tcm release`](releases.md), in tcm's codebase, from committed files:

```sh
pnpm tcm release check tcm-ts      # the next version, from the semver checks on tcm-ts's API
pnpm tcm release tcm-ts --draft    # codebase/release-tcm-ts.md: write a summary above the marker
pnpm tcm release tcm-ts            # records it in packages/tcm-releases.json
pnpm tcm changelog tcm-ts --out ../CHANGELOG.md
git commit -am "tcm-ts 0.1.0" && pnpm build && (cd dist/package && npm publish)
```

The release is [kept in git](releases.md#releases-kept-in-git): any clone's codebase makes it again. Publishing is
done by hand.
