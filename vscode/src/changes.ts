import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { Request } from "./releases.ts";
import { tcmCommand } from "./extension.ts";

/**
 * A branch, for the editor: whether it's this one, how many names differ from this one's, and when it last changed.
 */
export interface BranchItem {
  name: string;
  current: boolean;
  differs: number;
  ts?: number;
}

/**
 * Each kind of name change: what it says, and its icon and colour (git's, for added, edited, removed).
 */
export const CHANGES: Record<NameChange["change"], [string, string, string | undefined]> = {
  edited: ["edited", "diff-modified", "gitDecoration.modifiedResourceForeground"],
  propagated: ["re-hashed", "sync", "descriptionForeground"],
  added: ["added", "diff-added", "gitDecoration.addedResourceForeground"],
  removed: ["removed", "diff-removed", "gitDecoration.deletedResourceForeground"],
  renamed: ["renamed", "diff-renamed", "gitDecoration.renamedResourceForeground"],
  aliased: ["another name", "link", undefined],
  conflicted: ["conflict", "warning", "gitDecoration.conflictingResourceForeground"],
}

/**
 * What the Changes view shows: its two groups, branches, history entries, the names an entry changed, and "more".
 */
export type ChangesNode =
  | { kind: "group"; group: "branches" | "history" }
  | ({ kind: "branch" } & BranchItem)
  | ({ kind: "entry" } & HistoryItem)
  | { kind: "change"; change: NameChange }
  | { kind: "more" };

/**
 * The Changes view: the codebase's branches (how many names differ from this one's) and this branch's history,
 * each entry the command that made it and, opened, the names it changed. An edited definition opens as a diff of
 * its code before and after; anything else opens its page.
 */
export class ChangesTree implements vscode.TreeDataProvider<ChangesNode> {
  request: Request;
  changed = new vscode.EventEmitter<ChangesNode | undefined>();
  onDidChangeTreeData = this.changed.event;
  /** how many history entries are shown: "more" shows more */
  limit = 30;
  branch = "";

  constructor(request: Request) {
    this.request = request;
  }

