# Install

You need **Node 22.18 or newer** (ucm-ts is tested on 24). Its only dependency is TypeScript.

## Get ucm

From a checkout of the repository:

```sh
pnpm install && pnpm build
npm install -g "$(cd dist/package && npm pack --silent)"
ucm help
```

That installs the `ucm` command (also available as `ucm-ts`, since Unison's own CLI is called `ucm` too).

If you're working on ucm-ts itself, run it straight from the source instead:

```sh
alias ucm="node /path/to/ucm-ts/packages/cli/bin/ucm.js"
```

## Make a codebase

A codebase lives in a directory, the way a git repository does:

```sh
mkdir myproject && cd myproject
ucm init
```

```text
initialized codebase in /Users/you/myproject/.ucm
next: run `ucm` and edit scratch.ts
```

`ucm init` creates:

- `.ucm/`: the codebase itself (code, names, history), and things generated from it;
- `package.json`, with the `#codebase` import your files use to reach stored definitions;
- `tsconfig.json`, so your editor's TypeScript agrees with ucm's;
- `scratch.ts`, a file to start writing in.

Only `.ucm/codebase.sqlite` holds anything that can't be rebuilt; see [files and folders](files.md).

## Set up your editor

Any editor works, since you write ordinary TypeScript. In VS Code, the [ucm-ts extension](editors.md#vs-code)
shows each definition's status as you type, with buttons to add and update, watch values inline, and your
codebase in a sidebar.

## Next

Follow [your first codebase](tutorial-codebase.md).
