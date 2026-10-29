# Changelog

## 0.1.0 (2026-10-29)

The first release of tcm, the TypeScript codebase manager: [Unison](https://www.unison-lang.org)'s codebase
model for plain TypeScript. Definitions are stored by the hash of their syntax tree and names are only pointers
to hashes, so renames are free, nothing gets rebuilt, and two versions of a dependency can live side by side.
The `tcm` (and `tcm-ts`) command manages a codebase; `tcm-ts/core` exports the analyzer that hashes code.

The first release: 3 definition(s).
