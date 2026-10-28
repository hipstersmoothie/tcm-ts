# AGENTS.md

tcm-ts is Unison's content-addressed codebase model for plain TypeScript, plus an app platform on top
(inferred client/server placement, server functions, jobs, typed tables). Start with
[docs/README.md](docs/README.md); [docs/developing.md](docs/developing.md) has the repo layout.

## Keep the docs current

`docs/` documents every user-visible feature, one page per area (index in `docs/README.md`). It describes what
the code does *now*.

- **Every change that adds, changes or removes user-visible behaviour updates `docs/` in the same commit:** a
  command, flag, API, error message users act on, guarantee or limitation.
- **Put it on the page for its area.** A new area gets a new page, listed in the `docs/README.md` index (and in
  the README's feature list if it's a headline feature).
- **New CLI commands or flags** also go in `docs/cli.md` and the `tcm help` text in `packages/cli/src/main.ts`.
- **Fixed or newly found limits** are updated in `docs/limitations.md`.
- **Check claims against the code**, not memory or older docs. Remove what's no longer true.
- **The README stays short:** a pitch, quick start, and links into `docs/`.
- **`examples/` must keep working.** `packages/cli/test/examples.test.ts` builds and runs them; when a feature
  changes how code is written, update the examples too.

## Verifying a change

Run all three before committing; each takes a few minutes:

```sh
pnpm typecheck
pnpm test           # every suite
pnpm selfhost       # tcm-ts imports and verifies its own source, runs the suites from it, checks the fixed point
pnpm test:package   # the suites against the packed npm package
```

New behaviour gets a test in `packages/cli/test/` (end-to-end, through the CLI) or `packages/core/test/`.

## Rules

- **Hashes are frozen.** The IR format (v5) is pinned by `packages/core/test/golden.test.ts`. Never change what
  a definition hashes to without a format bump and `tcm migrate` support.
- **`packages/cli/src/server-api.ts`'s `createServerApi` must stay self-contained:** its source is written to
  `.tcm/cache/tcm-server.js`, so it can only use what comes in through `deps`.
- **No explicit client/server boundaries** (no `"use server"`): placement is inferred.
- **Follow Unison's design** where it applies; it doesn't cover frontend, so there we decide.
- **Prefer Vite** for browser tooling.

## Git

- Commit per feature, with a message explaining what and why.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` when an agent wrote the change.
- Never push or publish; that's done by hand.
