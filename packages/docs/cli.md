# CLI reference

`tcm help` prints the same list in short form; `tcm <command> --help` (or `tcm help <command>`) shows a
command's arguments and options, with their defaults. A mistyped command gets a suggestion, and an argument
or option a command doesn't take is an error naming it.

- **Arguments for `tcm run`** that start with `-` go after `--`: `tcm run lib.main -- --verbose`.
- **Missing arguments are asked for** at a terminal: `tcm view`, `run`, `edit`, `docs`, `deps`, `mv`, `rm`, `dev`
  and others offer the codebase's names to search, `tcm switch` and `merge` offer branches, `tcm resolve` the
  conflicts and their definitions, `tcm reset` the recent commands to undo, and `tcm upgrade` the packages.
  `tcm rm` of a name others use asks instead of refusing. Elsewhere (scripts, CI, editors), a missing argument is
  a usage error.
- **Package installs** show as a line each, replaced by what was installed and how long it took on a terminal.
- **Shell completion:** `source <(tcm complete zsh)` (or `bash`, `fish`, `powershell`); see
  [install](getting-started.md#shell-completion).

## Codebase

| Command | |
|---|---|
| `tcm init` | set up a codebase here: `.tcm/codebase.sqlite`, `package.json` `#codebase` imports, `tsconfig.json`, `scratch.ts` |
| `tcm` / `tcm watch [--fresh]` | watch `*.ts` scratch files: typecheck, hash, report, evaluate watch expressions and tests. Their results are cached by hash; `--fresh` re-runs them |
| `tcm lsp [--stdio]` | language server for editors, over stdio ([editors](editors.md)) |
| `tcm mcp` | tools for AI agents to work in the codebase: a Model Context Protocol server, over stdio ([agents](agents.md)) |
| `tcm complete <shell>` | a completion script for zsh, bash, fish or powershell, completing names from the codebase too |
| `tcm check [file] [--fresh]` | one-shot version of watch. Reports each definition as `new` / `identical` / `update` / `alias` / `conflict` |
| `tcm add [file] [--into ns]` | save new definitions from a scratch file (default `scratch.ts`) |
| `tcm update [file] [--into ns]` | save, re-point changed names, and re-hash every dependent. Dependents that stop typechecking keep their old hash and go to `todo`. Also checks stored table rows against changed row types ([data](data.md)) |
| `tcm export <namespace> <dir>` | write a namespace's [files](pages.md) (pages, stylesheets, images) to a directory, links and names as they are now |
| `tcm import <dir> [--into ns] [--update] [--exclude a,b] [--tests] [--mirror] [--verbose]` | add an existing project, one namespace per file; `--mirror` keeps its files in step with the codebase, and makes the releases recorded with them again ([importing](importing.md#mirrors)) |
| `tcm mirror [--check] [--unlink]` | the directory changes are written back to; `--check` re-analyzes its files, which must hash to what the codebase holds ([mirrors](importing.md#mirrors)) |
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
| `tcm fmt [namespace]` | reformat stored definitions with oxfmt; no hash changes ([formatting](formatting.md)) |
| `tcm lint [namespace] [--fresh]` | lint definitions with oxlint, cached by hash ([linting](linting.md)) |
| `tcm packages` | the npm packages the codebase runs: range, locked version, what uses them ([packages](packages.md)) |
| `tcm upgrade <pkg> [--force]` | newest versions within the ranges in use (and of what's built against it); no hashes change, everything using them is re-checked |
| `tcm upgrade <pkg>@<range\|latest> [namespace]` | re-pin code to another range: re-hashed, dependents follow |
| `tcm pack <package>[@version] [--out dir]` | an npm package of a package (a `manifest` definition's namespace): a release of it, or the branch as it is ([publishing](publishing.md)) |
| `tcm pack [[subpath=]<namespace\|name>...] --name <pkg>[@version] [--bin cmd=<name>,...] [--with pkg,...] [--files a,b] [--out dir]` | an npm package of the definitions given ([publishing](publishing.md#packing-definitions-directly)) |
| `tcm release [<package>][@version] [--draft] [--notes file] [--remote r] [--force]` | release a package at the version its API's changes call for (or a further one), with notes whose list of changes tcm writes; a mirrored codebase's are recorded with its files, for git ([releases](releases.md#releases-kept-in-git)) |
| `tcm release check [package]` | what the next release would be, and each semver finding behind it |
| `tcm release view <package>@<version>` | a release's notes |
| `tcm releases [package]` | the packages and their releases |
| `tcm changelog [package] [--out file]` | a package's changelog, from its releases |
| `tcm resolve <name> <#hash>` | pick one definition for a conflicted name |
| `tcm test [namespace] [--fresh] [--definitions] [--bin cmd=<path>,...]` | run tests, cached by hash, then the suites packages declare, cached by the code they ran; `--definitions` skips the suites, `--bin` runs them against another build of a command, like a package packed from the codebase ([testing](testing.md)) |
| `tcm verify` | re-render and re-hash every live definition; must be the identity ([hashing](hashing.md)) |

## History and branches

See [history, branches and merging](history.md).

| Command | |
|---|---|
| `tcm diff` | what the last command changed: edits, dependents re-hashed by them, renames |
| `tcm diff <n\|#hash> \| <branch> \| <a> <b>` | changes since a history entry, to another branch, or between two branches or entries |
| `tcm history [n]` | this branch's history: an entry per command, with its hash, how many back it is, and what it changed |
| `tcm reset <n\|#hash>` | bring back the names as of an entry (`tcm reset 1` undoes the last command), as a new entry |
| `tcm branch [name]` / `tcm switch <name>` | list or create branches / switch |
| `tcm merge <branch>` | merge into this branch: nothing if it has the other's history, a fast-forward if the other has its, otherwise three-way from their common ancestor |

## Sync and remote execution

See [sync](sync.md).

| Command | |
|---|---|
| `tcm remote [add <name> <url\|dir> [--token t] [--fingerprint sha256] \| rm <name>]` | manage remotes: a `tcm serve` URL or another codebase directory |
| `tcm push [remote] [--as branch] [--force]` | send this branch's history (what the remote lacks) and move the remote branch to it. Refuses if the remote has history you don't, unless `--force` |
| `tcm pull [remote] [branch]` | fetch the remote branch's history into `<remote>/<branch>`; fast-forward this branch if it can, merge from the common ancestor otherwise |
| `tcm run <name> [args] --on <remote\|url\|dir>` | send what the remote lacks, run there, stream stdout/stderr back |
| `tcm contribute [remote] [--to main] [--as name] [--title t] [--description d]` | push this branch and open a contribution of it on the remote (pushing again updates it) ([contributions](contributions.md)) |
| `tcm contribution [--remote origin] [--all]` | the remote's contributions |
| `tcm contribution view\|comment\|merge\|close\|reopen <id>` | a contribution's changes, whether it merges, and comments; comment (`--about <name>`); merge it on the remote by history (refused on conflicts); close or reopen it |
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
