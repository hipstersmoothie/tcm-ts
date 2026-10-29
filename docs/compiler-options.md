# Compiler options

Options never affect hashes, only what typechecks.

## The compiler

tcm checks code with TypeScript 7 (`typescript@7.1`, the Go compiler), through its API: one compiler process
per tcm process, which keeps what it has parsed (the standard library, `@types/node`) from one check to the next.

`TCM_TYPESCRIPT` picks another compiler that speaks the same API:

- `TCM_TYPESCRIPT=tsrs` uses [tsrs](https://github.com/oxc-project/tsrs), TypeScript 7 ported to Rust. Install
  it in the project (`npm install --save-dev tsrs`) or next to tcm.
- `TCM_TYPESCRIPT=/path/to/binary` uses that binary (a local build of either).

The compiler doesn't affect hashes: `pnpm compare-compilers` re-hashes tcm's own source with tsrs and gets the same
hashes ([hashing](hashing.md#the-hash-format)).

## Scratch files

Options come from the project's `tsconfig.json`: `lib`, strictness, `types` and so on are the project's
choice. A few are forced, with a warning when the project sets them otherwise:

- `module`/`moduleResolution` NodeNext, which import classification and `#codebase` rely on;
- `verbatimModuleSyntax` and `erasableSyntaxOnly`, which Node's type stripping needs;
- `allowImportingTsExtensions` and `noEmit`;
- `jsx` = `react-jsx`: JSX compiles to the automatic runtime (`react/jsx-runtime`, or your `jsxImportSource`),
  which generated modules import at its pinned version ([React](react.md#packages-and-versions)).

Without its own `types`, a project gets tcm's `@types/node`, so scratch files typecheck without installing it.

## Imported projects

`tcm import <dir>` uses the tsconfig nearest that directory, with:

- bundler resolution, so extensionless and directory imports work;
- no stripping requirements (`verbatimModuleSyntax`, `erasableSyntaxOnly` off), since tcm renders imports
  itself and compiles what Node can't strip;
- emit options (`declaration`, `isolatedDeclarations`, `composite`, `outDir`, …) dropped;
- `module` ESNext and `moduleResolution` Bundler, whatever the project sets (no warning: tcm renders the imports).

## Check profiles

Each definition records the options that decide whether it typechecks: the `strict` family,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and similar, `lib` and `target`. Later re-checks
(`verify`, `update` propagation, receiving code over sync) use the recorded profile, so a library imported
with `strict: false` isn't suddenly checked as strict.
