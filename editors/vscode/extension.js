// The VS Code side of `tcm lsp`. The language server knows the codebase; this shows it: a Codebase sidebar (the
// namespace tree), `tcm:` documents (definitions rendered with current names, served by the server), and the
// actions that need VS Code's UI: picking, asking for names, opening files, terminals.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const { showTable, refreshTables } = require("./data-panel.js");
const { Pages } = require("./pages-panel.js");

let client;

/**
 * `tcm.path` is the tcm executable, or a path to tcm's `bin/tcm.js` (run with Node), or a command line whose
 * words are separated by spaces, with "quotes" around a word that contains spaces.
 */
function tcmCommand() {
  const setting = vscode.workspace.getConfiguration("tcm").get("path", "tcm").trim();
  // a file: tcm itself, or its bin/tcm.js (spaces in the path and all)
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
  item.command = { command: "tcm.openPage", title: "Open page", arguments: [{ hash: e.hash }] };
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
    const t = await client.sendRequest("tcm/tree", { namespace: element?.path ?? "" });
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
    if (!element) return (await client.sendRequest("tcm/apps", {})).map((a) => ({ ...a, kind: "app" }));
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
    item.command = run?.url ? { command: "tcm.openApp", title: "Open", arguments: [e.path] } : { command: "vscode.open", title: "Open source", arguments: [vscode.Uri.parse(e.uri)] };
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
    return client.sendRequest("tcm/data", {});
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
    item.command = { command: "tcm.showTable", title: "Open table", arguments: [e] };
    return item;
  }
}

/**
 * The packages the codebase runs: each package, then (when it runs more than one) each compatible range, then the
 * definitions that use it. A package or range opens its page (README, API, users).
 */
