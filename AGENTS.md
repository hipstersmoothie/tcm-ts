# AGENTS.md

tcm-ts is Unison's content-addressed codebase model for plain TypeScript, plus an app platform on top
(inferred client/server placement, server functions, jobs, typed tables). Start with
[docs/README.md](packages/docs/README.md); [docs/developing.md](packages/docs/developing.md) has the repo layout.

## Working in tcm's codebase

tcm is developed in its own codebase, which mirrors `packages/` ([developing](packages/docs/developing.md#working-on-tcm-in-tcm)).
With the tcm MCP server (this repository's `.mcp.json`), use its tools: tcm_find and tcm_view to read,
tcm_edit then tcm_update to change, tcm_todo, tcm_test. Without it, `pnpm tcm <command>` is the CLI. Changes made
through tcm are written to `packages/`, which is what's committed. The tcm doing this is the last build `pnpm verify`
passed, not the code being changed: tcm_test tests the change, `TCM_LIVE=1 pnpm tcm …` runs it.

## Keep the docs current

`packages/docs/` documents every user-visible feature, one page per area (index in `packages/docs/README.md`). It describes what
the code does *now*. The pages are files of tcm's codebase (`tcmts.docs`): `tcm_edit tcmts.docs.cli` writes `cli.md` to
change and save with `tcm_update`; editing the file in `packages/docs/` works too.

- **Every change that adds, changes or removes user-visible behaviour updates `packages/docs/` in the same commit:** a
  command, flag, API, error message users act on, guarantee or limitation.
- **Put it on the page for its area.** A new area gets a new page, listed in the `packages/docs/README.md` index (and in
  the README's feature list if it's a headline feature).
- **New CLI commands or flags** also go in `packages/docs/cli.md` and the command definitions in `packages/cli/src/commands.ts`
  (`tcm help`, `--help` and shell completion read them).
- **Fixed or newly found limits** are updated in `packages/docs/limitations.md`.
- **Check claims against the code**, not memory or older docs. Remove what's no longer true.
- **The README stays short:** a pitch, quick start, and links into `packages/docs/`.
- **`packages/examples/` must keep working.** `packages/cli/test/e2e/examples.ts` builds and runs them; when a feature
  changes how code is written, update the examples too.

## Verifying a change

Run `pnpm verify` before committing; it names any failing tests. It's a definition in tcm's codebase
(`tcmts.dev.verify`, run with `pnpm tcm run`): it checks the codebase (`tcm todo`, `tcm verify`), that the files
hash to it and typecheck, runs its tests against its own tcm, and packs tcm-ts and runs the end-to-end tests
against that. Tests run again only where code they ran changed, so it takes seconds to a few minutes.

`pnpm test` runs the suites from source: the quick check while working.

New behaviour gets a test, written as test definitions (`export const testX = () => …`, in a `<name>.ts` with a
`<name>.test.ts` runner beside it, so `pnpm test` runs them too). End-to-end tests, running tcm as a program, go
in `packages/cli/test/e2e/` (helpers in `harness.ts`; each test independent, since in tcm's codebase each runs as
a program of its own, cached by the code it ran). Tests that call code directly go in `packages/*/test/`, cached
by hash.

## Rules

- **Hashes are pinned.** The hash format (v1, `IR_VERSION` in `packages/core/src/hash.ts`) is pinned by
  `packages/core/test/golden.test.ts`; `packages/core/src/slots.ts` (the order the IR visits children in) is part
  of it. Change hashes only on purpose: bump `IR_VERSION` and re-pin. tcm is v0 with no codebases to keep, so
  there's no migration code: don't add compatibility for old codebases or formats.
  History hashes (namespaces and causals, which codebases compare when they sync) are pinned the same way by
  `packages/store/test/history.test.ts`.
- **`packages/cli/src/server-api.ts`'s `createServerApi` must stay self-contained:** its source is written to
  `.tcm/cache/tcm-server.js`, so it can only use what comes in through `deps`.
- **No explicit client/server boundaries** (no `"use server"`): placement is inferred.
- **Follow Unison's design** where it applies; it doesn't cover frontend, so there we decide.
- **Prefer Vite** for browser tooling.

## Git

- Commit per feature, with a message explaining what and why.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` when an agent wrote the change.
- Never push or publish; that's done by hand.
