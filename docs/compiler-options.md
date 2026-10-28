# Compiler options

Options never affect hashes, only what typechecks.

## Scratch files

Options come from the project's `tsconfig.json`: `lib`, strictness, `types` and so on are the project's
choice. A few are forced, with a warning when the project sets them otherwise:

- `module`/`moduleResolution` NodeNext, which import classification and `#codebase` rely on;
- `verbatimModuleSyntax` and `erasableSyntaxOnly`, which Node's type stripping needs;
- `allowImportingTsExtensions` and `noEmit`.

Without its own `types`, a project gets ucm's `@types/node`, so scratch files typecheck without installing it.

## Imported projects

`ucm import <dir>` uses the tsconfig nearest that directory, with:

- bundler resolution, so extensionless and directory imports work;
- no stripping requirements (`verbatimModuleSyntax`, `erasableSyntaxOnly` off), since ucm renders imports
  itself and compiles what Node can't strip;
- emit options (`declaration`, `isolatedDeclarations`, `composite`, `outDir`, …) dropped;
- TypeScript 6 deprecations (`baseUrl`, node10 resolution) ignored.

## Check profiles

Each definition records the options that decide whether it typechecks: the `strict` family,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and similar, `lib` and `target`. Later re-checks
(`verify`, `update` propagation, receiving code over sync) use the recorded profile, so a library imported
with `strict: false` isn't suddenly checked as strict.