class PackagesTree {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element) {
    if (!client || client.state !== 2) return [];
    if (!element) return (await client.sendRequest("tcm/packages", {})).map((p) => (p.ranges.length === 1 ? { kind: "range", name: p.name, ...p.ranges[0], only: true } : { kind: "package", ...p }));
    if (element.kind === "package") return element.ranges.map((r) => ({ kind: "range", name: element.name, ...r }));
    if (element.kind === "range") return (await client.sendRequest("tcm/packageUsers", { name: element.name, range: element.range })).map((u) => ({ kind: "user", ...u }));
    return [];
  }
  getTreeItem(e) {
    if (e.kind === "user") {
      const item = new vscode.TreeItem(e.path, vscode.TreeItemCollapsibleState.None);
      item.description = e.kind === "type" ? "type" : e.signature;
      item.iconPath = new vscode.ThemeIcon(e.kind === "type" ? "symbol-interface" : "symbol-function");
      item.command = { command: "tcm.openPage", title: "Open page", arguments: [{ hash: e.hash }] };
      return item;
    }
    if (e.kind === "package") {
      const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `package:${e.name}`;
      item.description = `${e.ranges.length} ranges: ${e.ranges.map((r) => r.version).join(", ")}`;
      item.iconPath = new vscode.ThemeIcon("package");
      item.contextValue = "package";
      return item;
    }
    const label = e.only ? e.name : `${e.name} ${e.range}`;
    const item = new vscode.TreeItem(label, e.users ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `package:${e.name}@${e.range}`;
    item.description = `${e.version} · ${e.users ? `${e.users} use${e.users === 1 ? "" : "s"}` : "unused"}`;
    item.iconPath = new vscode.ThemeIcon(e.only ? "package" : "tag");
    item.tooltip = new vscode.MarkdownString(
      `**${e.name}** ${e.version} (range ${e.range})${e.types ? `\n\ntypes: @types ${e.types}` : ""}${e.integrity ? `\n\n\`${e.integrity.slice(0, 30)}…\`` : ""}`,
    );
    item.contextValue = "packageRange";
    item.command = { command: "tcm.openPackagePage", title: "Open page", arguments: [e] };
    return item;
  }
}

async function activate(context) {
  const [command, ...args] = tcmCommand();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  /** apps started from here: path → { proc, url, output } */
  const running = new Map();
  const tree = new CodebaseTree(running);
  const icon = vscode.Uri.joinPath(context.extensionUri, "media", "tcm.svg");
  const pages = new Pages(
    (method, params) => client.sendRequest(method, params),
    {
      source: (p) => vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(p.uri)),
      upgradePackage: (p) => vscode.commands.executeCommand("tcm.upgradePackage", p),
      upgradePackageTo: (p) => vscode.commands.executeCommand("tcm.upgradePackageTo", p),
      edit: (p) => vscode.commands.executeCommand("tcm.editDefinition", p.names[0]),
      usages: (p) => vscode.commands.executeCommand("tcm.findUsages", p.uri),
      run: (p) => vscode.commands.executeCommand("tcm.runDefinition", p.names[0]),
      debug: (p) => vscode.commands.executeCommand("tcm.debugDefinition", p.names[0]),
      rename: (p) => vscode.commands.executeCommand("tcm.rename", p.names[0]),
      copy: async (p) => {
        await vscode.env.clipboard.writeText(`#${p.hash}`);
        vscode.window.setStatusBarMessage(`copied #${p.hash.slice(0, 8)}`, 2000);
      },
    },
    icon,
  );
  const views = new vscode.EventEmitter();
  const apps = new AppsTree(running);
  const data = new DataTree();
  const packages = new PackagesTree();
  const upgrade = async (name, target, namespace) => {
    const label = target ? `${name} → ${target}${namespace ? ` in ${namespace}` : ""}` : name;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Upgrading ${label}…` }, () =>
      client.sendRequest("workspace/executeCommand", { command: "tcm.upgrade", arguments: [name, target, namespace] }),
    );
    packages.refresh();
    tree.refresh();
  };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "tcm.openApp";
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
    const output = vscode.window.createOutputChannel(`tcm: ${app}`);
    const [cmd, ...pre] = tcmCommand();
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
    "tcm",
    "tcm-ts",
    { command, args: [...args, "lsp"], options: { cwd: folder } },
    {
      // scratch files, and the codebase's own documents
      documentSelector: [{ scheme: "file", language: "typescript" }, { scheme: "file", language: "typescriptreact" }, { scheme: "tcm" }],
      middleware: {
        // tcm add/update save what's on disk: save the file first, and default to the active editor's file
        executeCommand: async (cmd, cmdArgs, next) => {
          if (cmd === "tcm.add" || cmd === "tcm.update") {
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
  const isTestPath = (p) => p.split(".").includes("tests") || /^test([A-Z0-9_$]|$)/.test(p.slice(p.lastIndexOf(".") + 1));
  const debug = async (kind, name, uri) => {
    try {
      const config = await client.sendRequest("tcm/debug", { kind, name, uri });
      await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], config);
    } catch (e) {
      vscode.window.showErrorMessage(`tcm: can't debug ${name ?? "that"}: ${e.message}`);
    }
  };
  const run = (cmd, cmdArgs) => client.sendRequest("workspace/executeCommand", { command: cmd, arguments: cmdArgs });
  const pickDefinition = async (prompt) => {
    const from = await vscode.window.showInputBox({ prompt, placeHolder: "lib.square" });
    return from || undefined;
  };

  context.subscriptions.push(
    vscode.window.createTreeView("tcm.codebase", { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.createTreeView("tcm.apps", { treeDataProvider: apps }),
    vscode.window.createTreeView("tcm.data", { treeDataProvider: data }),
    vscode.window.createTreeView("tcm.packages", { treeDataProvider: packages }),
    vscode.commands.registerCommand("tcm.openPackagePage", (x) => x?.name && pages.open({ package: { name: x.name, range: x.range ?? x.ranges?.[0]?.range } })),
    // within the ranges in use: no hashes change, everything using it is re-checked
    vscode.commands.registerCommand("tcm.upgradePackage", (x) => x?.name && upgrade(x.name)),
    // to another range (a new major), in one namespace or everywhere: re-pinned and re-hashed, as an update
    vscode.commands.registerCommand("tcm.upgradePackageTo", async (x) => {
      if (!x?.name) return;
      const target = await vscode.window.showInputBox({ prompt: `Move code using ${x.name} to which range?`, value: "latest", placeHolder: "latest, or a major like 19" });
      if (!target) return;
      const namespace = await vscode.window.showInputBox({ prompt: "Only in a namespace? (empty for all code)", placeHolder: "app" });
      if (namespace === undefined) return;
      await upgrade(x.name, target, namespace || undefined);
    }),
    vscode.commands.registerCommand("tcm.openTableDefinition", (t) => t?.uri && vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(t.uri))),
    vscode.commands.registerCommand("tcm.migrateTable", async (t) => {
      if (!t?.table) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Migrating ${t.table}…` }, () => run("tcm.dataMigrate", [t.table]));
      data.refresh();
      apps.refresh();
    }),
    status,
    { dispose: () => running.forEach((r) => r.proc.kill()) },
    vscode.commands.registerCommand("tcm.startApp", startApp),
    vscode.commands.registerCommand("tcm.stopApp", (x) => {
      const r = running.get(appOf(x));
      if (!r) return;
      r.stopping = true;
      r.proc.kill();
    }),
    vscode.commands.registerCommand("tcm.openApp", async (x) => {
      const live = [...running].filter(([, r]) => r.url);
      const app = appOf(x) ?? (live.length === 1 ? live[0][0] : (await vscode.window.showQuickPick(live.map(([p]) => p), { placeHolder: "Open which app?" })));
      const url = app && running.get(app)?.url;
      if (url) vscode.commands.executeCommand("simpleBrowser.show", url);
    }),
    vscode.commands.registerCommand("tcm.openAppExternal", (x) => {
      const url = running.get(appOf(x))?.url;
      if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("tcm.showAppLog", (x) => running.get(appOf(x))?.output.show()),
    vscode.commands.registerCommand("tcm.showTable", (t) =>
      t?.table && showTable(t.table, (method, params) => client.sendRequest(method, params), (uri) => vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(uri)), icon),
    ),
    // definitions as documents: tcm:/lib/square.ts is lib.square, rendered with current names
    vscode.workspace.registerTextDocumentContentProvider("tcm", {
      onDidChange: views.event,
      provideTextDocumentContent: async (uri) => (await client.sendRequest("tcm/source", { uri: uri.toString() })).text,
    }),
    // pages: a definition (from a tree item, a hash, or a name) or a namespace
    vscode.commands.registerCommand("tcm.openPage", async (x) => {
      if (x?.hash) return pages.open({ hash: x.hash });
      if (x?.kind === "namespace" || typeof x?.namespace === "string") return pages.open({ namespace: x.path ?? x.namespace });
      const name = typeof x === "string" ? x : await vscode.window.showInputBox({ prompt: "Open which definition?", placeHolder: "lib.square" });
      if (!name) return;
      try {
        const page = await client.sendRequest("tcm/page", { path: name });
        await pages.open({ hash: page.hash });
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
    vscode.commands.registerCommand("tcm.openNamespacePage", (item) => pages.open({ namespace: item?.path ?? "" })),
    // one search box: names, docs, and types (anything that looks like one, or starts with ":")
    vscode.commands.registerCommand("tcm.find", () => {
      const pick = vscode.window.createQuickPick();
      pick.placeholder = "Find a definition: a name, words from its docs, or a type like (xs: T[]) => T";
      pick.matchOnDescription = true;
      pick.matchOnDetail = true;
      let timer;
      let seq = 0;
      pick.onDidChangeValue((q) => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const mine = ++seq;
          pick.busy = true;
          try {
            const items = await client.sendRequest("tcm/find", { query: q });
            if (mine !== seq) return;
            pick.items = items.map((i) =>
              i.match === "error"
                ? { label: "$(error) " + i.detail, alwaysShow: true }
                : {
                    label: `${i.kind === "type" ? "$(symbol-interface)" : "$(symbol-function)"} ${i.path}`,
                    description: short(i.signature ?? "", 70),
                    detail: i.detail,
                    alwaysShow: true,
                    hash: i.hash,
                  },
            );
          } finally {
            if (mine === seq) pick.busy = false;
          }
        }, 120);
      });
      pick.onDidAccept(() => {
        const chosen = pick.selectedItems[0];
        if (chosen?.hash) pages.open({ hash: chosen.hash });
        pick.hide();
      });
      pick.onDidHide(() => pick.dispose());
      pick.show();
    }),
    vscode.commands.registerCommand("tcm.refresh", () => {
      tree.refresh();
      apps.refresh();
      data.refresh();
    }),
    vscode.commands.registerCommand("tcm.openDefinition", (item) => item && vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(item.uri))),
    vscode.commands.registerCommand("tcm.editDefinition", async (x) => {
      const name = pathOf(x) ?? (await pickDefinition("Edit which definition?"));
      if (!name) return;
      const file = await run("tcm.edit", [name]);
      if (file) await vscode.window.showTextDocument(vscode.Uri.parse(file));
    }),
    vscode.commands.registerCommand("tcm.rename", async (x) => {
      const from = pathOf(x) ?? (await pickDefinition("Rename which definition?"));
      if (!from) return;
      const to = await vscode.window.showInputBox({ prompt: `Rename ${from} to`, value: from });
      if (to && to !== from) await run("tcm.mv", [from, to]);
    }),
    vscode.commands.registerCommand("tcm.findUsages", async (x, line = 0, character = 0) => {
      const uri = typeof x === "string" ? x : x?.uri;
      if (uri) await vscode.commands.executeCommand("editor.action.findReferences", vscode.Uri.parse(uri), new vscode.Position(line, character));
    }),
    vscode.commands.registerCommand("tcm.copyHash", async (item) => {
      if (!item?.hash) return;
      await vscode.env.clipboard.writeText(`#${item.hash}`);
      vscode.window.setStatusBarMessage(`copied #${item.hash.slice(0, 8)}`, 2000);
    }),
    // debugging: tcm gives VS Code's JavaScript debugger a configuration in which breakpoints in definition files
    // (.tcm/src) and scratch files hit
    vscode.commands.registerCommand("tcm.debugDefinition", async (x, uri) => {
      const name = pathOf(x) ?? (await pickDefinition("Debug which definition?"));
      if (name) await debug(isTestPath(name) ? "test" : "run", name, uri);
    }),
    vscode.commands.registerCommand("tcm.debugTest", (name, uri) => debug("test", typeof name === "string" ? name : pathOf(name), uri)),
    vscode.commands.registerCommand("tcm.debugTests", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) return debug("test", undefined, doc.uri.toString());
    }),
    vscode.commands.registerCommand("tcm.debugApp", (x) => {
      const app = appOf(x) ?? pathOf(x);
      if (app) return debug("app", app);
    }),
    vscode.commands.registerCommand("tcm.runDefinition", async (x) => {
      const name = pathOf(x) ?? (await pickDefinition("Run which definition?"));
      if (!name) return;
      const terminal = vscode.window.terminals.find((t) => t.name === "tcm") ?? vscode.window.createTerminal({ name: "tcm", cwd: folder });
      terminal.show();
      terminal.sendText([...tcmCommand(), "run", name].map(quote).join(" "));
    }),
    vscode.commands.registerCommand("tcm.findByType", async () => {
      const query = await vscode.window.showInputBox({ prompt: "Find by type", placeHolder: "(xs: T[]) => T   (unknown names are type variables)" });
      if (!query) return;
      try {
        const r = await client.sendRequest("tcm/findByType", { query });
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
  client.onNotification("tcm/changed", () => {
    tree.refresh();
    apps.refresh();
    data.refresh();
    packages.refresh();
    refreshTables();
    pages.refresh();
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "tcm") views.fire(d.uri);
  });
  // rows changed (a running app wrote some, or a migration): refresh the data views and open row documents
  client.onNotification("tcm/dataChanged", () => {
    data.refresh();
    apps.refresh();
    refreshTables();
  });
  tree.refresh();
  apps.refresh();
  data.refresh();
  packages.refresh();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
