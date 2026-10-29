# tcm-ts documentation

tcm-ts keeps your TypeScript in a codebase where every definition is stored by the hash of its code, as
[Unison](https://www.unison-lang.org) does: renames are free, changes carry through or tell you, nothing gets
rebuilt. On top of that you can build web apps whose server and browser parts tcm connects for you.

New here? Read the [introduction](introduction.md), then follow [your first codebase](tutorial-codebase.md).

## Start

| Page | |
|---|---|
| [Introduction](introduction.md) | what tcm-ts is and why you'd use it |
| [Install](getting-started.md) | getting `tcm`, making a codebase, setting up your editor |
| [Tutorial: first codebase](tutorial-codebase.md) | write, add, change, rename, undo, test and document code (15 minutes) |
| [Tutorial: first app](tutorial-app.md) | a web app with a database, server and browser code, no API layer (10 minutes) |
| [Examples](../examples/README.md) | a live polling app, and a React notes app with server components |

## Guides

| Page | |
|---|---|
| [Scratch files](scratch-files.md) | the everyday loop: saving, changing, fixing what an update broke, renaming, undoing |
| [Packages](packages.md) | using npm packages and Node builtins; how versions are pinned |
| [Testing](testing.md) | tests with Vitest, in Node or a browser; why they only run when something changed |
| [Linting](linting.md) | oxlint with nothing to set up; configuring it, plugins |
| [Debugging](debugging.md) | stack traces and breakpoints in the code you read, not generated modules |
| [Formatting](formatting.md) | oxfmt with nothing to set up; restyling stored code without changing a hash |
| [Writing docs](documentation.md) | doc comments with links and runnable examples that follow your code |
| [Finding code](search.md) | by name, and by type |
| [Importing a project](importing.md) | bringing an existing TypeScript project into a codebase |
| [History and branches](history.md) | diffs, undo, branches and merging |
| [Sharing code](sync.md) | pushing and pulling between codebases, running code on another machine |
| [Contributions](contributions.md) | proposing a branch, reviewing it as definitions, commenting, merging on the server |
| [Publishing to npm](publishing.md) | packages in a codebase (`manifest`), and `tcm pack`: an npm package with types, bins and dependencies |
| [Releases and changelogs](releases.md) | versions from semver checks of the API, release notes and changelogs written from the codebase |
| [Web apps](apps.md) | how tcm splits an app between server and browser |
| [React](react.md) | components, and server components without `"use client"` or `"use server"` |
| [Server functions](server-api.md) | requests, cookies, sessions, errors, streaming, HTTP endpoints |
| [Data](data.md) | typed tables, queries, changing a table's shape, transactions |
| [Background jobs](jobs.md) | queued and recurring jobs |
| [Deploying](production.md) | production builds, deploying and rolling back by moving a name |
| [Editor](editors.md) | VS Code (and other editors): status, pages, apps, data |

## Reference

| Page | |
|---|---|
| [CLI](cli.md) | every command and flag |
| [#tcm/server](server-reference.md) | every function server code can import |
| [Files and folders](files.md) | what tcm creates, and what to keep in version control |
| [Compiler options](compiler-options.md) | which tsconfig settings tcm uses or overrides |

## How it works

| Page | |
|---|---|
| [Hashing](hashing.md) | what a definition is, how it's hashed, and identity |
| [Storage and execution](execution.md) | the store, the generated modules, how code runs |
| [Developing tcm-ts](developing.md) | the repository, its tests, self-hosting |
| [Limitations](limitations.md) | what isn't done yet |

These pages describe what the code does now; they're updated in the same change as the feature they describe
(see [AGENTS.md](../AGENTS.md)).
