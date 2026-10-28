# tcm-ts for VS Code

Starts `tcm lsp` in workspaces with a tcm-ts codebase (`.tcm/codebase.sqlite`). In scratch files it shows:

- each definition's status in the codebase (new, update, identical with its hash, alias, conflict), with
  **Add to codebase** / **Update codebase** actions;
- watch expression values inline (`square(12)  ⧩ 144`) and test results;
- hovers on codebase names: paths, hash, signature, placement, dependents, docs;
- tcm's own errors as diagnostics;
- **tcm: Rename a definition** (`tcm mv`).

Full documentation: `docs/editors.md` in the tcm-ts repository.

```sh
cd editors/vscode && npm install && npx @vscode/vsce package
code --install-extension tcm-ts-0.1.0.vsix     # or Extensions → … → Install from VSIX…
```

Set `tcm.path` if `tcm` isn't on your PATH: the path to tcm's `packages/cli/bin/tcm.js` works as is, spaces
included.
