# ucm-ts for VS Code

Starts `ucm lsp` in workspaces with a ucm-ts codebase (`.ucm/codebase.sqlite`). In scratch files it shows:

- each definition's status in the codebase (new, update, identical with its hash, alias, conflict), with
  **Add to codebase** / **Update codebase** actions;
- watch expression values inline (`square(12)  ⧩ 144`) and test results;
- hovers on codebase names: paths, hash, signature, placement, dependents, docs;
- ucm's own errors as diagnostics;
- **ucm: Rename a definition** (`ucm mv`).

Full documentation: `docs/editors.md` in the ucm-ts repository.

```sh
cd editors/vscode
npm install
npx @vscode/vsce package          # ucm-ts-0.1.0.vsix
code --install-extension ucm-ts-0.1.0.vsix
```

Set `ucm.path` if `ucm` isn't on your PATH, e.g. `node /path/to/ucm-ts/packages/cli/bin/ucm.js`.
