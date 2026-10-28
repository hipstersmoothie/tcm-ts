# CLI reference

`tcm help` prints the same list in short form.

## Codebase

| Command | |
|---|---|
| `tcm init` | set up a codebase here: `.tcm/codebase.sqlite`, `package.json` `#codebase` imports, `tsconfig.json`, `scratch.ts` |
| `tcm` / `tcm watch [--fresh]` | watch `*.ts` scratch files: typecheck, hash, report, evaluate watch expressions and tests. Their results are cached by hash; `--fresh` re-runs them |
| `tcm lsp` | language server for editors, over stdio ([editors](editors.md)) |
| `tcm check [file] [--fresh]` | one-shot version of watch. Reports each definition as `new` / `identical` / `update` / `alias` / `conflict` |
| `tcm add [file] [--into ns]` | save new definitions from a scratch file (default `scratch.ts`) |
| `tcm update [file] [--into ns]` | save, re-point changed names, and re-hash every dependent. Dependents that stop typechecking keep their old hash and go to `todo`. Also checks stored table rows against changed row types ([data](data.md)) |
| `tcm import <dir> [--into ns] [--update] [--exclude a,b] [--verbose]` | add an existing project, one namespace per file ([importing](importing.md)) |
| `tcm edit <name>... [--file f] [--force]` | write definitions to a scratch file for editing (`scratch.ts`, or `scratch.tsx` for JSX), with references following any updates |
| `tcm view <name\|#hash>...` | show definitions, rendered with current names, with their placement for app code |
| `tcm ls [namespace]` | list names |
| `tcm find <query>` | search names and signature text |
| `tcm find ':<type>'` | search by type: `':(xs: T[]) => T'`; unknown names are type variables ([search](search.md)) |
| `tcm deps <name>` / `tcm dependents <name>` | what a definition uses / what uses it |
| `tcm docs <name>` | show a definition's documentation, rendered: links and embeds with current names, examples evaluated ([docs](documentation.md)) |
| `tcm run <name> [args...]` | run a definition. Functions are called with the args; the result is awaited and printed |
| `tcm mv <from> <to>` | rename a definition or namespace (no code changes) |
| `tcm alias <name> <new>` | add another name for a definition |
| `tcm rm <name> [--force]` | remove a name. If it's the definition's last name and named definitions use it, refuses unless `--force` (they keep working either way) |
| `tcm todo` | conflicts, plus dependents that need fixing after an update |
| `tcm lint [namespace] [--fresh]` | lint definitions with oxlint, cached by hash ([linting](linting.md)) |
| `tcm packages` | the npm packages the codebase runs: range, locked version, what uses them ([packages](packages.md)) |
| `tcm upgrade <pkg> [--force]` | newest versions within the ranges in use (and of what's built against it); no hashes change, everything using them is re-checked |
| `tcm upgrade <pkg>@<range\|latest> [namespace]` | re-pin code to another range: re-hashed, dependents follow |
| `tcm resolve <name> <#hash>` | pick one definition for a conflicted name |
| `tcm test [namespace] [--fresh]` | run tests, cached by hash ([testing](testing.md)) |
| `tcm verify` | re-render and re-hash every live definition; must be the identity ([hashing](hashing.md)) |
| `tcm migrate` | rebuild a codebase written with an older hash format. Names, history, branches, patches, todo and remotes carry over; the old `.tcm` is kept as a backup |

## History and branches

See [history, branches and merging](history.md).

| Command | |
|---|---|
| `tcm diff` | what the last command changed: edits, dependents re-hashed by them, renames |
| `tcm diff <id> \| <branch> \| <a> <b>` | changes since a history entry, to another branch, or between branches |
| `tcm history [n]` / `tcm reset <id>` | name changes on this branch / undo back to an entry |
| `tcm branch [name]` / `tcm switch <name>` | list or create branches / switch |
| `tcm merge <branch>` | three-way merge into this branch |

## Sync and remote execution

See [sync](sync.md).

| Command | |
|---|---|
| `tcm remote [add <name> <url\|dir> [--token t] [--fingerprint sha256] \| rm <name>]` | manage remotes: a `tcm serve` URL or another codebase directory |
| `tcm push [remote] [--as branch] [--force]` | send definitions the remote lacks, plus this branch's names. Refuses if the remote moved since your last sync |
| `tcm pull [remote] [branch]` | fetch into `<remote>/<branch>`; fast-forward this branch if you haven't changed it, merge otherwise |
| `tcm run <name> [args] --on <remote\|url\|dir>` | send what the remote lacks, run there, stream stdout/stderr back |
| `tcm serve [--port 7737] [--host 127.0.0.1] [--token t] [--no-run] [--tls [--tls-cert f --tls-key f]] [--insecure]` | serve this codebase over HTTP(S) |

## Apps, data and jobs

See [browser apps](apps.md), [production](production.md), [data](data.md) and [jobs](jobs.md).

| Command | |
|---|---|
| `tcm dev <app> [--port 5173] [--http <namespace>[=/prefix]]` | serve a browser app from the codebase with hot reload; `<app>` is a function run on load, or a React component rendered into the page |
| `tcm build <app> [--force]` | immutable production build into `.tcm/apps/<hash>/` (reused if it exists) |
| `tcm start <app> [--port 8080] [--host] [--tls] [--keep N] [--http <namespace>[=/prefix]]` | serve in production, following the app's name |
| `tcm apps [prune [--keep 3]]` | list builds (`*` = current); prune keeps the current build plus the newest N others |
| `tcm data [table [n]]` | typed tables: row counts, or a table's newest rows |
| `tcm data migrate <table>` | upgrade every stored row to the current row type now, through `migrate` |
| `tcm jobs [n] \| retry <id> \| cancel <id>` | list background jobs, or act on one |
