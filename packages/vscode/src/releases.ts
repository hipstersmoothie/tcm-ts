// The Releases view: the codebase's packages (each a `manifest` definition's namespace), what each one's next
// release would be (its version, and every semver finding behind it), and its releases. The language server
// works it all out (tcm/publishing, tcm/releaseCheck); releasing, drafting notes and packing are its commands.
import * as vscode from "vscode";

/** Sends a request to the language server. */
export type Request = (method: string, params: unknown) => Promise<any>;

export type Level = "major" | "minor" | "patch";

export const LEVEL: Record<Level, { icon: string; color: string; label: string }> = {
  major: { icon: "error", color: "charts.red", label: "breaking" },
  minor: { icon: "diff-added", color: "charts.yellow", label: "addition" },
  patch: { icon: "circle-small-filled", color: "charts.blue", label: "same API" },
};

/** A package of the codebase, as tcm/publishing lists it. */
export interface PublishedPackage {
  name: string;
  namespace: string;
  description?: string;
  latest?: { version: string };
  releases: number;
}

export interface Finding {
  level: Level;
  path: string;
  hash?: string;
  summary: string;
  detail?: string;
  lint: string;
  why: string;
}

/** What a package's next release would be (tcm/releaseCheck), or why that couldn't be worked out. */
export interface ReleaseCheck {
  error?: string;
  name: string;
  version: string;
  level?: Level;
  reason: string;
  after?: string;
  upToDate?: boolean;
  blocked?: string;
  findings: Finding[];
  following: string[];
}

export type ReleaseNode =
  | ({ kind: "package" } & PublishedPackage)
  | { kind: "next"; name: string; check: ReleaseCheck | { error: string } | undefined }
  | ({ kind: "finding"; name: string } & Finding)
  | { kind: "release"; name: string; version: string; ts: number; summary?: string; notes: string }
  | { kind: "problem"; message: string };

export class ReleasesTree implements vscode.TreeDataProvider<ReleaseNode> {
  request: Request;
  changed = new vscode.EventEmitter<ReleaseNode | undefined | void>();
  onDidChangeTreeData = this.changed.event;

