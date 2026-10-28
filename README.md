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

mkdir demo && cd demo
ucm init          # .ucm/codebase.sqlite, package.json "#codebase" imports, tsconfig, scratch.ts
ucm               # watch: typecheck + hash scratch files, evaluate bare expressions
ucm add           # save new definitions from scratch.ts
```

## What's in it

- **A content-addressed codebase.** Scratch files are ordinary TypeScript. `ucm add`/`update` store
  definitions by hash; updates re-hash dependents automatically, and what stops typechecking goes to `todo`.
  [Getting started](docs/getting-started.md) · [hashing](docs/hashing.md) · [CLI](docs/cli.md)
- **Editor integration.** `ucm lsp` shows each definition's codebase status with Add/Update actions, watch
  values inline and hovers with hashes and placement, in VS Code (`editors/vscode`), Neovim or Helix.
  [Editors](docs/editors.md)
- **Search by type,** as in Unison: `ucm find ':(xs: T[]) => T'` finds matches up to renaming, reordered
  arguments, `async` results, and more general or specific types. [Search](docs/search.md)
- **Real projects import as they are.** neverthrow, ts-pattern and valibot import, verify and run.
  [Importing](docs/importing.md)
- **History by meaning.** Diffs ignore renames and reformatting; three-way merge of names; undo anything.
  [History and merging](docs/history.md)
- **Sync and remote execution by hash.** Push, pull and `run --on` send only missing hashes, and received
  code is re-verified, never trusted. [Sync](docs/sync.md)
- **Browser apps with no network boundary to write.** Placement is inferred from what code uses; server
  functions are called by hash, so there's no client/server version skew. [Apps](docs/apps.md) ·
  [server API](docs/server-api.md)
- **Typed tables that never silently disagree with your code,** with typed migration chains, indexes,
  atomic updates and transactions. [Data](docs/data.md)
- **Background jobs pinned to the code that enqueued them,** plus cron schedules. [Jobs](docs/jobs.md)
- **Deploy and roll back by moving a name;** old tabs keep working. [Production](docs/production.md)
- **Self-hosting:** ucm-ts imports, verifies and runs its own source at a fixed point.
  [Developing](docs/developing.md)

All documentation: [docs/](docs/README.md). Open items: [limitations](docs/limitations.md).