  /** What a history entry changed, or what another branch has that this one doesn't. */
  changesOf(e: ChangesNode): Promise<NameChange[]> {
    if (e.kind === "entry") return this.request("tcm/historyEntry", { hash: e.hash });
    if (e.kind === "branch") return this.request("tcm/branchChanges", { branch: e.name });
    return Promise.resolve([]);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(e?: ChangesNode): Promise<ChangesNode[]> {
    if (!e) return [{ kind: "group", group: "branches" }, { kind: "group", group: "history" }];
    if (e.kind === "group" && e.group === "branches") {
      const branches = (await this.request("tcm/branches", {})) as BranchItem[];
      this.branch = branches.find((b) => b.current)?.name ?? "";
      return branches.map((b) => ({ kind: "branch", ...b }));
    }
    if (e.kind === "group") {
      const entries = (await this.request("tcm/history", { limit: this.limit })) as HistoryItem[];
      return [...entries.map((h): ChangesNode => ({ kind: "entry", ...h })), ...(entries.length === this.limit ? [{ kind: "more" } as const] : [])];
    }
    if (e.kind === "entry" || (e.kind === "branch" && !e.current)) return (await this.changesOf(e)).map((change) => ({ kind: "change", change }));
    return [];
  }

  getTreeItem(e: ChangesNode): vscode.TreeItem {
    if (e.kind === "group") {
      const item = new vscode.TreeItem(e.group === "branches" ? "Branches" : "History", vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${e.group}`;
      if (e.group === "history" && this.branch) item.description = this.branch;
      return item;
    }
    if (e.kind === "more") {
      const item = new vscode.TreeItem("Show more…");
      item.command = { command: "tcm.moreHistory", title: "Show more" };
      return item;
    }
    if (e.kind === "branch") {
      // another branch opens to the names that differ
      const item = new vscode.TreeItem(e.name, e.current || !e.differs ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `branch:${e.name}`;
      item.iconPath = new vscode.ThemeIcon(e.current ? "check" : "git-branch");
      const when = e.ts ? ago(e.ts) : "";
      item.description = e.current ? ["this branch", when].filter(Boolean).join(" · ") : [`${e.differs} name${e.differs === 1 ? "" : "s"} differ${e.differs === 1 ? "s" : ""}`, when].filter(Boolean).join(" · ");
      item.tooltip = e.current ? `${e.name}: the branch this codebase is on` : `${e.name}: ${e.differs} name(s) differ from this branch's`;
      item.contextValue = e.current ? "branch.current" : "branch";
      return item;
    }
    if (e.kind === "entry") {
      const item = new vscode.TreeItem(e.command, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `entry:${e.hash}`;
      item.description = `${ago(e.ts)} · ${e.short}`;
      item.iconPath = new vscode.ThemeIcon(e.parents.length > 1 ? "git-merge" : "history");
      item.tooltip = new vscode.MarkdownString(`**${e.command}**\n\n${new Date(e.ts).toLocaleString()} · \`${e.short}\` · ${e.back} back (\`tcm reset ${e.back}\` undoes it and what came after)`);
      item.contextValue = "historyEntry";
      return item;
    }
    const c = e.change;
    const [what, icon, colour] = CHANGES[c.change];
    const item = new vscode.TreeItem(c.path);
    item.iconPath = new vscode.ThemeIcon(icon, colour ? new vscode.ThemeColor(colour) : undefined);
    item.description =
      c.change === "renamed" ? `renamed from ${c.from}`
      : c.change === "propagated" ? `re-hashed: uses ${c.because!.join(", ")}`
      : c.change === "aliased" ? `another name for ${c.existing!.join(", ")}`
      : what;
    if ((c.change === "edited" || c.change === "propagated") && c.oldUri && c.uri) {
      item.command = { command: "vscode.diff", title: "Open changes", arguments: [vscode.Uri.parse(c.oldUri), vscode.Uri.parse(c.uri), `${c.path} (before ↔ after)`] };
    } else if (c.hash) {
      item.command = { command: "tcm.openPage", title: "Open page", arguments: [{ hash: c.hash }] };
    }
    return item;
  }
}

/**
 * A history entry, for the editor: `back` is how many entries back it is on its branch (what `tcm reset` takes).
 */
export interface HistoryItem {
  hash: string;
  short: string;
  command: string;
  ts: number;
  parents: string[];
  back: number;
}

/**
 * A name that changed, as `tcm diff` sorts it: its code edited, re-hashed only because what it uses changed
 * (`because`), added, removed, renamed (`from`), given another name (`existing`), or conflicted. `old` and `hash` are
 * the hashes before and after, `oldUri` and `uri` their documents (a file has none: it opens as a page).
 */
export interface NameChange {
  change: "edited" | "propagated" | "added" | "removed" | "renamed" | "aliased" | "conflicted";
  path: string;
  hash?: string;
  old?: string;
  uri?: string;
  oldUri?: string;
  from?: string;
  because?: string[];
  existing?: string[];
  hashes?: string[];
}

/**
 * How long ago `ts` was, as a person says it.
 */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The Changes view's commands: the changes a history entry made or a branch has (`tcm diff`, as a document),
 * resetting the names to an entry, merging a branch into this one, and showing more history.
 */
export function changesCommands(tree: ChangesTree, cwd: string | undefined): vscode.Disposable[] {
  const show = async (title: string, args: string[]) => {
    const r = await runTcm(args, cwd);
    const doc = await vscode.workspace.openTextDocument({ content: `# ${title}\n\n${r.out}`, language: "diff" });
    await vscode.window.showTextDocument(doc, { preview: true });
  };
  return [
    // the definitions whose code the changes touched, in VS Code's multi-file diff editor: edits old beside new,
    // additions and removals whole (renames, and dependents only re-hashed, are in the tree: their code is the same)
    vscode.commands.registerCommand("tcm.showChanges", async (x?: ChangesNode) => {
      if (x?.kind !== "entry" && x?.kind !== "branch") return;
      const title = x.kind === "entry" ? `${x.command} (${x.short})` : `${tree.branch || "this branch"} → ${x.name}`;
      const changes = (await tree.changesOf(x)).filter((c) => (c.change === "edited" || c.change === "added" || c.change === "removed") && c.uri);
      if (!changes.length) return vscode.window.showInformationMessage(`${title}: no code changed`);
      const uri = (u: string | undefined) => (u ? vscode.Uri.parse(u) : undefined);
      const label = (path: string) => vscode.Uri.from({ scheme: "tcm", path: `/${path.replaceAll(".", "/")}.ts` });
      const resources = changes.map((c) =>
        c.change === "edited" ? [label(c.path), uri(c.oldUri), uri(c.uri)]
        : c.change === "removed" ? [label(c.path), uri(c.uri), undefined]
        : [label(c.path), undefined, uri(c.uri)],
      );
      return vscode.commands.executeCommand("vscode.changes", title, resources);
    }),
    vscode.commands.registerCommand("tcm.showChangesText", (x?: ChangesNode) => {
      if (x?.kind === "entry") return show(`${x.command} (${x.short})`, ["diff", x.parents[0]!, x.hash]);
      if (x?.kind === "branch") return show(`this branch → ${x.name}`, ["diff", x.name]);
      return show("the last command's changes", ["diff"]);
    }),
    vscode.commands.registerCommand("tcm.resetTo", async (x?: ChangesNode) => {
      if (x?.kind !== "entry") return;
      const ok = await vscode.window.showWarningMessage(
        `Bring back the names as they were after "${x.command}" (${x.short})?`,
        { modal: true, detail: "A new history entry on top: nothing is rewritten, and it can be undone the same way. Code isn't deleted." },
        "Reset",
      );
      if (ok !== "Reset") return;
      const r = await runTcm(["reset", x.hash], cwd);
      if (r.code) vscode.window.showErrorMessage(`tcm reset: ${r.out.trim()}`);
      else vscode.window.showInformationMessage(r.out.trim().split("\n").at(-1) ?? "reset");
    }),
    vscode.commands.registerCommand("tcm.mergeBranch", async (x?: ChangesNode) => {
      if (x?.kind !== "branch" || x.current) return;
      const ok = await vscode.window.showWarningMessage(`Merge ${x.name} into ${tree.branch || "this branch"}?`, { modal: true, detail: `${x.differs} name(s) differ. Conflicts, if any, are listed by tcm todo.` }, "Merge");
      if (ok !== "Merge") return;
      const r = await runTcm(["merge", x.name], cwd);
      if (r.code) vscode.window.showErrorMessage(`tcm merge: ${r.out.trim()}`);
      else vscode.window.showInformationMessage(r.out.trim().split("\n").at(-1) ?? "merged");
    }),
    vscode.commands.registerCommand("tcm.moreHistory", () => {
      tree.limit += 30;
      tree.refresh();
    }),
    vscode.commands.registerCommand("tcm.refreshChanges", () => tree.refresh()),
  ];
}

/**
 * Run tcm in `cwd` and collect what it prints (without colour).
 */
export function runTcm(args: string[], cwd: string | undefined): Promise<{ code: number | null; out: string }> {
  const [cmd, ...pre] = tcmCommand();
  return new Promise((resolve) => {
    const p = spawn(cmd!, [...pre, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (out += d));
    p.on("error", (e) => resolve({ code: 1, out: e.message }));
    p.on("exit", (code) => resolve({ code, out }));
  });
}
