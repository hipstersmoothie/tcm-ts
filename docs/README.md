# ucm-ts documentation

ucm-ts keeps your TypeScript in a codebase where every definition is stored by the hash of its code, as
[Unison](https://www.unison-lang.org) does: renames are free, changes carry through or tell you, nothing gets
rebuilt. On top of that you can build web apps whose server and browser parts ucm connects for you.

New here? Read the [introduction](introduction.md), then follow [your first codebase](tutorial-codebase.md).

## Start

| Page | |
|---|---|
| [Introduction](introduction.md) | what ucm-ts is and why you'd use it |
| [Install](getting-started.md) | getting `ucm`, making a codebase, setting up your editor |
| [Tutorial: first codebase](tutorial-codebase.md) | write, add, change, rename, undo, test and document code (15 minutes) |
| [Tutorial: first app](tutorial-app.md) | a web app with a database, server and browser code, no API layer (10 minutes) |
| [Examples](../examples/README.md) | a complete live polling app |

## Guides

| Page | |
|---|---|
| [Scratch files](scratch-files.md) | the everyday loop: saving, changing, fixing what an update broke, renaming, undoing |
| [Packages](packages.md) | using npm packages and Node builtins; how versions are pinned |
| [Testing](testing.md) | writing tests, and why they only run when something changed |
| [Writing docs](documentation.md) | doc comments with links and runnable examples that follow your code |
| [Finding code](search.md) | by name, and by type |
| [Importing a project](importing.md) | bringing an existing TypeScript project into a codebase |
| [History and branches](history.md) | diffs, undo, branches and merging |
| [Sharing code](sync.md) | pushing and pulling between codebases, running code on another machine |
| [Web apps](apps.md) | how ucm splits an app between server and browser |
| [Server functions](server-api.md) | requests, cookies, sessions, errors, streaming, HTTP endpoints |
| [Data](data.md) | typed tables, queries, changing a table's shape, transactions |
| [Background jobs](jobs.md) | queued and recurring jobs |
| [Deploying](production.md) | production builds, deploying and rolling back by moving a name |
| [Editor](editors.md) | VS Code (and other editors): status, pages, apps, data |

## Reference

| Page | |
|---|---|
| [CLI](cli.md) | every command and flag |
| [#ucm/server](server-reference.md) | every function server code can import |
| [Files and folders](files.md) | what ucm creates, and what to keep in version control |
| [Compiler options](compiler-options.md) | which tsconfig settings ucm uses or overrides |

## How it works

| Page | |
|---|---|
| [Hashing](hashing.md) | what a definition is, how it's hashed, and identity |
| [Storage and execution](execution.md) | the store, the generated modules, how code runs |
| [Developing ucm-ts](developing.md) | the repository, its tests, self-hosting |
| [Limitations](limitations.md) | what isn't done yet |

These pages describe what the code does now; they're updated in the same change as the feature they describe
(see [AGENTS.md](../AGENTS.md)).
