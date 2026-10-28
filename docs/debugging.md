# Debugging

## In VS Code

Set breakpoints where you read code, in a scratch file or a definition's file, and press **Debug**:

- **A definition:** the **Debug** lens on a function that takes no arguments, the Debug button on its page, or
  **Debug** in the Codebase view's menu. It runs as `tcm run` does, under VS Code's JavaScript debugger.
- **A test:** the **Debug** lens on a test, in a scratch file or its definition file, or **tcm: Debug this
  file's tests**. It runs through Vitest, and the debugger follows Vitest's processes.
- **An app:** **Debug** in the Apps view. `tcm dev` runs under the Node debugger, so breakpoints in server
  functions hit, and when it prints its URL the page opens in Chrome in a second debug session, so breakpoints in
  browser code hit too.

Code from a scratch file runs as it is in the editor, saved to the codebase or not. Stepping skips Node's
internals and packages.

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
