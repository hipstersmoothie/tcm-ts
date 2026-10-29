// The Releases view: the codebase's packages (each a `manifest` definition's namespace), what each one's next
// release would be (its version, and every semver finding behind it), and its releases. The language server
// works it all out (tcm/publishing, tcm/releaseCheck); releasing, drafting notes and packing are its commands.
const vscode = require("vscode");

const LEVEL = {
  major: { icon: "error", color: "charts.red", label: "breaking" },
  minor: { icon: "diff-added", color: "charts.yellow", label: "addition" },
  patch: { icon: "circle-small-filled", color: "charts.blue", label: "same API" },
};

class ReleasesTree {
  /** `request` sends a request to the language server. */
  constructor(request) {
    this.request = request;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  async getChildren(element) {
    try {
      if (!element) return (await this.request("tcm/publishing", {})).map((p) => ({ kind: "package", ...p }));
      if (element.kind === "package") {
        // the releases show at once; working out the next one typechecks, so it fills in when it's done
        const next = { kind: "next", name: element.name, check: undefined };
        this.request("tcm/releaseCheck", { name: element.name }).then(
          (check) => ((next.check = check), this.changed.fire(next)),
          (e) => ((next.check = { error: e.message }), this.changed.fire(next)),
        );
        const page = await this.request("tcm/releaseList", { name: element.name });
        return [next, ...page.map((r) => ({ kind: "release", name: element.name, ...r }))];
      }
      if (element.kind === "next") return (element.check?.findings ?? []).map((f) => ({ kind: "finding", name: element.name, ...f }));
    } catch (e) {
      return [{ kind: "problem", message: e.message }];
    }
    return [];
  }
  getTreeItem(e) {
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
      if (c.upToDate) {
        const item = new vscode.TreeItem("Up to date", None);
        item.description = `nothing new since ${c.after}`;
        item.tooltip = c.following.length ? `${c.following.length} definition(s) only follow changes in other packages` : undefined;
        item.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
        return item;
      }
      const n = c.findings.length;
      const item = new vscode.TreeItem(`Next: ${c.version}`, n ? vscode.TreeItemCollapsibleState.Expanded : None);
      item.description = c.blocked ? "work left in todo" : `${c.reason}${n ? ` · ${n} finding(s)` : ""}`;
      item.tooltip = new vscode.MarkdownString(`**${c.name}@${c.version}**${c.after ? ` after ${c.after}` : ""}: ${c.reason}${c.blocked ? `\n\n$(warning) ${c.blocked}` : ""}${c.following.length ? `\n\n${c.following.length} definition(s) follow these changes` : ""}`, true);
      const lv = c.level && LEVEL[c.level];
      item.iconPath = c.blocked ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange")) : lv ? new vscode.ThemeIcon("rocket", new vscode.ThemeColor(lv.color)) : new vscode.ThemeIcon("rocket");
      item.contextValue = c.blocked ? "releaseNext.blocked" : "releaseNext";
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
const draftName = (pkg) => `release-${pkg.replace(/^@/, "").replace("/", "-")}.md`;

/** Above a release draft: release the package, its notes taking the words written there. */
class DraftLenses {
  constructor(request) {
    this.request = request;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this.changed.event;
  }
  async provideCodeLenses(doc) {
    const file = doc.uri.path.slice(doc.uri.path.lastIndexOf("/") + 1);
    let pkgs;
    try {
      pkgs = await this.request("tcm/publishing", {});
    } catch {
      return [];
    }
    const pkg = pkgs.find((p) => draftName(p.name) === file);
    if (!pkg) return [];
    let check;
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

module.exports = { ReleasesTree, DraftLenses };
