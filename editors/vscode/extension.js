// The VS Code side of `ucm lsp`. The language server knows the codebase; this shows it: a Codebase sidebar (the
// namespace tree), `ucm:` documents (definitions rendered with current names, served by the server), and the
// actions that need VS Code's UI: picking, asking for names, opening files, terminals.
const fs = require("node:fs");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;

/**
 * `ucm.path` is the ucm executable, or a path to ucm's `bin/ucm.js` (run with Node), or a command line whose
 * words are separated by spaces, with "quotes" around a word that contains spaces.
 */
function ucmCommand() {
  const setting = vscode.workspace.getConfiguration("ucm").get("path", "ucm").trim();
  // a file: ucm itself, or its bin/ucm.js (spaces in the path and all)
  if (fs.existsSync(setting)) return /\.(c|m)?js$/.test(setting) ? ["node", setting] : [setting];
  return [...setting.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

const quote = (s) => (/^[\w./:@=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** Sidebar items: namespaces, then the definitions directly in each. */
class CodebaseTree {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element) {
    if (element && element.kind !== "namespace") return [];
    if (!client || client.state !== 2 /* running */) return [];
    const t = await client.sendRequest("ucm/tree", { namespace: element?.path ?? "" });
    return [...t.namespaces.map((n) => ({ ...n, kind: "namespace" })), ...t.definitions];
  }
  getTreeItem(e) {
    if (e.kind === "namespace") {
      const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(e.count);
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      item.contextValue = "namespace";
      item.tooltip = e.path;
      return item;
    }
    const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);
    const where = e.place === "server" ? "server · " : e.place === "browser" ? "browser · " : "";
    item.description = where + (e.kind === "type" ? "type" : e.signature.length > 80 ? e.signature.slice(0, 77) + "…" : e.signature);
    item.iconPath =
      e.test === "passed" ? new vscode.ThemeIcon("testing-passed-icon", new vscode.ThemeColor("testing.iconPassed"))
      : e.test === "failed" ? new vscode.ThemeIcon("testing-failed-icon", new vscode.ThemeColor("testing.iconFailed"))
      : e.test ? new vscode.ThemeIcon("beaker")
      : new vscode.ThemeIcon(e.kind === "type" ? "symbol-interface" : e.kind === "class" ? "symbol-class" : e.symbolKind === 12 ? "symbol-function" : "symbol-variable");
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${e.path}** \`#${e.hash.slice(0, 8)}\`\n\n`);
    tip.appendCodeblock(e.kind === "type" ? e.signature : `: ${e.signature}`, "typescript");
    if (e.place) tip.appendMarkdown(`\n\nRuns ${e.place === "anywhere" ? "anywhere" : e.place === "server" ? "on the server" : "in the browser"}.`);
    if (e.test) tip.appendMarkdown(`\n\nTest: ${e.test}.`);
    if (e.doc) tip.appendMarkdown(`\n\n${e.doc}`);
    item.tooltip = tip;
    item.contextValue = "definition";
    item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.parse(e.uri)] };
    return item;
  }
}

async function activate(context) {
  const [command, ...args] = ucmCommand();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const tree = new CodebaseTree();
  const views = new vscode.EventEmitter();

  client = new LanguageClient(
    "ucm",
    "ucm-ts",
    { command, args: [...args, "lsp"], options: { cwd: folder } },
    {
      // scratch files, and the codebase's own documents
      documentSelector: [{ scheme: "file", language: "typescript" }, { scheme: "ucm" }],
      middleware: {
        // ucm add/update save what's on disk: save the file first, and default to the active editor's file
        executeCommand: async (cmd, cmdArgs, next) => {
          if (cmd === "ucm.add" || cmd === "ucm.update") {
            const uri = cmdArgs[0] ?? vscode.window.activeTextEditor?.document.uri.toString();
            if (!uri) return;
            await vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri)?.save();
            return next(cmd, [uri]);
          }
          return next(cmd, cmdArgs);
        },
      },
    },
  );

  const pathOf = (x) => (typeof x === "string" ? x : x?.path);
  const run = (cmd, cmdArgs) => client.sendRequest("workspace/executeCommand", { command: cmd, arguments: cmdArgs });
  const pickDefinition = async (prompt) => {
    const from = await vscode.window.showInputBox({ prompt, placeHolder: "lib.square" });
    return from || undefined;
  };

  context.subscriptions.push(
    vscode.window.createTreeView("ucm.codebase", { treeDataProvider: tree, showCollapseAll: true }),
    // definitions as documents: ucm:/lib/square.ts is lib.square, rendered with current names
    vscode.workspace.registerTextDocumentContentProvider("ucm", {
      onDidChange: views.event,
      provideTextDocumentContent: async (uri) => (await client.sendRequest("ucm/source", { uri: uri.toString() })).text,
    }),
    vscode.commands.registerCommand("ucm.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("ucm.openDefinition", (item) => item && vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(item.uri))),
    vscode.commands.registerCommand("ucm.editDefinition", async (x) => {
      const name = pathOf(x) ?? (await pickDefinition("Edit which definition?"));
      if (!name) return;
      const file = await run("ucm.edit", [name]);
      if (file) await vscode.window.showTextDocument(vscode.Uri.parse(file));
    }),
    vscode.commands.registerCommand("ucm.rename", async (x) => {
      const from = pathOf(x) ?? (await pickDefinition("Rename which definition?"));
      if (!from) return;
      const to = await vscode.window.showInputBox({ prompt: `Rename ${from} to`, value: from });
      if (to && to !== from) await run("ucm.mv", [from, to]);
    }),
    vscode.commands.registerCommand("ucm.findUsages", async (x, line = 0, character = 0) => {
      const uri = typeof x === "string" ? x : x?.uri;
      if (uri) await vscode.commands.executeCommand("editor.action.findReferences", vscode.Uri.parse(uri), new vscode.Position(line, character));
    }),
    vscode.commands.registerCommand("ucm.copyHash", async (item) => {
      if (!item?.hash) return;
      await vscode.env.clipboard.writeText(`#${item.hash}`);
      vscode.window.setStatusBarMessage(`copied #${item.hash.slice(0, 8)}`, 2000);
    }),
    vscode.commands.registerCommand("ucm.runDefinition", async (x) => {
      const name = pathOf(x) ?? (await pickDefinition("Run which definition?"));
      if (!name) return;
      const terminal = vscode.window.terminals.find((t) => t.name === "ucm") ?? vscode.window.createTerminal({ name: "ucm", cwd: folder });
      terminal.show();
      terminal.sendText([...ucmCommand(), "run", name].map(quote).join(" "));
    }),
    vscode.commands.registerCommand("ucm.findByType", async () => {
      const query = await vscode.window.showInputBox({ prompt: "Find by type", placeHolder: "(xs: T[]) => T   (unknown names are type variables)" });
      if (!query) return;
      try {
        const r = await client.sendRequest("ucm/findByType", { query });
        if (!r.hits.length) return vscode.window.showInformationMessage(`Nothing in the codebase has type ${query}`);
        const pick = await vscode.window.showQuickPick(
          r.hits.map((h) => ({ label: h.path, description: h.signature, detail: h.notes.join(", ") || undefined, uri: h.uri })),
          { placeHolder: r.variables.length ? `type variables: ${r.variables.join(", ")}` : query, matchOnDescription: true },
        );
        if (pick) await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(pick.uri));
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
  );

  await client.start();
  // the codebase changed (here, or from a terminal): refresh the sidebar and any open definitions
  client.onNotification("ucm/changed", () => {
    tree.refresh();
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "ucm") views.fire(d.uri);
  });
  tree.refresh();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
