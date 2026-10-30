# AGENTS.md

tcm-ts is Unison's content-addressed codebase model for plain TypeScript, plus an app platform on top
(inferred client/server placement, server functions, jobs, typed tables). Its docs are pages of its codebase:
start with `tcmts.docs.README` (tcm_view, or the docs site at https://tcm-server-production.up.railway.app);
`tcmts.docs.developing` has the codebase's layout.

## Working in tcm's codebase

tcm is developed in its own codebase, and nowhere else: this repository only says how to get it (`pnpm tcm` makes
`codebase/` from tcm's server). There are no source files to edit.
With the tcm MCP server (this repository's `.mcp.json`), use its tools: tcm_status to start, tcm_find, tcm_view and
tcm_at to read, tcm_patch for a small change, tcm_edit then tcm_update for a bigger one, tcm_todo, tcm_test. Without
it, `pnpm tcm <command>` is the CLI. The tcm doing this is the last build `pnpm verify` passed, not the code being
changed: tcm_test tests the change, `TCM_LIVE=1 pnpm tcm …` runs it (from the codebase).

## Keep the docs current

`tcmts.docs` documents every user-visible feature, one page per area (index in `tcmts.docs.README`). It describes
what the code does *now*. Pages are files of the codebase: `tcm_edit tcmts.docs.cli` writes `cli.md` to change and
save with `tcm_update`.

- **Every change that adds, changes or removes user-visible behaviour updates the docs with it:** a command, flag,
  API, error message users act on, guarantee or limitation.
- **Put it on the page for its area.** A new area gets a new page, listed in the `tcmts.docs.README` index (and in
  the README's feature list, `tcmts.README`, if it's a headline feature).
- **New CLI commands or flags** also go in `tcmts.docs.cli` and the command definitions in `tcmts.cli.commands`
  (`tcm help`, `--help` and shell completion read them).
- **Fixed or newly found limits** are updated in `tcmts.docs.limitations`.
- **Check claims against the code**, not memory or older docs. Remove what's no longer true.
- **The README stays short:** a pitch, quick start, and links into the docs.
- **The examples (`tcmts.examples`) must keep working.** `tcmts.cli.test.e2e.examples` builds and runs them; when a
  feature changes how code is written, update the examples too.

## Verifying a change

Run `pnpm verify` when a change is done; it names any failing tests. It's a definition in tcm's codebase
(`tcmts.dev.verify`, run with `pnpm tcm run`): it checks the codebase (`tcm todo`, `tcm verify`), runs its tests
against its own tcm, builds the docs site, and packs tcm-ts and runs the end-to-end tests against that. Tests run
again only where code they ran changed, so it takes a minute to a few.

`pnpm test` (`tcm test`) runs the tests the change reaches: the quick check while working.

New behaviour gets a test, written as test definitions (`export const testX = () => …`). End-to-end tests, running
tcm as a program, go in `tcmts.cli.test.e2e` (helpers in `tcmts.cli.test.e2e.harness`; each test independent, since
each runs as a program of its own, cached by the code it ran); what they need as files they import from the
codebase (`tcmts.fixtures`). Tests that call code directly go in a `test` namespace beside the code, cached by hash.

## Rules

- **Hashes are pinned.** The hash format (v1, `IR_VERSION` in `tcmts.core.hash`) is pinned by
  `tcmts.core.test.golden`; `tcmts.core.slots` (the order the IR visits children in) is part of it. Change hashes
  only on purpose: bump `IR_VERSION` and re-pin. tcm is v0 with no codebases to keep, so there's no migration code:
  don't add compatibility for old codebases or formats. History hashes (namespaces and causals, which codebases
  compare when they sync) are pinned the same way by `tcmts.store.test.history`.
- **`tcmts.cli.server_api.createServerApi` must stay self-contained:** its source is written to
  `.tcm/cache/tcm-server.js`, so it can only use what comes in through `deps`.
- **No explicit client/server boundaries** (no `"use server"`): placement is inferred.
- **Follow Unison's design** where it applies; it doesn't cover frontend, so there we decide.
- **Prefer Vite** for browser tooling.

## History

- tcm's history is the record of changes (`tcm history`): each command that changes names is an entry. Keep each
  change to one thing, and say what and why where it's asked (a release's notes, a contribution).
- The repository's own few files (README, AGENTS.md, package.json, scripts/codebase.sh) are written from the
  codebase by `pnpm repository`; commit them when they change, ending the message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` when an agent wrote the change.
- Never push (`tcm push` or git) or publish; that's done by hand.
