# Storage and execution

## Storage

`store` keeps everything in `.tcm/codebase.sqlite` (`node:sqlite`):

- definitions: canonical IR, the original source text, and the span of every reference in it;
- dependency edges, signatures, docs;
- names per branch, and their [history](history.md): namespace nodes, causals (entries) and each branch's head,
  plus a log of every name change; patches and `todo`.

App data lives apart from the codebase in `.tcm/data/`: `store.sqlite` (tables), `sessions.sqlite`,
`jobs.sqlite`. It and secrets are gitignored.

## The generated cache

`loader` turns each component into `.tcm/cache/<hash>.ts`:

- the stored source with the *current* names spliced into its reference spans;
- `import { h_<hash> as name } from "./<hash>.ts"` for dependencies, so modules import each other by hash;
- functions carry their hash at runtime (`Symbol.for("tcm.hash")`), so code can name them durably (jobs do);
- tables carry their row schema (`Symbol.for("tcm.schema")`).

Node runs these files with no build step. The cache and the `.tcm/codebase` shim are derived data: both are
rebuilt from the database, written only when their content changes.

Imported code that uses syntax Node can't strip (enums, namespaces, parameter properties) gets a
`// tcm: transform` first line. Processes tcm spawns load `.tcm/cache/tcm-transform.js`, a module hook that
compiles exactly those files; the tcm process registers the same hook in-process.

## npm packages

npm dependencies are installed into the cache under per-version aliases (`npm__pkg__1.2.3`), so pinned
versions coexist. Installs use `--ignore-scripts`. Only the direct `name@version` is part of a hash, not the
behaviour of transitive dependencies.

## Running code

`tcm run <name> [args]` materializes the definition's closure, writes a small runner and spawns Node on it.
Functions are called with the arguments; the result is awaited and printed if it isn't `undefined`. What it starts
can run the codebase's own commands (its packages' `bin`s), named in `<COMMAND>_BIN` (`TCM_BIN` for `tcm`), as
[suites](testing.md#suites-testing-a-command-as-a-program) do.
`tcm run … --on <remote>` does the same on another machine ([sync](sync.md)).
