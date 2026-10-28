# Introduction

ucm-ts keeps your TypeScript in a **codebase** instead of a folder of files. You write code in ordinary `.ts`
files, as always; when it typechecks, you **add** it, and each function, type and constant is stored by a hash of
its code. From then on, names are just labels on those hashes.

That one change has a lot of consequences, and they're the reason to use it:

- **Renaming is free.** `ucm mv lib.parse lib.parseConfig` changes a label. No code is edited, nothing breaks,
  every use shows the new name.
- **Changes carry through, or tell you.** `ucm update` re-checks everything that uses what you changed. Whatever
  still typechecks follows along automatically; whatever doesn't is put on a todo list, with the reason. Nothing
  is ever half-updated.
- **Nothing to build.** Node runs the stored code directly. Tests are cached by hash: a test only runs again if
  its code, or something it calls, changed.
- **History by meaning.** `ucm diff` shows what changed in your code, not in your files: reformatting and
  renaming locals aren't changes, and renames are recognised as renames. Every change can be undone.
- **Docs that can't go stale.** Links and examples in your doc comments are code too: they follow renames and
  updates, and examples are run, so a broken one is reported.
- **Web apps without an API layer.** Write a function that reads a database and call it from browser code. ucm
  works out what runs on the server and what runs in the browser, and connects them, with no routes, fetch calls
  or `"use server"`. Because calls go by hash, a page can never call the wrong version of the server.

It's [Unison](https://www.unison-lang.org)'s codebase model, brought to plain TypeScript: no new language, no new
syntax, and the code runs on Node as it is.

## What it looks like

```ts
// scratch.ts
/** Square a number. */
export const square = (x: number): number => x * x;

square(12);
```

```sh
$ ucm check
scratch.ts
  + new       square : (x: number) => number

    7 │ square(12)
      ⧩ 144

$ ucm add
  + new       square : (x: number) => number
```

`square(12)` on its own line is a **watch expression**: ucm runs it and shows its value, like a REPL inside your
file. `square` itself is now in the codebase, and any other file can use it with
`import { square } from "#codebase"`.

## Where next

- [Install](getting-started.md) ucm-ts and set up a codebase.
- Follow the tutorial, [your first codebase](tutorial-codebase.md), about fifteen minutes.
- Or build [a small web app](tutorial-app.md) and see the server and browser parts fit together.
- Look at the [polls example](../examples/README.md), a complete app that uses most of ucm's features.
