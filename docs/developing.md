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
scripts/    build.ts (npm package), docs-site.ts, docs-dev.ts, selfhost.sh, test-package.sh, compare-ts-versions.sh
docs/       user documentation, one page per feature area
```

The command line is declared once, in `packages/cli/src/commands.ts`: each command's arguments and options as a
[@bomb.sh/router](https://bomb.sh) route tree, parsed into a typed model per command. `tcm help`, `--help`,
usage errors and shell completion ([@bomb.sh/tab](https://bomb.sh)) are all read from those definitions, and
prompts at a terminal use [@clack/prompts](https://bomb.sh) (`ui.ts`).

The `#tcm/server` runtime (`packages/cli/src/server-api.ts`) is one factory function whose own source is
written to `.tcm/cache/tcm-server.js`. It must stay self-contained: everything it uses comes in through its
`deps` parameter.

## Tests

| Command | |
|---|---|
| `pnpm test` | all suites: hashing invariants, frozen golden hashes, and end-to-end CLI scenarios (sync, merge, web apps in real Chrome, production, jobs, data, import) |
| `pnpm typecheck` | typecheck the repo |
| `pnpm selfhost` | the self-hosting check below |
| `pnpm test:package` | pack and install the npm package, then run every suite against the installed copy |
| `pnpm docs:dev` | serve the docs site locally (port 4321, or the next free one), rebuilding and reloading open pages when `docs/` or `examples/` change |
| `pnpm docs:site` | build the docs site (`docs/*.md` and the examples page) into `dist/site`; it fails on any broken link or anchor. A GitHub Actions workflow (`.github/workflows/docs.yml`) builds and deploys it to GitHub Pages on pushes to `main` |
| `pnpm compare-ts 5.8` | re-hash the repo and the golden corpus on another TypeScript version; hashes must match |

All three of `pnpm test`, `pnpm selfhost` and `pnpm test:package` should pass before a commit.

## Self-hosting

`pnpm selfhost` imports `packages/` into `selfhost/.tcm` and then:

1. runs `tcm verify` with the **self-hosted** tcm: every definition round-trips to its own hash;
2. runs the whole test suite against the self-hosted CLI and analyzer (`TCM_BIN=selfhost/tcm.ts
   TCM_CORE=selfhost/core.ts`), which execute entirely from `.tcm/cache`;
3. checks the fixed point: the self-hosted tcm imports `packages/` again and assigns exactly the same hashes;
4. makes tcm's npm package from the codebase with [`tcm pack`](publishing.md) (the `tcm` bins run
   `tcmts.cli.main.runCli`, and `tcm-ts/core` exports the analyzer), installs it and runs code with it. The
   whole suite passes against that package too (`TCM_BIN=<it>/bin/tcm.js TCM_CORE=<it>/core/index.js`; the
   script prints where it is).

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
