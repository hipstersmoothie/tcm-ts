# Files and folders

What `ucm init` creates, what ucm writes as it works, and what to keep in version control.

```text
myproject/
  package.json            "#codebase" and "#ucm/server" imports; your npm dependencies
  tsconfig.json           compiler options (see compiler options)
  scratch.ts              where you write; any top-level .ts or .tsx file is a scratch file
  .ucm/
    codebase.sqlite       the codebase: definitions, names, history, branches, patches, todo
    codebase/             the #codebase modules your scratch files import (generated)
    cache/                every definition as a runnable module, by hash (generated)
    data/                 app data: tables, sessions, jobs (created when an app first runs)
    apps/                 production builds, by hash (ucm build / ucm start)
    web/, build/          working files for ucm dev and ucm build (generated)
    examples/             doc examples, as runnable modules (generated)
    secret, tls/          the server's session secret and TLS certificate, once there are any
    .gitignore            ignores everything above except codebase.sqlite
```

## What to keep

- **`.ucm/codebase.sqlite`** is the codebase. Everything else in `.ucm/` except `data/` is generated from it and
  rebuilt when missing. To share a codebase, use [sync](sync.md) (`ucm push` / `ucm pull`); copying the file works
  too.
- **`.ucm/data/`** is your app's data. Back it up like any database; don't commit it (it holds sessions), and
  don't commit `secret` or `tls/` either.
- **`package.json`, `tsconfig.json`** are worth committing: they're your project's packages and compiler settings.
- **Scratch files** are optional to keep: once code is added, it lives in the codebase.

`ucm init` writes `.ucm/.gitignore`, which leaves only `codebase.sqlite` to commit: generated directories, app
data and secrets are all ignored.

## The two imports

`ucm init` adds these to `package.json`'s `imports`:

- `#codebase`, `#codebase/<namespace>`: your saved definitions, as modules. They're regenerated whenever names
  change, so your editor's autocomplete and type checking always match the codebase.
- `#ucm/server`: the [server API](server-reference.md).

## Generated modules

`.ucm/cache/<hash>.ts` holds each definition as a module, with current names spliced in and imports by hash
(`<hash>.tsx` when it uses JSX). Node runs these directly; there's no build step. Modules Node's type
stripping can't run (JSX, and enums or namespaces from imported projects) are compiled as they load. You can read them, but there's no need to: `ucm view`, and in
VS Code Go to Definition, show the source.
