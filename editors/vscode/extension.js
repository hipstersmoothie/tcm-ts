// The VS Code side of `ucm lsp`. The language server knows the codebase; this shows it: a Codebase sidebar (the
// namespace tree), `ucm:` documents (definitions rendered with current names, served by the server), and the
// actions that need VS Code's UI: picking, asking for names, opening files, terminals.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const { showTable, refreshTables } = require("./data-panel.js");

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

/** How definitions are grouped in a namespace: by what they're for, the app's entry points first. */
const ROLES = [
  ["app", "Apps", "rocket"],
  ["type", "Types", "symbol-interface"],
  ["table", "Data", "database"],
  ["schedule", "Jobs", "watch"],
  ["server", "Server", "server"],
  ["browser", "Browser", "browser"],
  ["shared", "Shared", "symbol-function"],
  ["test", "Tests", "beaker"],
];
/** Namespaces with more definitions than this are shown in role groups. */
const GROUP_OVER = 8;

const short = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** An item for one definition (shared by both views). */
function definitionItem(e, label = e.name) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = e.kind === "type" ? "type" : short(e.signature);
  item.iconPath =
    e.test === "passed" ? new vscode.ThemeIcon("testing-passed-icon", new vscode.ThemeColor("testing.iconPassed"))
    : e.test === "failed" ? new vscode.ThemeIcon("testing-failed-icon", new vscode.ThemeColor("testing.iconFailed"))
    : e.test ? new vscode.ThemeIcon("beaker")
    : e.role === "app" ? new vscode.ThemeIcon("rocket")
    : e.role === "table" ? new vscode.ThemeIcon("database")
    : e.role === "schedule" ? new vscode.ThemeIcon("watch")
    : e.endpoint ? new vscode.ThemeIcon(e.streaming ? "radio-tower" : "cloud")
    : new vscode.ThemeIcon(e.kind === "type" ? "symbol-interface" : e.kind === "class" ? "symbol-class" : e.symbolKind === 12 ? "symbol-function" : "symbol-variable");
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${e.path}** \`#${e.hash.slice(0, 8)}\`\n\n`);
  tip.appendCodeblock(e.kind === "type" ? e.signature : `: ${e.signature}`, "typescript");
  if (e.place) tip.appendMarkdown(`\n\nRuns ${e.place === "anywhere" ? "anywhere" : e.place === "server" ? "on the server" : "in the browser"}.`);
  if (e.endpoint) tip.appendMarkdown(` The browser calls it by hash${e.streaming ? ", streaming" : ""}.`);
  if (e.test) tip.appendMarkdown(`\n\nTest: ${e.test}.`);
  if (e.doc) tip.appendMarkdown(`\n\n${e.doc}`);
  item.tooltip = tip;
  item.contextValue = e.role === "app" ? "definition.app" : "definition";
  item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.parse(e.uri)] };
  return item;
}

