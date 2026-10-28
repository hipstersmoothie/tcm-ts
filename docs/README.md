# ucm-ts documentation

ucm-ts applies [Unison](https://www.unison-lang.org)'s codebase model to plain TypeScript. Definitions are
stored by the hash of their syntax tree, and names are only pointers to hashes. On top of that sits an app
platform: browser apps with inferred client/server placement, server functions, background jobs and typed
tables.

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | install, `ucm init`, scratch files, the watcher, adding and updating |
| [CLI reference](cli.md) | every command and flag |
| [Searching](search.md) | `ucm find` by name, and by type the way Unison does |
| [Definitions and hashing](hashing.md) | what a definition is, how it's hashed, identity, the frozen IR format |
| [Storage and execution](execution.md) | the SQLite store, the generated cache, npm packages, running code |
| [Compiler options](compiler-options.md) | which tsconfig options are used or forced, check profiles |
| [Importing existing projects](importing.md) | `ucm import`, what import mode accepts, projects verified so far |
| [Testing](testing.md) | `ucm test`, caching by hash, testing server code in one process |
| [History, branches and merging](history.md) | `diff`, `history`/`reset`, branches, three-way `merge`, `todo` |
| [Sync and remote execution](sync.md) | remotes, `push`/`pull`, `serve`, `run --on`, why received code is verified |
| [Browser apps](apps.md) | `ucm dev`, placement inference, the wire format, argument checking, CSRF |
| [Server API](server-api.md) | `#ucm/server`: request context, cookies, sessions, rate limits, streaming, HTTP routes |
| [Data: typed tables](data.md) | tables, migrations, queries and indexes, `update`, transactions, `ucm data` |
| [Background jobs](jobs.md) | `enqueue`, schedules, `ucm jobs` |
| [Production](production.md) | `ucm build`/`start`, deploying and rolling back by moving a name, pruning |
| [Developing ucm-ts](developing.md) | repo layout, test suites, self-hosting, packaging |
| [Limitations](limitations.md) | what isn't done yet |

These pages describe what the code does now. They're updated in the same commit as the feature they describe
(see [AGENTS.md](../AGENTS.md)).
