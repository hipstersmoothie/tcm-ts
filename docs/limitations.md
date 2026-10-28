# Limitations

What isn't done yet, or is deliberately out of scope:

- **Signatures are shown as first written.** `ucm view` and `find` show a definition's signature text from when
  it was added, so after `ucm mv` of a type it can show the old name. (Type *search* matches by hash and isn't
  affected.)
- **The watcher** uses `createProgram` with `oldProgram` reuse, not a LanguageService, and watch results
  aren't cached by hash.
- **`import.meta`** is location-dependent: it's evaluated inside `.ucm/cache`, so ucm warns about it.
- **`ucm import` skips test files** ([importing](importing.md)) and refuses `declare module`/`declare global`,
  `import x = require()`, decorators and top-level statements.
- **Adding the same code at two paths creates two definitions** (lineage salts, see
  [hashing](hashing.md#identity)). To share one definition under two names, use `ucm alias`.
- **TypeScript 7** (the Go compiler) has a different API and isn't supported; ucm uses `typescript@6`.
- **Transitive npm dependencies** aren't part of a hash; only the direct `name@version` is.
- **Server-only npm packages are found by a heuristic:** no browser build, and an entry that imports Node
  builtins.
- **Transactions lock per process** ([data](data.md#transactions)).