/** Sidebar items: namespaces, then the definitions directly in each (grouped by role in big namespaces). */
class CodebaseTree {
  constructor(running) {
    this.running = running;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element) {
    if (element?.kind === "group") return element.definitions;
    if (element && element.kind !== "namespace") return [];
    if (!client || client.state !== 2 /* running */) return [];
    const t = await client.sendRequest("ucm/tree", { namespace: element?.path ?? "" });
    const namespaces = t.namespaces.map((n) => ({ ...n, kind: "namespace" }));
    if (t.definitions.length <= GROUP_OVER) return [...namespaces, ...t.definitions];
    const groups = ROLES.map(([role, label, icon]) => ({ kind: "group", role, label, icon, definitions: t.definitions.filter((d) => d.role === role) }));
    return [...namespaces, ...groups.filter((g) => g.definitions.length)];
  }
  getTreeItem(e) {
    if (e.kind === "group") {
      const item = new vscode.TreeItem(e.label, e.role === "test" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${e.definitions[0].path}:${e.role}`;
      item.description = String(e.definitions.length);
      item.iconPath = new vscode.ThemeIcon(e.icon);
      return item;
    }
    if (e.kind === "namespace") {
      const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(e.count);
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      item.contextValue = "namespace";
      item.tooltip = e.path;
      return item;
    }
    const item = definitionItem(e);
    if (e.role === "app") {
      const run = this.running.get(e.path);
      if (run) item.description = run.url ? `running · ${run.url}` : "starting…";
      item.contextValue = run ? "definition.app.running" : "definition.app";
    }
    return item;
  }
}

/**
 * The apps in the codebase, as a launcher: each app's status, and starting, stopping and opening it. What an app is
 * made of is in the Codebase view (grouped by role) and the Data view; only problems that would stop it building
 * are listed here.
 */
class AppsTree {
  constructor(running) {
    this.running = running;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element) {
    if (!client || client.state !== 2) return [];
    if (!element) return (await client.sendRequest("ucm/apps", {})).map((a) => ({ ...a, kind: "app" }));
    return element.kind === "app" ? element.errors.map((label) => ({ kind: "problem", label })) : [];
  }
  getTreeItem(e) {
    if (e.kind === "problem") {
      const item = new vscode.TreeItem(e.label);
      item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
      item.tooltip = e.label;
      return item;
    }
    const run = this.running.get(e.path);
    const item = new vscode.TreeItem(e.path, e.errors.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `app:${e.path}`;
    item.description = run?.url ? run.url : run ? "starting…" : e.errors.length ? `${e.errors.length} problem${e.errors.length > 1 ? "s" : ""}` : "";
    item.iconPath = new vscode.ThemeIcon(run ? "debug-start" : "rocket", run?.url ? new vscode.ThemeColor("testing.iconPassed") : undefined);
    item.contextValue = run ? "app.running" : "app.stopped";
    item.tooltip = new vscode.MarkdownString(
      `**${e.path}**${run?.url ? ` — running at ${run.url}` : ""}\n\n${e.endpoints.length} endpoint(s), ${e.browser.length} browser definition(s), ` +
        `${e.tables.length} table(s), ${e.schedules.length} recurring job(s). Its parts are in the Codebase and Data views.`,
    );
    // clicking an app opens it when it runs, and its source otherwise
    item.command = run?.url ? { command: "ucm.openApp", title: "Open", arguments: [e.path] } : { command: "vscode.open", title: "Open source", arguments: [vscode.Uri.parse(e.uri)] };
    return item;
  }
}

/** The app data: every table, with its row count; a table opens in the table viewer. */
class DataTree {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element) {
    if (!client || client.state !== 2 || element) return [];
    return client.sendRequest("ucm/data", {});
  }
  getTreeItem(e) {
    const item = new vscode.TreeItem(e.table, vscode.TreeItemCollapsibleState.None);
    item.id = `table:${e.table}`;
    item.description = `${e.rows} row${e.rows === 1 ? "" : "s"}${e.older ? ` · ${e.older} older` : ""}${e.path ? "" : " · not declared"}`;
    item.iconPath = new vscode.ThemeIcon("database", e.older ? new vscode.ThemeColor("list.warningForeground") : undefined);
    item.tooltip = new vscode.MarkdownString(
      `**${e.table}**${e.path ? ` — declared by \`${e.path}\`` : " — no definition declares it now"}\n\n${e.rows} row(s)` +
        (e.older ? `; ${e.older} stored as an older row type (they go through \`migrate\` when read, or all now with **Migrate rows**)` : ""),
    );
    item.contextValue = e.older ? "table.older" : "table";
    item.command = { command: "ucm.showTable", title: "Open table", arguments: [e] };
    return item;
  }
}

async function activate(context) {
  const [command, ...args] = ucmCommand();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  /** apps started from here: path → { proc, url, output } */
  const running = new Map();
  const tree = new CodebaseTree(running);
  const views = new vscode.EventEmitter();
  const apps = new AppsTree(running);
  const data = new DataTree();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "ucm.openApp";
  const showStatus = () => {
    const live = [...running].filter(([, r]) => r.url);
    status.text = `$(radio-tower) ${live.map(([p]) => p).join(", ")}`;
    status.tooltip = live.map(([p, r]) => `${p}: ${r.url}`).join("\n");
    if (live.length) status.show();
    else status.hide();
  };
  const appOf = (x) => (typeof x === "string" ? x : x?.path);
  const startApp = async (x) => {
    const app = appOf(x) ?? (await vscode.window.showInputBox({ prompt: "Start which app?", placeHolder: "app.main" }));
    if (!app) return;
    const existing = running.get(app);
    if (existing?.url) return vscode.commands.executeCommand("simpleBrowser.show", existing.url);
    if (existing) return;
    const output = vscode.window.createOutputChannel(`ucm: ${app}`);
    const [cmd, ...pre] = ucmCommand();
    // port 0: a free port, so several apps can run at once
    const proc = spawn(cmd, [...pre, "dev", app, "--port", "0"], { cwd: folder, env: { ...process.env, NO_COLOR: "1" } });
    const run = { proc, output, url: undefined };
    running.set(app, run);
    apps.refresh();
    tree.refresh();
    const onData = (d) => {
      const text = d.toString().replace(/\x1b\[[0-9;]*m/g, "");
      output.append(text);
      const m = !run.url && /url\s+(https?:\/\/\S+)/.exec(text);
      if (m) {
        run.url = m[1];
        apps.refresh();
        tree.refresh();
        showStatus();
        vscode.commands.executeCommand("simpleBrowser.show", run.url);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      running.delete(app);
      apps.refresh();
      tree.refresh();
      showStatus();
      if (code && code !== 143 && !run.stopping) {
        output.show(true);
        vscode.window.showErrorMessage(`${app} stopped (exit ${code}); see its output`);
      }
    });
  };

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
    vscode.window.createTreeView("ucm.apps", { treeDataProvider: apps }),
    vscode.window.createTreeView("ucm.data", { treeDataProvider: data }),
    vscode.commands.registerCommand("ucm.openTableDefinition", (t) => t?.uri && vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(t.uri))),
    vscode.commands.registerCommand("ucm.migrateTable", async (t) => {
      if (!t?.table) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Migrating ${t.table}…` }, () => run("ucm.dataMigrate", [t.table]));
      data.refresh();
      apps.refresh();
    }),
    status,
    { dispose: () => running.forEach((r) => r.proc.kill()) },
    vscode.commands.registerCommand("ucm.startApp", startApp),
    vscode.commands.registerCommand("ucm.stopApp", (x) => {
      const r = running.get(appOf(x));
      if (!r) return;
      r.stopping = true;
      r.proc.kill();
    }),
    vscode.commands.registerCommand("ucm.openApp", async (x) => {
      const live = [...running].filter(([, r]) => r.url);
      const app = appOf(x) ?? (live.length === 1 ? live[0][0] : (await vscode.window.showQuickPick(live.map(([p]) => p), { placeHolder: "Open which app?" })));
      const url = app && running.get(app)?.url;
      if (url) vscode.commands.executeCommand("simpleBrowser.show", url);
    }),
    vscode.commands.registerCommand("ucm.openAppExternal", (x) => {
      const url = running.get(appOf(x))?.url;
      if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("ucm.showAppLog", (x) => running.get(appOf(x))?.output.show()),
    vscode.commands.registerCommand("ucm.showTable", (t) =>
      t?.table && showTable(t.table, (method, params) => client.sendRequest(method, params), (uri) => vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(uri))),
    ),
    // definitions as documents: ucm:/lib/square.ts is lib.square, rendered with current names
    vscode.workspace.registerTextDocumentContentProvider("ucm", {
      onDidChange: views.event,
      provideTextDocumentContent: async (uri) => (await client.sendRequest("ucm/source", { uri: uri.toString() })).text,
    }),
    vscode.commands.registerCommand("ucm.refresh", () => {
      tree.refresh();
      apps.refresh();
      data.refresh();
    }),
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
    apps.refresh();
    data.refresh();
    refreshTables();
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "ucm") views.fire(d.uri);
  });
  // rows changed (a running app wrote some, or a migration): refresh the data views and open row documents
  client.onNotification("ucm/dataChanged", () => {
    data.refresh();
    apps.refresh();
    refreshTables();
  });
  tree.refresh();
  apps.refresh();
  data.refresh();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