  constructor(request: Request) {
    this.request = request;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element?: ReleaseNode): Promise<ReleaseNode[]> {
    try {
      if (!element) return ((await this.request("tcm/publishing", {})) as PublishedPackage[]).map((p) => ({ kind: "package", ...p }));
      if (element.kind === "package") {
        // the releases show at once; working out the next one typechecks, so it fills in when it's done
        const next: ReleaseNode & { kind: "next" } = { kind: "next", name: element.name, check: undefined };
        this.request("tcm/releaseCheck", { name: element.name }).then(
          (check: ReleaseCheck) => ((next.check = check), this.changed.fire(next)),
          (e: Error) => ((next.check = { error: e.message }), this.changed.fire(next)),
        );
        const page = (await this.request("tcm/releaseList", { name: element.name })) as { version: string; ts: number; summary?: string; notes: string }[];
        return [next, ...page.map((r) => ({ kind: "release" as const, name: element.name, ...r }))];
      }
      if (element.kind === "next" && element.check && !element.check.error) {
        return (element.check as ReleaseCheck).findings.map((f) => ({ kind: "finding", name: element.name, ...f }));
      }
    } catch (e) {
      return [{ kind: "problem", message: (e as Error).message }];
    }
    return [];
  }
  getTreeItem(e: ReleaseNode): vscode.TreeItem {
    const None = vscode.TreeItemCollapsibleState.None;
    if (e.kind === "problem") {
      const item = new vscode.TreeItem(e.message, None);
      item.iconPath = new vscode.ThemeIcon("warning");
      return item;
    }
    if (e.kind === "package") {
      const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `release-package:${e.name}`;
      item.description = `${e.latest ? e.latest.version : "unreleased"} · ${e.namespace || "the codebase"}`;
      item.tooltip = new vscode.MarkdownString(`**${e.name}**${e.description ? `\n\n${e.description}` : ""}\n\n${e.releases} release(s); the \`${e.namespace || "(root)"}\` namespace`);
      item.iconPath = new vscode.ThemeIcon("package");
      item.contextValue = "releasePackage";
      item.command = { command: "tcm.openReleasePage", title: "Open page", arguments: [e] };
      return item;
    }
    if (e.kind === "next") {
      const c = e.check;
      if (!c || c.error) {
        const item = new vscode.TreeItem("Next release", None);
        item.description = c?.error ?? "checking…";
        item.iconPath = new vscode.ThemeIcon(c?.error ? "warning" : "loading~spin");
        return item;
      }
      const check = c as ReleaseCheck;
      if (check.upToDate) {
        const item = new vscode.TreeItem("Up to date", None);
        item.description = `nothing new since ${check.after}`;
        item.tooltip = check.following.length ? `${check.following.length} definition(s) only follow changes in other packages` : undefined;
        item.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
        return item;
      }
      const n = check.findings.length;
      const item = new vscode.TreeItem(`Next: ${check.version}`, n ? vscode.TreeItemCollapsibleState.Expanded : None);
      item.description = check.blocked ? "work left in todo" : `${check.reason}${n ? ` · ${n} finding(s)` : ""}`;
      item.tooltip = new vscode.MarkdownString(`**${check.name}@${check.version}**${check.after ? ` after ${check.after}` : ""}: ${check.reason}${check.blocked ? `\n\n$(warning) ${check.blocked}` : ""}${check.following.length ? `\n\n${check.following.length} definition(s) follow these changes` : ""}`, true);
      const lv = check.level && LEVEL[check.level];
      item.iconPath = check.blocked ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange")) : lv ? new vscode.ThemeIcon("rocket", new vscode.ThemeColor(lv.color)) : new vscode.ThemeIcon("rocket");
      item.contextValue = check.blocked ? "releaseNext.blocked" : "releaseNext";
      return item;
    }
    if (e.kind === "finding") {
      const lv = LEVEL[e.level];
      const item = new vscode.TreeItem(e.path, None);
      item.description = `${e.summary}${e.detail ? `: ${e.detail}` : ""}`;
      item.tooltip = new vscode.MarkdownString(`**${e.path}** ${e.summary}${e.detail ? `: \`${e.detail}\`` : ""}\n\n\`${e.lint}\` (${e.level}, ${lv.label}): ${e.why}`);
      item.iconPath = new vscode.ThemeIcon(lv.icon, new vscode.ThemeColor(lv.color));
      if (e.hash) item.command = { command: "tcm.openPage", title: "Open page", arguments: [{ hash: e.hash }] };
      return item;
    }
    // a release
    const item = new vscode.TreeItem(e.version, None);
    item.id = `release:${e.name}@${e.version}`;
    item.description = `${new Date(e.ts).toISOString().slice(0, 10)}${e.summary ? ` · ${e.summary}` : ""}`;
    item.tooltip = new vscode.MarkdownString(e.notes);
    item.iconPath = new vscode.ThemeIcon("tag");
    item.contextValue = "release";
    item.command = { command: "tcm.openReleasePage", title: "Open page", arguments: [{ name: e.name, version: e.version }] };
    return item;
  }
}

/** The draft of a package's next release, as tcm names it: release-<name>.md (a scope's @ and / dropped). */
export const draftName = (pkg: string) => `release-${pkg.replace(/^@/, "").replace("/", "-")}.md`;

/** Above a release draft: release the package, its notes taking the words written there. */
export class DraftLenses implements vscode.CodeLensProvider {
  request: Request;
  changed = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.changed.event;

  constructor(request: Request) {
    this.request = request;
  }
  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const file = doc.uri.path.slice(doc.uri.path.lastIndexOf("/") + 1);
    let pkgs: PublishedPackage[];
    try {
      pkgs = await this.request("tcm/publishing", {});
    } catch {
      return [];
    }
    const pkg = pkgs.find((p) => draftName(p.name) === file);
    if (!pkg) return [];
    let check: ReleaseCheck;
    try {
      check = await this.request("tcm/releaseCheck", { name: pkg.name });
    } catch {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, { title: `$(rocket) Release ${pkg.name} (${check.version} as things stand: ${check.reason})`, command: "tcm.releasePackage", arguments: [{ name: pkg.name, fromDraft: doc.uri }] }),
      new vscode.CodeLens(top, { title: "Regenerate the changes", command: "tcm.draftRelease", arguments: [{ name: pkg.name }] }),
    ];
  }
}
