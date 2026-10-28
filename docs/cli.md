# CLI reference

`ucm help` prints the same list in short form.

## Codebase

| Command | |
|---|---|
| `ucm init` | set up a codebase here: `.ucm/codebase.sqlite`, `package.json` `#codebase` imports, `tsconfig.json`, `scratch.ts` |
| `ucm` / `ucm watch` | watch `*.ts` scratch files: typecheck, hash, report, evaluate watch expressions and tests |
| `ucm check [file]` | one-shot version of watch. Reports each definition as `new` / `identical` / `update` / `alias` / `conflict` |
| `ucm add [file] [--into ns]` | save new definitions from a scratch file (default `scratch.ts`) |
| `ucm update [file] [--into ns]` | save, re-point changed names, and re-hash every dependent. Dependents that stop typechecking keep their old hash and go to `todo`. Also checks stored table rows against changed row types ([data](data.md)) |
| `ucm import <dir> [--into ns] [--update] [--exclude a,b] [--verbose]` | add an existing project, one namespace per file ([importing](importing.md)) |
| `ucm edit <name>... [--file f] [--force]` | write definitions to a scratch file for editing, with references following any updates |
| `ucm view <name\|#hash>...` | show definitions, rendered with current names, with their placement for app code |
| `ucm ls [namespace]` | list names |
| `ucm find <query>` | search names and signatures; `:query` searches signatures only (as text) |
| `ucm deps <name>` / `ucm dependents <name>` | what a definition uses / what uses it |
| `ucm docs <name>` | show a definition's documentation (its leading JSDoc) |
| `ucm run <name> [args...]` | run a definition. Functions are called with the args; the result is awaited and printed |
| `ucm mv <from> <to>` | rename a definition or namespace (no code changes) |
| `ucm alias <name> <new>` | add another name for a definition |
| `ucm rm <name> [--force]` | remove a name. If it's the definition's last name and named definitions use it, refuses unless `--force` (they keep working either way) |
| `ucm todo` | conflicts, plus dependents that need fixing after an update |
| `ucm resolve <name> <#hash>` | pick one definition for a conflicted name |
| `ucm test [namespace] [--fresh]` | run tests, cached by hash ([testing](testing.md)) |
| `ucm verify` | re-render and re-hash every live definition; must be the identity ([hashing](hashing.md)) |
| `ucm migrate` | rebuild a codebase written with an older hash format. Names, history, branches, patches, todo and remotes carry over; the old `.ucm` is kept as a backup |

## History and branches

See [history, branches and merging](history.md).

| Command | |
|---|---|
| `ucm diff` | what the last command changed: edits, dependents re-hashed by them, renames |
| `ucm diff <id> \| <branch> \| <a> <b>` | changes since a history entry, to another branch, or between branches |
| `ucm history [n]` / `ucm reset <id>` | name changes on this branch / undo back to an entry |
| `ucm branch [name]` / `ucm switch <name>` | list or create branches / switch |
| `ucm merge <branch>` | three-way merge into this branch |

## Sync and remote execution

See [sync](sync.md).

| Command | |
|---|---|
| `ucm remote [add <name> <url\|dir> [--token t] [--fingerprint sha256] \| rm <name>]` | manage remotes: a `ucm serve` URL or another codebase directory |
| `ucm push [remote] [--as branch] [--force]` | send definitions the remote lacks, plus this branch's names. Refuses if the remote moved since your last sync |
| `ucm pull [remote] [branch]` | fetch into `<remote>/<branch>`; fast-forward this branch if you haven't changed it, merge otherwise |
| `ucm run <name> [args] --on <remote\|url\|dir>` | send what the remote lacks, run there, stream stdout/stderr back |
| `ucm serve [--port 7737] [--host 127.0.0.1] [--token t] [--no-run] [--tls [--tls-cert f --tls-key f]] [--insecure]` | serve this codebase over HTTP(S) |

## Apps, data and jobs

See [browser apps](apps.md), [production](production.md), [data](data.md) and [jobs](jobs.md).

| Command | |
|---|---|
| `ucm dev <app> [--port 5173] [--http <namespace>[=/prefix]]` | serve a browser app from the codebase with hot reload |
| `ucm build <app> [--force]` | immutable production build into `.ucm/apps/<hash>/` (reused if it exists) |
| `ucm start <app> [--port 8080] [--host] [--tls] [--keep N] [--http <namespace>[=/prefix]]` | serve in production, following the app's name |
| `ucm apps [prune [--keep 3]]` | list builds (`*` = current); prune keeps the current build plus the newest N others |
| `ucm data [table [n]]` | typed tables: row counts, or a table's newest rows |
| `ucm data migrate <table>` | upgrade every stored row to the current row type now, through `migrate` |
| `ucm jobs [n] \| retry <id> \| cancel <id>` | list background jobs, or act on one |
