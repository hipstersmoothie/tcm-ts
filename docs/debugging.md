# Debugging

## Stack traces point at definitions

Code runs from generated modules (`.tcm/cache/<hash>.ts`), but you never see them in an error. Every generated
module carries a source map to where its code reads as written:

- a stored definition's **file in `.tcm/src`**: `lib.half` is `.tcm/src/lib/half.ts`, exactly what
  `tcm view lib.half` and the editor show;
- a definition you haven't saved yet: **its scratch file**.

```text
$ tcm run lib.main
Error: negative
    at half (/work/app/.tcm/src/lib/half.ts:7:11)
    at quarter (/work/app/scratch.ts:4:10)
```

Lines and columns are exact, through everything tcm runs: `tcm run`, watch expressions, tests, server functions
under `tcm dev` and `tcm start`, and the code tcm compiles itself (JSX).

## Definitions as files

`.tcm/src` holds every named definition as a read-only file: its names, hash and where it runs on the first line,
then the code with current names. They're regenerated as names change (a renamed definition's file moves) and
are what debuggers open. To change a definition, edit it in a scratch file (`tcm edit`), as always.
