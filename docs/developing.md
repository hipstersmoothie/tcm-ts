# Developing ucm-ts

## Layout

```
packages/
  core/     extraction, canonicalization (the IR), hashing, runtime schemas from types, compiler options
  store/    the SQLite codebase store
  loader/   rendering stored definitions to .ucm/cache modules, running them, the #codebase shim
  cli/      the ucm command, placement inference, sync, merge, web (Vite plugin, dev/build/start), the
            #ucm/server runtime, the wire codec
scripts/    build.ts (npm package), selfhost.sh, test-package.sh, compare-ts-versions.sh
docs/       user documentation, one page per feature area
```

The `#ucm/server` runtime (`packages/cli/src/server-api.ts`) is one factory function whose own source is
written to `.ucm/cache/ucm-server.js`. It must stay self-contained: everything it uses comes in through its
`deps` parameter.

## Tests

| Command | |
|---|---|
| `pnpm test` | all suites: hashing invariants, frozen golden hashes, and end-to-end CLI scenarios (sync, merge, web apps in real Chrome, production, jobs, data, import) |
| `pnpm typecheck` | typecheck the repo |
| `pnpm selfhost` | the self-hosting check below |
| `pnpm test:package` | pack and install the npm package, then run every suite against the installed copy |
| `pnpm compare-ts 5.8` | re-hash the repo and the golden corpus on another TypeScript version; hashes must match |

All three of `pnpm test`, `pnpm selfhost` and `pnpm test:package` should pass before a commit.

## Self-hosting

`pnpm selfhost` imports `packages/` into `selfhost/.ucm` and then:

1. runs `ucm verify` with the **self-hosted** ucm: every definition round-trips to its own hash;
2. runs the whole test suite against the self-hosted CLI and analyzer (`UCM_BIN=selfhost/ucm.ts
   UCM_CORE=selfhost/core.ts`), which execute entirely from `.ucm/cache`;
3. checks the fixed point: the self-hosted ucm imports `packages/` again and assigns exactly the same hashes.

Getting there took two small refactors, both now enforced by the tool. A top-level `for` loop that filled a
lookup table became an immediately-invoked function, and the CLI's top-level `try` moved into an exported
`runCli`.

## Packaging

Node won't strip types from files under `node_modules`, so `pnpm build` (`scripts/build.ts`) transpiles the
workspace into one plain-JavaScript package, `ucm-ts`, in `dist/package`. Code ucm generates (`.ucm/cache`)
stays TypeScript, because it lives in the user's project. Publishing is done by hand.
