# tcm-ts

**tcm**, the TypeScript codebase manager: [Unison](https://www.unison-lang.org)'s codebase model (its `ucm`) for
plain TypeScript. Definitions are stored by the hash of their syntax tree, and names are only pointers to
hashes. So renames are free, nothing gets rebuilt,
and two versions of a dependency can live side by side. You don't need new syntax: any erasable TypeScript
file works as input, and Node runs the result directly through its built-in type stripping.

Requires Node ≥ 22.18 (tested on 24.15). Everything else comes with it, or is installed when your code first
needs it.

```sh
# from a checkout: build the npm package and install it globally
pnpm install && pnpm build
npm install -g "$(cd dist/package && npm pack --silent)"   # binaries: tcm and tcm-ts

mkdir demo && cd demo
tcm init          # .tcm/codebase.sqlite, package.json "#codebase" imports, tsconfig, scratch.ts
tcm               # watch: typecheck + hash scratch files, evaluate bare expressions
tcm add           # save new definitions from scratch.ts
```

## What's in it

- **A content-addressed codebase.** Scratch files are ordinary TypeScript. `tcm add`/`update` store
  definitions by hash; updates re-hash dependents automatically, and what stops typechecking goes to `todo`.
  [Getting started](docs/getting-started.md) · [hashing](docs/hashing.md) · [CLI](docs/cli.md)
- **Editor integration.** The codebase in a VS Code sidebar, pages for definitions and namespaces (rendered docs,
  linked source, uses and used-by), one finder for names, docs and types, apps you can start, a table viewer;
  in scratch files, each definition's status with Add/Update actions and watch values inline. `tcm lsp` serves
  it (also for Neovim and Helix). [Editors](docs/editors.md)
- **Docs that can't go stale.** JSDoc links, embeds and ```` ```ts ```` examples are resolved to hashes: they
  follow renames and updates, examples are evaluated, and `update` reports the ones that break.
  [Docs](docs/documentation.md)
- **Tests with Vitest, with nothing to set up.** A test is a definition, cached by hash; it runs in Node, or in
  Chrome when it renders a component. [Testing](docs/testing.md)
- **Linting and formatting with nothing to set up.** oxlint, with plugins for what the code uses and findings
  cached by hash; oxfmt, which never changes a hash, so stored code is always formatted. Both are configured by a
  definition (`lint.config`, `fmt.config`). [Linting](docs/linting.md) · [formatting](docs/formatting.md)
- **Search by type,** as in Unison: `tcm find ':(xs: T[]) => T'` finds matches up to renaming, reordered
  arguments, `async` results, and more general or specific types. [Search](docs/search.md)
- **Real projects import as they are.** neverthrow, ts-pattern and valibot import, verify and run.
  [Importing](docs/importing.md)
- **History by meaning, as Unison keeps it.** History entries are hashed namespaces with parents, the same in
  every codebase; diffs ignore renames and reformatting; merges go by history; undo anything.
  [History and merging](docs/history.md)
- **Releases with versions and changelogs that can't be wrong.** Any number of packages per codebase; each
  release's version comes from semver checks of what changed in the package's API (in the manner of
  cargo-semver-checks), and its notes list those changes, so the changelog writes itself.
  [Releases](docs/releases.md) · [publishing](docs/publishing.md)
- **Contributions.** Propose a branch with `tcm contribute`, review it as a diff of definitions (in the terminal
  or on `tcm serve`'s review page), comment, and merge it on the server. [Contributions](docs/contributions.md)
- **Sync and remote execution by hash.** Push, pull and `run --on` send only missing hashes, and received
  code is re-verified, never trusted. [Sync](docs/sync.md)
- **Browser apps with no network boundary to write.** Placement is inferred from what code uses; server
  functions are called by hash, so there's no client/server version skew. [Apps](docs/apps.md) ·
  [server API](docs/server-api.md)
- **React server components with no directives.** Async components and ones that read tables render on the
  server; ones with state or handlers in the browser. No `"use client"`, no `"use server"`. Pages render on the
  server first and stream `<Suspense>` boundaries. [React](docs/react.md)
- **Typed tables that never silently disagree with your code,** with typed migration chains, indexes,
  atomic updates and transactions. [Data](docs/data.md)
- **Background jobs pinned to the code that enqueued them,** plus cron schedules. [Jobs](docs/jobs.md)
- **Deploy and roll back by moving a name;** old tabs keep working. [Production](docs/production.md)
- **Self-hosting:** tcm-ts imports, verifies and runs its own source at a fixed point.
  [Developing](docs/developing.md)

New here? Read the [introduction](docs/introduction.md), then follow the tutorials:
[your first codebase](docs/tutorial-codebase.md) and [your first web app](docs/tutorial-app.md). Or try the
[examples](examples/README.md): `examples/polls/setup.sh /tmp/polls`, the React one
(`examples/notes/setup.sh /tmp/notes`), or packages with their releases and changelogs
(`examples/geometry/setup.sh /tmp/geometry`).

All documentation: [docs/](docs/README.md), also at [hipstersmoothie.github.io/tcm-ts](https://hipstersmoothie.github.io/tcm-ts/). Open items: [limitations](docs/limitations.md).
