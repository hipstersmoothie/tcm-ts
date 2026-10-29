# Definitions and hashing

## What a definition is

Definitions are top-level `function`s (overloads included), `const`s, `class`es, `type`s and `interface`s.

- **Destructuring.** `const { a, b: [c] } = init()` binds one definition per name. The bindings share the
  statement, so it still runs once.
- **A type and a value can share a name**, like TypeScript's own type and value spaces (`const User =
  z.object(…)` with `type User = z.infer<typeof User>`). Each half is its own definition, updated, diffed and
  merged independently. The `#codebase` shim exports both under the one name.
- **Classes hash as one unit.** Methods aren't split out: `this`, `#private`, `super` and initialization order
  make per-method hashing meaningless.
- **Rejected in scratch files, with a reason:** top-level `let`/`var`, enums, namespaces, decorators, `declare`,
  and top-level statements other than watch expressions. [`tcm import`](importing.md) accepts most of these,
  because existing code uses them.
- **Dynamic `import("pkg")`** of a package or Node builtin is pinned like a static import, so it's still
  content-addressed. Lazy imports of local files or codebase modules are rejected. A computed specifier
  (`import(url)`) is allowed with a warning, because it loads code the codebase doesn't track.

## How a definition is hashed

`packages/core/src/canonicalize.ts` lowers every definition to an S-expression IR built from syntax-kind
*names*, not numbers, with every child labelled by its slot (`name`, `body`, …). Unknown syntax is an error,
never skipped, so two different programs can't collide.

- Comments, formatting and `export` are dropped.
- Literals are normalized: `1_000` = `0x3e8`, and `'a'` = `"a"`. Shorthand properties hash like their explicit
  form.
- Locals become de Bruijn levels, so renaming a local doesn't change the hash.
- Every identifier is resolved through the type checker. A reference to another definition becomes
  `Ref <hash>`, an npm import becomes `Ext npm:<pkg>@<compatible range>` (`npm:lodash@4`;
  [packages](packages.md#versions)), and a global becomes `G name`.
- Property names stay structural, and so do JSX tags and attributes (`<div className>`); a component tag
  (`<Counter />`) is a reference like any other.
- JSX text is normalized as React reads it: indentation and line breaks between tags don't count, spaces within a
  line do. A definition with JSX also hashes the JSX runtime it compiles to (`npm:react@<version>`).
- Type annotations are part of the hash.
- Mutually recursive definitions are hashed as a cycle (Tarjan SCC + Unison-style ordering), including cycles
  that span files.

## Identity

- **Lineage salts.** In JavaScript every declaration has its own identity: `new Map()` twice is two maps, and
  two identical classes fail each other's `instanceof`. So every function, class and value is hashed with a
  *lineage salt*, the codebase path where it was first added. Updates and renames reuse the existing salt, so
  renames stay free and re-adding the same file reproduces the same hashes. Identical code added at two paths
  is two definitions.
- **Types are unsalted**, since they have no runtime identity, so identical types deduplicate. The exception is
  an ambient `declare const x: unique symbol`, which is salted: each one is a distinct symbol.
- **Names are hashed exactly where JavaScript can observe them** (`.name`): function and class declarations,
  `const f = () => …`, and local functions or bindings that name an anonymous function (`function helper()
  {}`, `(cb = () => {}) =>`). Generated code keeps these names, so `tcm mv` changes the codebase path but not
  `.name`. All other locals and parameters stay alpha-renamable.

## The hash format

- **The format is versioned** (`tcm --version` says which: v1). `packages/core/test/golden.test.ts` pins the
  hashes of a corpus that covers most syntax, so a change to them is deliberate. A codebase written with
  another format is refused rather than mixed with this one's hashes. So is one whose tables another tcm laid out
  differently: tcm is v0, with no migrations, so such a codebase is made again (imported from its files, or
  pulled).
- **Hashes don't depend on the compiler or its version.** The IR visits each node's children in an order that's
  tcm's own (`packages/core/src/slots.ts`, generated from TypeScript 7.1's), so a TypeScript release that adds
  or reorders children changes no hash until that table does. `pnpm compare-compilers` hashes this repo and
  the corpus with TypeScript 7 and with [tsrs](compiler-options.md#the-compiler): the hashes are identical.
- **`tcm verify`** re-renders every live definition from the store and re-hashes it. Rendering is supposed to
  be the inverse of hashing, so any mismatch means stored source, splicing or canonicalization lost
  information. `TCM_KEEP_VERIFY=1` leaves the rendered files in `.tcm/cache` for debugging a failing re-check.
