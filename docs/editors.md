# Editors

`ucm lsp` is a language server (LSP over stdio) that runs **alongside TypeScript's own**. TypeScript keeps doing
completions, type errors, go-to-definition and refactors; ucm adds what only it knows. It works on scratch files:
the `.ts` files at the top of the codebase directory, the ones the watcher checks.

## What it shows

- **What each definition is to the codebase,** as a code lens above it, updated as you type (unsaved buffers
  are analyzed in memory):
  - `+ new lib.square` with an **Add to codebase** action;
  - `~ update lib.square (was #a1b2c3d4)` with **Update codebase**;
  - `lib.square #a1b2c3d4 · runs on the server` once it's saved (placement shown for app code);
  - aliases and conflicts;
  - `ucm: 2 type errors; nothing hashed until they're fixed` while TypeScript reports errors.
- **Watch values inline**, as inlay hints at the end of the line: `square(12)  ⧩ 144`. They're
  [cached by hash](getting-started.md#the-loop): while you type, values already known for an expression show
  at once; new ones are evaluated when the file is opened or saved, so a half-typed expression with side effects
  doesn't run on every keystroke.
- **Test results** on test definitions: `✓ passed (cached)` or `✗ failed: …`, run on open and save like watches.
- **Hovers on codebase names,** in scratch files: every path a definition has, its hash, signature, where it
  runs and why, how many named definitions use it, and its documentation.
- **ucm's own errors as diagnostics** (source `ucm`), such as a top-level `let` or `declare` in a scratch file.

Commands, which editors expose as code-lens actions or a command palette:

| Command | Arguments | |
|---|---|---|
| `ucm.add` | file URI | `ucm add` the file. The file must be saved (ucm saves what's on disk) |
| `ucm.update` | file URI | `ucm update` from the file |
| `ucm.mv` | from, to | `ucm mv` |

Each reports its output as a message, and every open file's status is refreshed.

## VS Code

`editors/vscode` is a small extension that starts `ucm lsp` in workspaces with a codebase. It also saves a file
before adding it, and adds **ucm: Rename a definition** (and a **Rename** lens on saved definitions), which asks
for the new name and runs `ucm mv`.

```sh
cd editors/vscode && npm install && npx @vscode/vsce package
code --install-extension ucm-ts-0.1.0.vsix
```

Set `ucm.path` if `ucm` isn't on your PATH (e.g. `node /path/to/ucm-ts/packages/cli/bin/ucm.js`). Inlay hints
must be enabled (`editor.inlayHints.enabled`, on by default) to see watch values.

## Other editors

Any LSP client can run `ucm lsp` for TypeScript files, next to its TypeScript server. The workspace root must be
the codebase directory (or inside it).

**Neovim** (0.10+):

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = "typescript",
  callback = function(args)
    local root = vim.fs.root(args.buf, { ".ucm" })
    if root then vim.lsp.start({ name = "ucm", cmd = { "ucm", "lsp" }, root_dir = root }) end
  end,
})
vim.lsp.inlay_hint.enable(true)
vim.lsp.codelens.refresh() -- or map vim.lsp.codelens.run to run the Add/Update actions
```

**Helix** (`languages.toml`):

```toml
[language-server.ucm]
command = "ucm"
args = ["lsp"]

[[language]]
name = "typescript"
language-servers = ["typescript-language-server", "ucm"]
```

**Zed** needs an extension to register a language server; there isn't one yet.

## Notes

- Only scratch files get lenses, hints and hovers. Files elsewhere (an imported project's sources) are ignored.
- The server analyzes with the same incremental TypeScript LanguageService as the watcher, so updates take
  tens of milliseconds.
- Its stdout is the protocol channel. Output from watch expressions and tests goes to its stderr, which editors
  show in the server's log.
