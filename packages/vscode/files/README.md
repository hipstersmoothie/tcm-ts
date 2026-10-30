# tcm-ts for VS Code

Starts `tcm lsp` in workspaces with a tcm-ts codebase (`.tcm/codebase.sqlite`). In scratch files it shows:

- each definition's status in the codebase (new, update, identical with its hash, alias, conflict), with
  **Add to codebase** / **Update codebase** actions;
- watch expression values inline (`square(12)  ⧩ 144`) and test results;
- hovers on codebase names: paths, hash, signature, placement, dependents, docs;
- tcm's own errors as diagnostics;
- **tcm: Rename a definition** (`tcm mv`).

In the sidebar: apps to start, the codebase, data, the npm packages it runs, and **Releases**: the codebase's
own packages, what each one's next release would be and why (every semver finding), drafting notes, releasing,
packing and changelogs.

Full documentation: `packages/docs/editors.md` in the tcm-ts repository. It needs VS Code 1.143 or later. In
that repository:

```sh
pnpm tcm pack tcm-ts-vscode --out ../dist/vscode
cd dist/vscode && npm install && npx @vscode/vsce package
code --install-extension tcm-ts-*.vsix     # or Extensions → … → Install from VSIX…
```

Set `tcm.path` if `tcm` isn't on your PATH: the path to tcm's `packages/cli/bin/tcm.js` works as is, spaces
included.
