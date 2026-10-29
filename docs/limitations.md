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
- **`tcm import` skips test files** ([importing](importing.md)) and refuses `declare module`/`declare global`,
  `import x = require()`, decorators and top-level statements.
- **Adding the same code at two paths creates two definitions** (lineage salts, see
  [hashing](hashing.md#identity)). To share one definition under two names, use `tcm alias`.
- **TypeScript 7** (the Go compiler) has a different API and isn't supported; tcm uses `typescript@6`.
- **Transitive npm dependencies** aren't part of a hash; only the direct package's compatible range is. Within
  a range, tcm trusts semver: moving the lock to a newer version re-checks types, not behaviour.
- **Server-only npm packages are found by a heuristic:** no browser build, and an entry that imports Node
  builtins.
- **Packed packages run outside tcm** ([publishing](publishing.md#what-a-package-can-hold)): what needs
  `tcm dev` or `tcm start` (server functions called from a browser, tables, jobs) has no server there, and
  packages code finds at runtime by name rather than importing them go in with `--with`.
- **Transactions lock per process** ([data](data.md#transactions)).
