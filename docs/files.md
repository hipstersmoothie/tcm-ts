# Files and folders

What `tcm init` creates, what tcm writes as it works, and what to keep in version control.

```text
myproject/
  package.json            "#codebase" and "#tcm/server" imports; your npm dependencies
  tsconfig.json           compiler options (see compiler options)
  scratch.ts              where you write; any top-level .ts or .tsx file is a scratch file
  .tcm/
    codebase.sqlite       the codebase: definitions, names, history, branches, patches, todo
    codebase/             the #codebase modules your scratch files import (generated)
    cache/                every definition as a runnable module, by hash (generated)
    src/                  every named definition as a read-only file, for debuggers (generated)
    data/                 app data: tables, sessions, jobs (created when an app first runs)
    apps/                 production builds, by hash (tcm build / tcm start)
    web/, build/          working files for tcm dev and tcm build (generated)
    examples/             doc examples, as runnable modules (generated)
    pack/                 packages made by tcm pack, by package name (generated)
    secret, tls/          the server's session secret and TLS certificate, once there are any
    .gitignore            ignores everything above except codebase.sqlite
```

## What to keep

- **`.tcm/codebase.sqlite`** is the codebase. Everything else in `.tcm/` except `data/` is generated from it and
  rebuilt when missing. To share a codebase, use [sync](sync.md) (`tcm push` / `tcm pull`); copying the file works
  too.
- **`.tcm/data/`** is your app's data. Back it up like any database; don't commit it (it holds sessions), and
  don't commit `secret` or `tls/` either.
- **`package.json`, `tsconfig.json`** are worth committing: they're your project's packages and compiler settings.
- **Scratch files** are optional to keep: once code is added, it lives in the codebase.

`tcm init` writes `.tcm/.gitignore`, which leaves only `codebase.sqlite` to commit: generated directories, app
data and secrets are all ignored.

## The two imports

`tcm init` adds these to `package.json`'s `imports`:

- `#codebase`, `#codebase/<namespace>`: your saved definitions, as modules. They're regenerated whenever names
  change, so your editor's autocomplete and type checking always match the codebase.
- `#tcm/server`: the [server API](server-reference.md).

## Generated modules

`.tcm/cache/<hash>.ts` holds each definition as a module, with current names spliced in and imports by hash
(`<hash>.tsx` when it uses JSX). Node runs these directly; there's no build step. Modules Node's type
stripping can't run (JSX, and enums or namespaces from imported projects) are compiled as they load. You can read them, but there's no need to: `tcm view`, and in
VS Code Go to Definition, show the source.
