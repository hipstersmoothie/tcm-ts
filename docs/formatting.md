# Formatting

tcm formats with [oxfmt](https://oxc.rs/docs/guide/usage/formatter), with nothing to install or configure.
Formatting never changes a hash: a definition's hash has no whitespace, layout, quotes or trailing commas in
it. So tcm formats freely, without touching identity, history or what depends on what.

- **What's saved is formatted.** `tcm add` and `tcm update` store each definition as oxfmt formats it, so
  `tcm view`, `tcm edit`, pages and generated modules show one style, whoever wrote the code and however.
  The scratch file itself is left as you wrote it. A [mirrored](importing.md#mirrors) codebase is the
  exception: its code reads as its files do, so it's stored as written.
- **In VS Code**, a scratch file is formatted as it's saved, and by Format Document. (Other editors: the
  language server answers `textDocument/formatting` and `willSaveWaitUntil`.)
- **`tcm fmt [namespace]`** reformats what's already stored, after a style change or an oxfmt upgrade. No hash
  changes, nothing is re-derived, and history is untouched.

```text
$ tcm fmt
  ~ lib.greet
  ~ lib.shout
reformatted 2 definition(s); no hashes changed
```

Every formatted text is analyzed again before it's kept, and kept only if each definition hashes exactly as
before. A formatter bug can't change what code means: tcm keeps the text as it was, and says so.

## fmt.config

A definition at `fmt.config` holds oxfmt's options: Prettier's (`printWidth`, `singleQuote`, `semi`,
`trailingComma`, …; [the full list](https://oxc.rs/docs/guide/usage/formatter/config)).

```ts
// tcm: namespace fmt
export const config = { singleQuote: true, semi: false, printWidth: 100 };
```

Changing it changes how new code is saved; `tcm fmt` restyles what's already there.

oxfmt itself is pinned in the lock like any package (`tcm packages`). It's before 1.0, so its range is its minor
(`0.75`): patch releases arrive on their own, and `tcm upgrade oxfmt@latest` moves to a newer minor.
