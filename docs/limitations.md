# Limitations

What isn't done yet, or is deliberately out of scope:

- **Signatures are shown as first written.** `tcm view` and `find` show a definition's signature text from when
  it was added, so after `tcm mv` of a type it can show the old name. (Type *search* matches by hash and isn't
  affected.)
- **The VS Code extension** is a thin client for `tcm lsp`. The server is tested end to end; the extension's
  sidebar and commands are tested by hand. There's no Zed extension yet.
- **Definitions open read-only** (`tcm:` documents); editing goes through a scratch file.
- **Cached watch and test results can go stale** when they depend on the outside world (files, the clock,
  randomness); `--fresh` re-runs them.
- **`import.meta`** is location-dependent: it's evaluated inside `.tcm/cache`, so tcm warns about it.
- **`tcm import` skips test files**, except test definitions with `--tests` ([importing](importing.md)), and refuses `declare module`/`declare global`,
  `import x = require()`, decorators and top-level statements.
- **Mirrors don't check the files near them.** A rename reaches files outside the mirror that use the name (scripts,
  an editor extension), but only the mirror's files are checked against the codebase afterwards. A definition
  declared alongside others in one statement (`const a = 1, b = 2`) is edited by hand. Files changed outside tcm
  are imported before each command, but not by `tcm watch` or the language server while they run.
- **A suite's cached result only knows the code it ran from the codebase.** Files it reads (fixtures, a project
  it builds), code it imports from source rather than through the command, and the outside world can change
  without it running again: `tcm test --fresh` runs it. A suite that runs nothing of the codebase always runs.
- **Mirrored code that imports a file works only through tcm.** It's written importing the page or image from
  `#codebase/…`, which the project's `package.json` maps to the codebase's shim, so the codebase is in the
  project ([mirrors](importing.md#mirrors)).
- **Links between pages are kept as written, not by hash** ([pages](pages.md)): pages link to each other both
  ways, and by hash that would make cycles. They're checked when a page is saved, and `tcm mv` and `tcm rm` follow
  them. A directory's name in a mirror reads as a namespace the way code's do (`my-docs` is `my_docs`), so a new
  page goes back to a directory spelled that way.
- **Adding the same code at two paths creates two definitions** (lineage salts, see
  [hashing](hashing.md#identity)). To share one definition under two names, use `tcm alias`.
- **TypeScript 7.1 is a beta.** tcm checks code with `typescript@7.1.0-beta` ([the compiler](compiler-options.md#the-compiler)).
- **Re-exporting a package** works through `export * from "pkg"` and `export { x } from "pkg"`: a definition
  using `ns.x` or `import { x }` through such a module hashes as if it imported `x` from `pkg`. `export * as ns
  from "pkg"` isn't followed.
- **Transitive npm dependencies** aren't part of a hash; only the direct package's compatible range is. Within
  a range, tcm trusts semver: moving the lock to a newer version re-checks types, not behaviour.
- **Server-only npm packages are found by a heuristic:** no browser build, and an entry that imports Node
  builtins.
- **Packed packages run outside tcm** ([publishing](publishing.md#what-a-package-can-hold)): what needs
  `tcm dev` or `tcm start` (server functions called from a browser, tables, jobs) has no server there, and
  packages code finds at runtime by name rather than importing them go in with `--with`.
- **History syncs whole:** pushing or pulling a branch sends every definition its history names, not just its
  current ones, and each is re-verified on arrival, so a first sync of a long history takes a while.
- **Criss-cross merges** (two branches that merged each other) have several best common ancestors; tcm merges
  from the newest one, where git would merge the candidates first.
- **Contributions trust names.** A `tcm serve` server has one token, so who commented or merged is what the
  client says (`$TCM_AUTHOR` or the OS user), not checked; there are no per-person permissions. Merging one on
  the server briefly makes its target the server's current branch.
- **Semver checks see types, not behaviour.** A definition whose code changed with the same API is a patch;
  release at a higher version when a behaviour change deserves one. Generic types and generic functions whose
  type parameters changed are compared as written, so some compatible changes to them count as breaking.
- **Packages that use each other** depend on each other's releases; one that uses another's internals, or
  changes to it that aren't released yet, can't be packed until they are.
- **Transactions lock per process** ([data](data.md#transactions)).
- **Sessions** ([agents](agents.md#several-agents-at-once-sessions)): `tcm_merge` tests the session's branch with
  `main` merged in, then merges it into `main`; if another session landed in between, what lands is that merge,
  untested together. Editors and debuggers see the codebase's own branch (the language server and the definition
  views aren't per session), and a `--session` branch that never landed stays until it's removed.
