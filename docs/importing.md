# Importing existing projects

```sh
tcm import <dir> --into ns [--exclude a,b] [--update] [--tests] [--mirror] [--verbose]
```

Each file becomes a namespace: `core/src/analyze.ts` → `ns.core.analyze` (`src` path segments and `index` file
names are dropped). Imports between files, barrels and workspace packages resolve to hashes.

- **Test files are skipped:** `*.test.ts`, `*.spec.ts`, `*.test-d.ts`, and `test`, `tests`, `__tests__`,
  `dist`, `build` and `node_modules` directories.
- **`--tests`** imports `test` and `tests` directories too, for tests written as [test definitions](testing.md)
  (exports named `test…`, plus whatever helpers they use) rather than as calls to a framework's `test()`.
  `*.test.ts` files in them are still skipped, so a thin runner there can register the same definitions with
  another framework. `tcm test` then runs them, cached by hash.
- **`--exclude`** takes paths relative to `<dir>`, comma-separated, e.g. test helpers that need a dev
  dependency.
- **All problems at once.** Import reports every problem in the project in one pass and imports nothing until
  there are none.
- **`--update`** re-imports a project whose files changed, as `tcm update` would.

Compiler options for imports are described in [compiler options](compiler-options.md).

## Mirrors

`--mirror` keeps the imported directory in step with the codebase: the codebase is the truth, and the files are
how it reads in git and in editors that don't know tcm. Changes made in tcm are written back to them as edits,
and the rest of each file stays as written (comments, import style, barrels):

- **An edited definition** (`tcm edit`, then `tcm update`; a merge; a pull) is replaced where it is in its file. What
  it refers to is spelled the way the file already spells it (`ts.Node` through a namespace import, `parse` through
  a named one), and imports it needs are added.
- **A new definition** goes at the end of its namespace's file; **a removed one** is deleted.
- **A rename** (`tcm mv`) is made at every reference, as an editor's rename would: named imports, namespace
  imports (`math.twice`), shorthand properties (`{ double: twice }`), re-exports. A function's or class's name is
  part of its hash (code sees it as `.name`), so the codebase then takes the renamed code.
- **Dependents re-hashed** by an update, and packages upgraded, don't change any text: their files stay as they are.

After writing, the files are analyzed again and must hash to what the codebase holds; if they don't, they're put
back as they were and tcm says why. A file changed by hand since tcm last saw it isn't overwritten: write-back
waits until the directory is imported again (`tcm import <dir> --into ns --update`), which takes the hand edits
and links the mirror again. `tcm mirror --check` compares the files and the codebase; `tcm mirror --unlink` stops
writing back.

## Verified projects

These have been imported, verified (`tcm verify`: every definition renders and re-hashes to itself) and run from
a scratch file:

| project | definitions | notes |
|---|---|---|
| neverthrow | 51 | `strict: false`, kept as its check profile |
| ts-pattern | 247 | namespace imports (`P.infer<…>`), `declare const` |
| valibot (`library/src`, `--exclude vitest`) | 941 | 573 files in 4s; module state, `@ts-expect-error` above overloads |
| tcm-ts itself | `packages/` | see [self-hosting](developing.md#self-hosting) |

## What import mode accepts beyond scratch files

- **Enums, namespaces and parameter properties.** Node can't strip these, so their cache modules start with
  `// tcm: transform` and are compiled by a module hook when loaded. They hash like any other syntax.
- **Namespace imports of project modules.** `import * as ns from "./mod"` with `ns.member` is a reference to
  `member`, hashed exactly as if it had been imported by name. Using `ns` itself as a value is still refused.
- **Modules that re-export a package.** When `./mod` has `export * from "pkg"` or `export { x } from "pkg"`,
  `ns.x` (or `import { x } from "./mod"`) is a reference to `pkg`'s `x`, hashed as an import of it.
- **`declare const x: unique symbol`**, the usual brand pattern, is a type-only definition. It's salted like a
  term, so two identical declarations are still two distinct symbols.
- **Top-level `let`** is module state (a lazy cache, a config cell). It's salted, so each declaration is its
  own cell. Every definition that assigns to it shares its component (one module), because an imported
  binding is read-only. Readers import it and see live updates.
- **`// @ts-expect-error` and `// @ts-ignore`** directly above a declaration (including above an overload)
  stay with it. Like other comments they aren't hashed, but they decide whether it typechecks.

Still refused: `declare module`/`declare global`, `import x = require()`, decorators, and top-level statements.
A top-level statement can't be skipped quietly, because that could leave a definition half-initialized; wrap
it in an immediately-invoked function.
