// The VS Code side of `tcm lsp`. The language server knows the codebase; this shows it: a Codebase sidebar (the
// namespace tree), `tcm:` documents (definitions rendered with current names, served by the server), and the
// actions that need VS Code's UI: picking, asking for names, opening files, terminals.
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node.js";
import { refreshTables, showTable } from "./data-panel.ts";
import { Pages } from "./pages-panel.ts";
import { DraftLenses, ReleasesTree, type PublishedPackage, type ReleaseCheck, type Request } from "./releases.ts";

/** The language client, while the extension is active. */
export const session: { client?: LanguageClient } = {};

/** Whether the language server is up to answer requests. */
export const running = (): boolean => session.client?.state === State.Running;

/**
 * `tcm.path` is the tcm executable, or a path to tcm's `bin/tcm.js` (run with Node), or a command line whose
 * words are separated by spaces, with "quotes" around a word that contains spaces.
 */
export function tcmCommand(): string[] {
  const setting = vscode.workspace.getConfiguration("tcm").get("path", "tcm").trim();
  // a file: tcm itself, or its bin/tcm.js (spaces in the path and all)
  if (fs.existsSync(setting)) return /\.(c|m)?(js|ts)$/.test(setting) ? ["node", setting] : [setting];
  return [...setting.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

export const quote = (s: string) => (/^[\w./:@=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

export type Role = "app" | "type" | "table" | "schedule" | "server" | "browser" | "shared" | "test";

/** How definitions are grouped in a namespace: by what they're for, the app's entry points first. */
export const ROLES: [Role, string, string][] = [
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
export const GROUP_OVER = 8;

export const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A definition, as the language server lists it (tcm/tree). */
export interface DefinitionEntry {
  kind: "term" | "type" | "class";
  name: string;
  path: string;
  hash: string;
  uri: string;
  signature: string;
  role?: Role;
  test?: "passed" | "failed" | string;
  endpoint?: boolean;
  streaming?: boolean;
  symbolKind?: number;
  place?: "server" | "browser" | "anywhere";
  doc?: string;
}

/** An item for one definition (shared by both views). */
export function definitionItem(e: DefinitionEntry, label: string = e.name): vscode.TreeItem {
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

/** An app started from here. */
export interface RunningApp {
  proc: ChildProcess;
  output: vscode.OutputChannel;
  url?: string;
  stopping?: boolean;
}

export type CodebaseNode =
  | { kind: "namespace"; name: string; path: string; count: number }
  | { kind: "group"; role: Role; label: string; icon: string; definitions: DefinitionEntry[] }
  | DefinitionEntry;

/** Sidebar items: namespaces, then the definitions directly in each (grouped by role in big namespaces). */
export class CodebaseTree implements vscode.TreeDataProvider<CodebaseNode> {
  running: Map<string, RunningApp>;
  changed = new vscode.EventEmitter<CodebaseNode | undefined | void>();
  onDidChangeTreeData = this.changed.event;

  constructor(running: Map<string, RunningApp>) {
    this.running = running;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element?: CodebaseNode): Promise<CodebaseNode[]> {
    if (element?.kind === "group") return element.definitions;
    if (element && element.kind !== "namespace") return [];
    if (!running()) return [];
    const t = (await session.client!.sendRequest("tcm/tree", { namespace: element?.path ?? "" })) as { namespaces: { name: string; path: string; count: number }[]; definitions: DefinitionEntry[] };
    const namespaces = t.namespaces.map((n) => ({ ...n, kind: "namespace" as const }));
    if (t.definitions.length <= GROUP_OVER) return [...namespaces, ...t.definitions];
    const groups = ROLES.map(([role, label, icon]) => ({ kind: "group" as const, role, label, icon, definitions: t.definitions.filter((d) => d.role === role) }));
    return [...namespaces, ...groups.filter((g) => g.definitions.length)];
  }
  getTreeItem(e: CodebaseNode): vscode.TreeItem {
    if (e.kind === "group") {
      const item = new vscode.TreeItem(e.label, e.role === "test" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${e.definitions[0]!.path}:${e.role}`;
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

/** An app of the codebase (tcm/apps), and what would stop it building. */
export interface AppEntry {
  path: string;
  uri: string;
  errors: string[];
  endpoints: unknown[];
  browser: unknown[];
  tables: unknown[];
  schedules: unknown[];
}

export type AppNode = ({ kind: "app" } & AppEntry) | { kind: "problem"; label: string };

/**
 * The apps in the codebase, as a launcher: each app's status, and starting, stopping and opening it. What an app is
 * made of is in the Codebase view (grouped by role) and the Data view; only problems that would stop it building
 * are listed here.
 */
export class AppsTree implements vscode.TreeDataProvider<AppNode> {
  running: Map<string, RunningApp>;
  changed = new vscode.EventEmitter<AppNode | undefined | void>();
  onDidChangeTreeData = this.changed.event;

  constructor(running: Map<string, RunningApp>) {
    this.running = running;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element?: AppNode): Promise<AppNode[]> {
    if (!running()) return [];
    if (!element) return ((await session.client!.sendRequest("tcm/apps", {})) as AppEntry[]).map((a) => ({ ...a, kind: "app" as const }));
    return element.kind === "app" ? element.errors.map((label) => ({ kind: "problem" as const, label })) : [];
  }
  getTreeItem(e: AppNode): vscode.TreeItem {
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

/** A table of app data (tcm/data). */
export interface TableEntry {
  table: string;
  rows: number;
  older: number;
  path?: string;
  uri?: string;
}

/** The app data: every table, with its row count; a table opens in the table viewer. */
export class DataTree implements vscode.TreeDataProvider<TableEntry> {
  changed = new vscode.EventEmitter<TableEntry | undefined | void>();
  onDidChangeTreeData = this.changed.event;

  refresh() {
    this.changed.fire();
  }
  async getChildren(element?: TableEntry): Promise<TableEntry[]> {
    if (!running() || element) return [];
    return session.client!.sendRequest("tcm/data", {});
  }
  getTreeItem(e: TableEntry): vscode.TreeItem {
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

/** One compatible range of a package the codebase runs (tcm/packages). */
export interface PackageRange {
  range: string;
  version: string;
  users: number;
  types?: string;
  integrity?: string;
}

export type PackageNode =
  | { kind: "package"; name: string; ranges: PackageRange[] }
  | ({ kind: "range"; name: string; only?: boolean } & PackageRange)
  | { kind: "user"; path: string; hash: string; signature: string; userKind?: string };

/**
 * The packages the codebase runs: each package, then (when it runs more than one) each compatible range, then the
 * definitions that use it. A package or range opens its page (README, API, users).
 */
export class PackagesTree implements vscode.TreeDataProvider<PackageNode> {
  changed = new vscode.EventEmitter<PackageNode | undefined | void>();
  onDidChangeTreeData = this.changed.event;

  refresh() {
    this.changed.fire();
  }
  async getChildren(element?: PackageNode): Promise<PackageNode[]> {
    if (!running()) return [];
    const client = session.client!;
    if (!element) {
      const pkgs = (await client.sendRequest("tcm/packages", {})) as { name: string; ranges: PackageRange[] }[];
      return pkgs.map((p): PackageNode => (p.ranges.length === 1 ? { kind: "range", name: p.name, ...p.ranges[0]!, only: true } : { kind: "package", ...p }));
    }
    if (element.kind === "package") return element.ranges.map((r) => ({ kind: "range" as const, name: element.name, ...r }));
    if (element.kind === "range") {
      const users = (await client.sendRequest("tcm/packageUsers", { name: element.name, range: element.range })) as { path: string; hash: string; signature: string; kind?: string }[];
      return users.map(({ kind, ...u }) => ({ kind: "user" as const, userKind: kind, ...u }));
    }
    return [];
  }
  getTreeItem(e: PackageNode): vscode.TreeItem {
    if (e.kind === "user") {
      const item = new vscode.TreeItem(e.path, vscode.TreeItemCollapsibleState.None);
      item.description = e.userKind === "type" ? "type" : e.signature;
      item.iconPath = new vscode.ThemeIcon(e.userKind === "type" ? "symbol-interface" : "symbol-function");
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

/** A result of tcm/find: a definition, or why the query didn't parse. */
interface FoundItem {
  match: string;
  kind?: string;
  path?: string;
  signature?: string;
  detail?: string;
  hash?: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const [command, ...args] = tcmCommand();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  /** apps started from here, by path */
  const running = new Map<string, RunningApp>();
  const tree = new CodebaseTree(running);
  const icon = vscode.Uri.joinPath(context.extensionUri, "media", "tcm.svg");
  const request: Request = (method, params) => client.sendRequest(method, params);
  const pages = new Pages(
    request,
    {
      source: (p) => vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(p.uri)),
      upgradePackage: (p) => vscode.commands.executeCommand("tcm.upgradePackage", p),
      upgradePackageTo: (p) => vscode.commands.executeCommand("tcm.upgradePackageTo", p),
      edit: (p) => vscode.commands.executeCommand("tcm.editDefinition", p.names[0]),
      release: (p) => vscode.commands.executeCommand("tcm.releasePackage", p),
      draftRelease: (p) => vscode.commands.executeCommand("tcm.draftRelease", p),
      packPackage: (p) => vscode.commands.executeCommand("tcm.packPackage", p),
      saveChangelog: (p) => vscode.commands.executeCommand("tcm.saveChangelog", p),
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
  const views = new vscode.EventEmitter<vscode.Uri>();
  const apps = new AppsTree(running);
  const data = new DataTree();
  const packages = new PackagesTree();
  const releases = new ReleasesTree(request);
  const lenses = new DraftLenses(request);
  const releasesChanged = () => {
    releases.refresh();
    lenses.changed.fire();
    pages.refresh();
  };
  /** A package's name, from a tree item, a page, or by asking. */
  const packageOf = async (x: any): Promise<string | undefined> => {
    if (x?.name) return x.name;
    const pkgs = (await client.sendRequest("tcm/publishing", {})) as PublishedPackage[];
    if (pkgs.length === 1) return pkgs[0]!.name;
    return (await vscode.window.showQuickPick(pkgs.map((p) => ({ label: p.name, description: p.latest?.version ?? "unreleased" })), { placeHolder: "Which package?" }))?.label;
  };
  const upgrade = async (name: string, target?: string, namespace?: string) => {
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
  const appOf = (x: any): string | undefined => (typeof x === "string" ? x : x?.path);
  const startApp = async (x: unknown) => {
    const app = appOf(x) ?? (await vscode.window.showInputBox({ prompt: "Start which app?", placeHolder: "app.main" }));
    if (!app) return;
    const existing = running.get(app);
    if (existing?.url) return vscode.commands.executeCommand("simpleBrowser.show", existing.url);
    if (existing) return;
    const output = vscode.window.createOutputChannel(`tcm: ${app}`);
    const [cmd, ...pre] = tcmCommand();
    // port 0: a free port, so several apps can run at once
    const proc = spawn(cmd!, [...pre, "dev", app, "--port", "0"], { cwd: folder, env: { ...process.env, NO_COLOR: "1" } });
    const run: RunningApp = { proc, output, url: undefined };
    running.set(app, run);
    apps.refresh();
    tree.refresh();
    const onData = (d: Buffer) => {
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

  const client = new LanguageClient(
    "tcm",
    "tcm-ts",
    { command: command!, args: [...args, "lsp"], options: { cwd: folder } },
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
  session.client = client;

  const pathOf = (x: any): string | undefined => (typeof x === "string" ? x : x?.path);
  const isTestPath = (p: string) => p.split(".").includes("tests") || /^test([A-Z0-9_$]|$)/.test(p.slice(p.lastIndexOf(".") + 1));
  const debug = async (kind: "run" | "test" | "app", name: string | undefined, uri?: string) => {
    try {
      const config = (await client.sendRequest("tcm/debug", { kind, name, uri })) as vscode.DebugConfiguration;
      await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], config);
    } catch (e) {
      vscode.window.showErrorMessage(`tcm: can't debug ${name ?? "that"}: ${(e as Error).message}`);
    }
  };
  const run = (cmd: string, cmdArgs: unknown[]): Promise<any> => client.sendRequest("workspace/executeCommand", { command: cmd, arguments: cmdArgs });
  const pickDefinition = async (prompt: string) => {
    const from = await vscode.window.showInputBox({ prompt, placeHolder: "lib.square" });
    return from || undefined;
  };

  context.subscriptions.push(
    vscode.window.createTreeView("tcm.codebase", { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.createTreeView("tcm.apps", { treeDataProvider: apps }),
    vscode.window.createTreeView("tcm.data", { treeDataProvider: data }),
    vscode.window.createTreeView("tcm.packages", { treeDataProvider: packages }),
    vscode.window.createTreeView("tcm.releases", { treeDataProvider: releases, showCollapseAll: true }),
    vscode.languages.registerCodeLensProvider({ language: "markdown", pattern: "**/release-*.md" }, lenses),
    vscode.commands.registerCommand("tcm.openReleasePage", async (x) => {
      const name = await packageOf(x);
      if (name) pages.open({ release: { name } });
    }),
    // what the semver checks found is the version: say it, show the notes, and ask
    vscode.commands.registerCommand("tcm.releasePackage", async (x) => {
      const name = await packageOf(x);
      if (!name) return;
      if (x?.fromDraft) await vscode.workspace.textDocuments.find((d) => d.uri.toString() === x.fromDraft.toString())?.save();
      const check = (await client.sendRequest("tcm/releaseCheck", { name })) as ReleaseCheck & { notes: string };
      if (check.blocked) return vscode.window.showWarningMessage(check.blocked);
      const go = await vscode.window.showInformationMessage(
        `Release ${name}@${check.version}?`,
        { modal: true, detail: `${check.after ? `After ${check.after}: ` : ""}${check.reason}.\n\n${check.notes}` },
        "Release",
      );
      if (go !== "Release") return;
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Releasing ${name}…` }, () => run("tcm.release", [name]));
      releasesChanged();
      if (!r) return;
      const next = await vscode.window.showInformationMessage(`Released ${r.package}@${r.version}.`, "Push", "Pack", "Open page");
      if (next === "Push") {
        const term = vscode.window.createTerminal({ name: "tcm push", cwd: folder });
        term.show();
        term.sendText([...tcmCommand(), "push"].map(quote).join(" "));
      } else if (next === "Pack") vscode.commands.executeCommand("tcm.packPackage", { name: r.package, version: r.version });
      else if (next === "Open page") pages.open({ release: { name: r.package } });
    }),
    // a markdown scratch file for the release's words; the list of changes in it is regenerated when it's made
    vscode.commands.registerCommand("tcm.draftRelease", async (x) => {
      const name = await packageOf(x);
      if (!name) return;
      const open = vscode.workspace.textDocuments.find((d) => d.uri.path.endsWith(`/release-${name.replace(/^@/, "").replace("/", "-")}.md`));
      await open?.save();
      const uri = await run("tcm.releaseDraft", [name]);
      if (!uri) return;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)));
      lenses.changed.fire();
    }),
    vscode.commands.registerCommand("tcm.packPackage", async (x) => {
      const name = await packageOf(x);
      if (!name) return;
      const dir = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Packing ${name}${x?.version ? `@${x.version}` : ""}…` }, () => run("tcm.pack", [name, x?.version]));
      if (dir && (await vscode.window.showInformationMessage(`Packed into ${dir}.`, "Reveal")) === "Reveal") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
    }),
    vscode.commands.registerCommand("tcm.saveChangelog", async (x) => {
      const name = await packageOf(x);
      if (!name) return;
      const { markdown } = (await client.sendRequest("tcm/changelog", { name })) as { markdown: string };
      const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${folder}/CHANGELOG.md`), filters: { Markdown: ["md"] }, title: `${name}'s changelog` });
      if (!to) return;
      await vscode.workspace.fs.writeFile(to, Buffer.from(markdown));
      vscode.window.showTextDocument(to);
    }),
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
      const r = running.get(appOf(x) ?? "");
      if (!r) return;
      r.stopping = true;
      r.proc.kill();
    }),
    vscode.commands.registerCommand("tcm.openApp", async (x) => {
      const live = [...running].filter(([, r]) => r.url);
      const app = appOf(x) ?? (live.length === 1 ? live[0]![0] : (await vscode.window.showQuickPick(live.map(([p]) => p), { placeHolder: "Open which app?" })));
      const url = app && running.get(app)?.url;
      if (url) vscode.commands.executeCommand("simpleBrowser.show", url);
    }),
    vscode.commands.registerCommand("tcm.openAppExternal", (x) => {
      const url = running.get(appOf(x) ?? "")?.url;
      if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("tcm.showAppLog", (x) => running.get(appOf(x) ?? "")?.output.show()),
    vscode.commands.registerCommand("tcm.showTable", (t) =>
      t?.table && showTable(t.table, request, (uri) => vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(uri)), icon),
    ),
    // definitions as documents: tcm:/lib/square.ts is lib.square, rendered with current names
    vscode.workspace.registerTextDocumentContentProvider("tcm", {
      onDidChange: views.event,
      provideTextDocumentContent: async (uri) => ((await client.sendRequest("tcm/source", { uri: uri.toString() })) as { text: string }).text,
    }),
    // pages: a definition (from a tree item, a hash, or a name) or a namespace
    vscode.commands.registerCommand("tcm.openPage", async (x) => {
      if (x?.hash) return pages.open({ hash: x.hash });
      if (x?.kind === "namespace" || typeof x?.namespace === "string") return pages.open({ namespace: x.path ?? x.namespace });
      const name = typeof x === "string" ? x : await vscode.window.showInputBox({ prompt: "Open which definition?", placeHolder: "lib.square" });
      if (!name) return;
      try {
        const page = (await client.sendRequest("tcm/page", { path: name })) as { hash: string };
        await pages.open({ hash: page.hash });
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),
    vscode.commands.registerCommand("tcm.openNamespacePage", (item) => pages.open({ namespace: item?.path ?? "" })),
    // one search box: names, docs, and types (anything that looks like one, or starts with ":")
    vscode.commands.registerCommand("tcm.find", () => {
      const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { hash?: string }>();
      pick.placeholder = "Find a definition: a name, words from its docs, or a type like (xs: T[]) => T";
      pick.matchOnDescription = true;
      pick.matchOnDetail = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let seq = 0;
      pick.onDidChangeValue((q) => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const mine = ++seq;
          pick.busy = true;
          try {
            const items = await client.sendRequest("tcm/find", { query: q });
            if (mine !== seq) return;
            pick.items = (items as FoundItem[]).map((i) =>
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
      packages.refresh();
      releases.refresh();
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
    vscode.commands.registerCommand("tcm.findUsages", async (x, line: number = 0, character: number = 0) => {
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
        const r = (await client.sendRequest("tcm/findByType", { query })) as { hits: unknown[]; variables: string[] };
        if (!r.hits.length) return vscode.window.showInformationMessage(`Nothing in the codebase has type ${query}`);
        const pick = await vscode.window.showQuickPick(
          (r.hits as { path: string; signature: string; notes: string[]; uri: string }[]).map((h) => ({ label: h.path, description: h.signature, detail: h.notes.join(", ") || undefined, uri: h.uri })),
          { placeHolder: r.variables.length ? `type variables: ${r.variables.join(", ")}` : query, matchOnDescription: true },
        );
        if (pick) await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(pick.uri));
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
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
    releasesChanged();
    refreshTables();
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
  releases.refresh();
}

export function deactivate(): Promise<void> | undefined {
  return session.client?.stop();
}
