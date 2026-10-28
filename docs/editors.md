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

## The codebase as documents

The code lives in the codebase, not in files, so the server also shows the codebase itself.

- **Definitions are documents.** `ucm:/lib/square.ts` is `lib.square` rendered with current names (what `ucm
  view` prints), with a header line giving its names, hash and where it runs. They're read-only: to change one,
  **Edit** writes it into a scratch file (`scratch.ts` if that's empty, else `edit.ts`, `edit-2.ts`, …), where
  TypeScript checks it and the lens offers **Update codebase**.
- **Go to Definition (Cmd/Ctrl+click) goes to the source.** On a codebase name in a scratch file it opens that
  definition's document; in a definition's document every reference is a link, since ucm knows exactly where
  each one sits in the rendered text. (In VS Code, the extension's TypeScript plugin hides TypeScript's own
  answer, the generated module in `.ucm/cache`, so the source is the only result. Other editors show both.)
- **Find All References** lists every definition in the codebase that uses one, at the exact spot, from its
  dependents. In scratch files these are listed alongside TypeScript's own results.
- **Lenses on a definition's document:** how many named definitions use it (click to list them), **Edit**,
  **Rename**.
- **Symbols.** Workspace symbol search (Cmd/Ctrl+T) covers every name in the codebase; the outline shows a
  document's definitions.
- **Hovers** in these documents describe whatever is under the cursor, as in scratch files.

For clients that want to show more, the server answers:

| request | |
|---|---|
| `ucm/tree` | one level of the namespace tree: each definition's kind, role (app, type, table, schedule, server, browser, shared, test), signature, placement, whether it's an endpoint, test status |
| `ucm/apps` | each app with its endpoints, browser code, tables (with row counts), schedules and tests |
| `ucm/data` | tables, with row counts, rows of older row types, the declaring definition and the row type's fields |
| `ucm/rows` | a page of a table's rows for a viewer: searched, sorted by a field and paged in SQLite; the row type's fields (columns), and each row's cells, full value, and whether it's of an older row type |
| `ucm/source` | a `ucm:` document's text: a definition, `ucm:/.data/<table>.txt`, or `ucm:/.data/<table>/<id>.txt` |
| `ucm/findByType` | type search, as `ucm find ':…'` |

It sends `ucm/changed` when the codebase changes and `ucm/dataChanged` when the data store does, here or from a
terminal or a running app. `ucm.dataMigrate <table>` is a command, like `ucm.add`.

## VS Code

`editors/vscode` is the extension. Beyond starting `ucm lsp` in workspaces with a codebase, it adds:

The `#` icon in the activity bar opens three views:

- **Apps.** A launcher: every app in the codebase, meaning every browser entry point (a function that runs in
  the browser, takes no arguments and isn't called by other code, like `polls.main`). **▶ Start** runs `ucm dev`
  for it on a free port, with its log in an output channel, and opens it in VS Code's built-in browser; the
  status bar shows running apps. **Open** (also in an external browser), **Log** and **Stop** act on a running
  one. Clicking an app opens it if it runs, and its source otherwise. An app only expands to show problems that
  would stop it building; what it's made of is in the other two views.
- **Codebase.** Namespaces, and the definitions in each. Namespaces with more than a few definitions are grouped
  by what they're for: Apps, Types, Data (tables), Jobs (schedules), Server, Browser, Shared (runs anywhere) and
  Tests. Apps here show whether they're running, with the same start, open and stop buttons. Icons show kinds, endpoints (a cloud) and test results. Hover for details; click to open. Right-click (or
  the inline icons) for **Edit in a scratch file**, **Find usages**, **Run** (`ucm run` in a terminal), **Rename**
  (`ucm mv`, also for a whole namespace) and **Copy hash**.
- **Data.** Every table: declared ones and ones with rows. Each shows its row count and how many rows are still
  stored as an older row type; **Migrate rows** brings those up to date (`ucm data migrate`), and **Go to
  definition** opens the `table<…>()` that declares it. Click a table to open it in the **table viewer**: a grid
  with a column per field of the row type (each header gives the field's type), the row's id and when it was
  written.
  - Click a header to sort by it; type in the search box to find rows containing the text anywhere. Sorting,
    search and paging (a hundred rows at a time) run in SQLite on the server, so big tables stay fast.
  - Click a row to see its full value, nested objects and all, beside the grid.
  - Rows stored as an older row type are badged, and the header offers **Migrate rows**.
  - It's live: open viewers refresh as a running app writes rows. It's read-only; changing rows by hand would
    bypass the table's own type checks and migrations.

All three refresh when the codebase changes (including from a terminal), and the Data view also when the data
does, so rows appear as a running app writes them.
- **ucm: Find by type** (the search icon in the sidebar, or the command palette): type a TypeScript type, pick a
  match, and it opens.
- **A TypeScript server plugin** (`editors/vscode/ts-plugin`, loaded through VS Code's
  `typescriptServerPlugins`): Go to Definition skips ucm's generated modules, so Cmd+click on a codebase name
  lands on its source rather than offering `.ucm/cache/<hash>.ts` too. Reload the window after installing.
- **ucm: Add / Update**, which save the file first; **Rename** and **Edit** ask for names when run from the
  palette.

Try it on the [polls example](../examples/README.md).

Build a `.vsix` (the first `npx` downloads vsce, which takes a while) and install it with **Extensions → … →
Install from VSIX…**, or with VS Code's CLI (on macOS it's inside the app if `code` isn't on your PATH):

```sh
cd editors/vscode && npm install && npx @vscode/vsce package
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension ucm-ts-0.1.0.vsix
```

Don't symlink the folder into `~/.vscode/extensions`: VS Code only keeps extensions listed in its manifest, and
marks unlisted folders as removed. A workspace you haven't trusted yet runs in Restricted Mode, where the
extension stays off until you trust it.

Set `ucm.path` if `ucm` isn't on your PATH: either the path to ucm's `packages/cli/bin/ucm.js` (spaces in the
path are fine; it's run with Node), or a command line with quotes around words containing spaces. Inlay hints
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

- Scratch files and `ucm:` documents get ucm's features. Files elsewhere (an imported project's sources) are
  ignored.
- The server analyzes with the same incremental TypeScript LanguageService as the watcher, so updates take
  tens of milliseconds.
- Its stdout is the protocol channel. Output from watch expressions and tests goes to its stderr, which editors
  show in the server's log.
