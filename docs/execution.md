# Storage and execution

## Storage

`packages/store` keeps everything in `.ucm/codebase.sqlite` (`node:sqlite`):

- definitions: canonical IR, the original source text, and the span of every reference in it;
- dependency edges, signatures, docs;
- names per branch, a name log (the reflog behind `history`/`reset`), patches and `todo`.

App data lives apart from the codebase in `.ucm/data/`: `store.sqlite` (tables), `sessions.sqlite`,
`jobs.sqlite`. It and secrets are gitignored.

## The generated cache

`packages/loader` turns each component into `.ucm/cache/<hash>.ts`:

- the stored source with the *current* names spliced into its reference spans;
- `import { h_<hash> as name } from "./<hash>.ts"` for dependencies, so modules import each other by hash;
- functions carry their hash at runtime (`Symbol.for("ucm.hash")`), so code can name them durably (jobs do);
- tables carry their row schema (`Symbol.for("ucm.schema")`).

Node runs these files with no build step. The cache and the `.ucm/codebase` shim are derived data: both are
rebuilt from the database, written only when their content changes.

Imported code that uses syntax Node can't strip (enums, namespaces, parameter properties) gets a
`// ucm: transform` first line. Processes ucm spawns load `.ucm/cache/ucm-transform.js`, a module hook that
compiles exactly those files; the ucm process registers the same hook in-process.

## npm packages

npm dependencies are installed into the cache under per-version aliases (`npm__pkg__1.2.3`), so pinned
versions coexist. Installs use `--ignore-scripts`. Only the direct `name@version` is part of a hash, not the
behaviour of transitive dependencies.

## Running code

`ucm run <name> [args]` materializes the definition's closure, writes a small runner and spawns Node on it.
Functions are called with the arguments; the result is awaited and printed if it isn't `undefined`.
`ucm run … --on <remote>` does the same on another machine ([sync](sync.md)).
