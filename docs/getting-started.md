# Install

You need **Node 22.18 or newer** (tcm-ts is tested on 24). Everything else comes with it, or is installed when
your code first needs it.

## Get tcm

From a checkout of the repository:

```sh
pnpm install && pnpm build
npm install -g "$(cd dist/package && npm pack --silent)"
tcm help
```

That installs the `tcm` command (also available as `tcm-ts`). `tcm help` lists the commands, and
`tcm <command> --help` shows one's arguments and options.

## Shell completion

Tab completes commands, options and arguments, and the arguments come from your codebase: definition names
for `tcm view` or `tcm run`, namespaces for `tcm ls`, branches for `tcm switch`, remotes for `tcm push`.

```sh
echo 'source <(tcm complete zsh)' >> ~/.zshrc     # or: bash >> ~/.bashrc
tcm complete fish > ~/.config/fish/completions/tcm.fish
tcm complete powershell >> $PROFILE
```

If you're working on tcm-ts itself, run it straight from the source instead:

```sh
alias tcm="node /path/to/tcm-ts/cli/bin/tcm.js"
```

## Make a codebase

A codebase lives in a directory, the way a git repository does:

```sh
mkdir myproject && cd myproject
tcm init
```

```text
initialized codebase in /Users/you/myproject/.tcm
next: run `tcm` and edit scratch.ts
```

`tcm init` creates:

- `.tcm/`: the codebase itself (code, names, history), and things generated from it;
- `package.json`, with the `#codebase` import your files use to reach stored definitions;
- `tsconfig.json`, so your editor's TypeScript agrees with tcm's;
- `scratch.ts`, a file to start writing in.

Only `.tcm/codebase.sqlite` holds anything that can't be rebuilt; see [files and folders](files.md).

## Set up your editor

Any editor works, since you write ordinary TypeScript. In VS Code, the [tcm-ts extension](editors.md#vs-code)
shows each definition's status as you type, with buttons to add and update, watch values inline, and your
codebase in a sidebar.

## Next

Follow [your first codebase](tutorial-codebase.md).
