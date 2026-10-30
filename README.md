# tcm-ts

**tcm**, the TypeScript codebase manager: [Unison](https://www.unison-lang.org)'s codebase model (its `ucm`) for
plain TypeScript. Definitions are stored by the hash of their syntax tree, and names are only pointers to
hashes. So renames are free, nothing gets rebuilt,
and two versions of a dependency can live side by side. You don't need new syntax: any erasable TypeScript
file works as input, and Node runs the result directly through its built-in type stripping.

Requires Node ≥ 22.18 (tested on 24.15). Everything else comes with it, or is installed when your code first
needs it.

```sh
# tcm, as tcm's server runs it (binaries: tcm and tcm-ts)
curl -fsSLO https://tcm-server-production.up.railway.app/tcm-ts.tgz && npm install -g ./tcm-ts.tgz

mkdir demo && cd demo
tcm init          # .tcm/codebase.sqlite, package.json "#codebase" imports, tsconfig, scratch.ts
tcm               # watch: typecheck + hash scratch files, evaluate bare expressions
tcm add           # save new definitions from scratch.ts
```

## What's in it

- **A content-addressed codebase.** Scratch files are ordinary TypeScript. `tcm add`/`update` store
  definitions by hash; updates re-hash dependents automatically, and what stops typechecking goes to `todo`.
  [Getting started](https://tcm-server-production.up.railway.app/getting-started.html) · [hashing](https://tcm-server-production.up.railway.app/hashing.html) · [CLI](https://tcm-server-production.up.railway.app/cli.html)
- **AI agents work in it.** `tcm mcp` gives coding agents (Claude Code, Cursor, …) tools and instructions for the
  codebase's way of working: find, edit in a scratch file, update, fix what broke, test. `tcm init` sets it up.
  [Agents](https://tcm-server-production.up.railway.app/agents.html)
- **Editor integration.** The codebase in a VS Code sidebar, pages for definitions and namespaces (rendered docs,
  linked source, uses and used-by), one finder for names, docs and types, apps you can start, a table viewer;
  in scratch files, each definition's status with Add/Update actions and watch values inline. `tcm lsp` serves
  it (also for Neovim and Helix). [Editors](https://tcm-server-production.up.railway.app/editors.html)
- **Docs that can't go stale.** JSDoc links, embeds and ```` ```ts ```` examples are resolved to hashes: they
  follow renames and updates, examples are evaluated, and `update` reports the ones that break.
  [Docs](https://tcm-server-production.up.railway.app/documentation.html)
- **Tests with Vitest, with nothing to set up.** A test is a definition, cached by hash; it runs in Node, or in
  Chrome when it renders a component. [Testing](https://tcm-server-production.up.railway.app/testing.html)
- **Linting and formatting with nothing to set up.** oxlint, with plugins for what the code uses and findings
  cached by hash; oxfmt, which never changes a hash, so stored code is always formatted. Both are configured by a
  definition (`lint.config`, `fmt.config`). [Linting](https://tcm-server-production.up.railway.app/linting.html) · [formatting](https://tcm-server-production.up.railway.app/formatting.html)
- **Search by type,** as in Unison: `tcm find ':(xs: T[]) => T'` finds matches up to renaming, reordered
  arguments, `async` results, and more general or specific types. [Search](https://tcm-server-production.up.railway.app/search.html)
- **Real projects import as they are.** neverthrow, ts-pattern and valibot import, verify and run.
  [Importing](https://tcm-server-production.up.railway.app/importing.html)
- **History by meaning, as Unison keeps it.** History entries are hashed namespaces with parents, the same in
  every codebase; diffs ignore renames and reformatting; merges go by history; undo anything.
  [History and merging](https://tcm-server-production.up.railway.app/history.html)
- **Releases with versions and changelogs that can't be wrong.** Any number of packages per codebase; each
  release's version comes from semver checks of what changed in the package's API (in the manner of
  cargo-semver-checks), and its notes list those changes, so the changelog writes itself.
  [Releases](https://tcm-server-production.up.railway.app/releases.html) · [publishing](https://tcm-server-production.up.railway.app/publishing.html)
- **Contributions.** Propose a branch with `tcm contribute`, review it as a diff of definitions (in the terminal
  or on `tcm serve`'s review page), comment, and merge it on the server. [Contributions](https://tcm-server-production.up.railway.app/contributions.html)
- **Sync and remote execution by hash.** Push, pull and `run --on` send only missing hashes, and received
  code is re-verified, never trusted. [Sync](https://tcm-server-production.up.railway.app/sync.html)
- **Browser apps with no network boundary to write.** Placement is inferred from what code uses; server
  functions are called by hash, so there's no client/server version skew. [Apps](https://tcm-server-production.up.railway.app/apps.html) ·
  [server API](https://tcm-server-production.up.railway.app/server-api.html)
- **React server components with no directives.** Async components and ones that read tables render on the
  server; ones with state or handlers in the browser. No `"use client"`, no `"use server"`. Pages render on the
  server first and stream `<Suspense>` boundaries. [React](https://tcm-server-production.up.railway.app/react.html)
- **Typed tables that never silently disagree with your code,** with typed migration chains, indexes,
  atomic updates and transactions. [Data](https://tcm-server-production.up.railway.app/data.html)
- **Background jobs pinned to the code that enqueued them,** plus cron schedules. [Jobs](https://tcm-server-production.up.railway.app/jobs.html)
- **Deploy and roll back by moving a name;** old tabs keep working. [Production](https://tcm-server-production.up.railway.app/production.html)
- **Self-hosting:** tcm-ts is developed in tcm: all of it is in its own codebase, served by tcm's server, and
  this repository only says how to get it (`pnpm tcm`). It verifies itself, and its tests run against its own
  build. [Developing](https://tcm-server-production.up.railway.app/developing.html)

New here? Read the [introduction](https://tcm-server-production.up.railway.app/introduction.html), then follow the tutorials:
[your first codebase](https://tcm-server-production.up.railway.app/tutorial-codebase.html) and [your first web app](https://tcm-server-production.up.railway.app/tutorial-app.html). Or try the
[examples](https://tcm-server-production.up.railway.app/examples.html): polls, a React notes app, and packages with their releases and changelogs.

All documentation: [the docs site](https://tcm-server-production.up.railway.app/). Open items: [limitations](https://tcm-server-production.up.railway.app/limitations.html).
