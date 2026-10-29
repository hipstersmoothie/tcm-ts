// Definition and namespace pages, as in Unison's codebase UI: each opens in its own tab (opening one that's open
// focuses it), and links in a page open more. The language server builds the pages; docs are markdown, rendered
// by VS Code's own renderer.
const vscode = require("vscode");

class Pages {
  /**
   * `request` sends a request to the language server; `actions` run editor commands for a page's buttons;
   * `icon` is the tab icon.
   */
  constructor(request, actions, icon) {
    this.request = request;
    this.actions = actions;
    this.icon = icon;
    this.panels = new Map(); // key → { panel, target }
  }

  async open(target) {
    const key = target.release ? `rel:${target.release.name}` : target.package ? `pkg:${target.package.name}@${target.package.range}` : target.hash ? `def:${target.hash}` : `ns:${target.namespace}`;
    const open = this.panels.get(key);
    if (open) {
      open.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("tcm.page", target.title ?? "…", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, enableCommandUris: false });
    panel.iconPath = this.icon;
    this.panels.set(key, { panel, target });
    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "open") return this.open(m.package ? { package: m.package } : m.hash ? { hash: m.hash } : { namespace: m.namespace });
      if (m.type === "action") return this.actions[m.action]?.(m.page);
      if (m.type === "external") return vscode.env.openExternal(vscode.Uri.parse(m.url));
    });
    panel.webview.html = html(panel.webview);
    await this.render(key);
  }

  /** Fetch a page (cheap: examples are cached by hash) and draw it; the tab is named after it. */
  async render(key) {
    const open = this.panels.get(key);
    if (!open) return;
    const { panel, target } = open;
    try {
      if (target.release) {
        const page = await this.request("tcm/releasePage", { name: target.release.name });
        panel.title = `${page.name} (releases)`;
        const [nextHtml, ...notesHtml] = await Promise.all([markdown(page.next.notes), ...page.releases.map((r) => markdown(r.body))]);
        panel.webview.postMessage({ type: "page", card: { kind: "release", page, nextHtml, notesHtml } });
      } else if (target.package) {
        const page = await this.request("tcm/packagePage", target.package);
        panel.title = `${page.name} ${page.range} (package)`;
        const docs = await Promise.all(page.api.map((a) => (a.doc ? markdown(a.doc) : "")));
        panel.webview.postMessage({ type: "page", card: { kind: "package", page, readmeHtml: page.readme ? await markdown(page.readme) : "", docs } });
      } else if (target.hash) {
        const page = await this.request("tcm/page", { hash: target.hash });
        const name = page.names[0] ?? page.short;
        panel.title = name.slice(name.lastIndexOf(".") + 1);
        panel.webview.postMessage({ type: "page", card: { kind: "def", page, docHtml: page.docMarkdown ? await markdown(page.docMarkdown) : "" } });
      } else {
        const page = await this.request("tcm/namespace", { namespace: target.namespace });
        panel.title = `${target.namespace || "(root)"} (namespace)`;
        panel.webview.postMessage({ type: "page", card: { kind: "namespace", page, readmeHtml: page.readme ? await markdown(page.readme) : "" } });
      }
    } catch (e) {
      panel.webview.postMessage({ type: "page", card: { error: e.message } });
    }
  }

  refresh() {
    for (const key of this.panels.keys()) this.render(key);
  }
}

/** Markdown to HTML with VS Code's renderer (the markdown preview's), falling back to escaped text. */
async function markdown(md) {
  try {
    return await vscode.commands.executeCommand("markdown.api.render", md);
  } catch {
    return `<pre>${md.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre>`;
  }
}

function html(webview) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 8px 16px 24px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: flex-end; padding: 4px 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .empty { padding: 32px; opacity: .7; line-height: 1.6; }
  .card { margin: 0 auto; max-width: 1100px; padding: 6px 4px 0; }
  .card.focus { outline: 1px solid var(--vscode-focusBorder); }
  .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  .head h2 { font-size: 1.15em; margin: 0; font-weight: 600; font-family: var(--vscode-editor-font-family); }
  .badge { font-size: .8em; padding: 1px 7px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .badge.server { background: var(--vscode-charts-purple); color: #fff; } .badge.browser { background: var(--vscode-charts-blue); color: #fff; }
  .badge.passed { background: var(--vscode-testing-iconPassed); color: #fff; } .badge.failed { background: var(--vscode-testing-iconFailed); color: #fff; }
  .hash { opacity: .55; font-family: var(--vscode-editor-font-family); }
  .actions { margin-left: auto; display: flex; gap: 2px; }
  .actions button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 2px 6px; font-size: .9em; }
  .actions button:hover { text-decoration: underline; }
  .section { padding: 8px 14px; }
  .why { opacity: .75; font-size: .92em; }
  .doc { padding: 4px 14px 2px; line-height: 1.55; }
  .doc pre, .src { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
  .doc code { font-family: var(--vscode-editor-font-family); }
  .doc a, a.ref, .list a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .doc a:hover, a.ref:hover, .list a:hover { text-decoration: underline; }
  .doc blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--vscode-editorWarning-foreground); }
  .doc table { border-collapse: collapse; } .doc th, .doc td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; }
  .src { margin: 0 14px 10px; white-space: pre; }
  /* VS Code doesn't give webviews the theme's syntax colours, so these are its default themes' (Dark+, Light+,
     High Contrast), picked by the theme's kind. Code in rendered docs (highlight.js classes) uses the same. */
  body { --k: #569cd6; --x: #c586c0; --s: #ce9178; --n: #b5cea8; --c: #6a9955; --f: #dcdcaa; --t: #4ec9b0; }
  body.vscode-light { --k: #0000ff; --x: #af00db; --s: #a31515; --n: #098658; --c: #008000; --f: #795e26; --t: #267f99; }
  body.vscode-high-contrast { --k: #569cd6; --x: #c586c0; --s: #ce9178; --n: #b5cea8; --c: #7ca668; --f: #dcdcaa; --t: #4ec9b0; }
  body.vscode-high-contrast-light { --k: #0f4a85; --x: #b5200d; --s: #0f4a85; --n: #096d48; --c: #515151; --f: #5e2cbc; --t: #185e73; }
  .k, .hljs-keyword, .hljs-built_in, .hljs-literal { color: var(--k); }
  .x, .hljs-meta { color: var(--x); }
  .s, .hljs-string, .hljs-regexp { color: var(--s); }
  .n, .hljs-number { color: var(--n); }
  .c, .hljs-comment { color: var(--c); font-style: italic; }
  .f, .hljs-title.function_, .hljs-title { color: var(--f); }
  a.ref.t, .hljs-type, .hljs-title.class_ { color: var(--t); }
  .lists { display: flex; gap: 28px; padding: 4px 14px 12px; flex-wrap: wrap; font-size: .92em; }
  .list h4 { margin: 4px 0; font-size: .85em; text-transform: uppercase; opacity: .65; letter-spacing: .04em; }
  .list ul { list-style: none; margin: 0; padding: 0; } .list li { margin: 2px 0; }
  .sig { opacity: .6; font-family: var(--vscode-editor-font-family); }
  .problem { color: var(--vscode-errorForeground); padding: 4px 14px; }
  .group h3 { margin: 10px 14px 4px; font-size: .95em; opacity: .8; }
  .group ul { list-style: none; margin: 0 14px 8px; padding: 0; }
  .group li { margin: 3px 0; } .group .summary { opacity: .75; }
  /* package (releases) pages */
  .lede { margin: 10px 14px 4px; font-size: 1.05em; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 10px 14px 18px; font-size: .92em; }
  .facts dt { opacity: .6; } .facts dd { margin: 0; }
  code { font-family: var(--vscode-editor-font-family); font-size: .95em; background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
  .muted { opacity: .65; }
  .next { margin: 0 14px 24px; padding: 12px 16px 10px; border: 1px solid var(--vscode-panel-border); border-left: 4px solid var(--vscode-charts-blue); border-radius: 6px; background: var(--vscode-sideBar-background, transparent); }
  .next.level-major { border-left-color: var(--vscode-charts-red); } .next.level-minor { border-left-color: var(--vscode-charts-yellow); }
  .next.done { border-left-color: var(--vscode-charts-green); } .next.blocked { border-left-color: var(--vscode-charts-orange); }
  .next-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .next-head h3 { margin: 0; font-size: 1.1em; }
  .next-actions { margin-left: auto; display: flex; gap: 6px; }
  button.primary, .next-actions button { font: inherit; font-size: .9em; padding: 3px 10px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .next-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .next h4 { margin: 14px 0 4px; font-size: .78em; text-transform: uppercase; letter-spacing: .06em; }
  .level-major { color: var(--vscode-charts-red); } .level-minor { color: var(--vscode-charts-yellow); } .level-patch { color: var(--vscode-charts-blue); }
  ul.findings { list-style: none; margin: 0; padding: 0; }
  ul.findings li { padding: 4px 0; border-top: 1px solid var(--vscode-panel-border); }
  ul.findings li:first-child { border-top: none; }
  ul.findings a { color: var(--vscode-textLink-foreground); cursor: pointer; font-family: var(--vscode-editor-font-family); }
  ul.findings a:hover { text-decoration: underline; }
  ul.findings .why { opacity: .65; font-size: .88em; margin-top: 1px; } .lint { font-family: var(--vscode-editor-font-family); }
  details.preview { margin-top: 10px; } details.preview summary, .timeline summary { cursor: pointer; }
  .section-title { margin: 0 14px 8px; font-size: 1.1em; }
  ol.timeline { list-style: none; margin: 0 14px; padding: 0 0 0 16px; border-left: 2px solid var(--vscode-panel-border); }
  ol.timeline > li { position: relative; margin: 0 0 14px; }
  ol.timeline > li::before { content: ""; position: absolute; left: -22px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-charts-blue); }
  .timeline summary { display: flex; align-items: baseline; gap: 10px; }
  .timeline .version { font-weight: 600; font-size: 1.05em; font-family: var(--vscode-editor-font-family); }
  .notes { padding: 4px 0 0; }
  .notes h3 { font-size: .78em; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 12px 0 2px; }
  .notes ul { margin: 2px 0 6px; padding-left: 18px; } .notes p { margin: 4px 0 8px; }
</style></head>
<body>
<div id="cards"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const RUNS = { server: "on the server", browser: "in the browser", anywhere: "anywhere" };

function link(item, from) {
  return '<a data-hash="' + item.hash + '" data-from="' + from + '">' + esc(item.name) + '</a> <span class="sig">' + esc(item.kind === "type" ? "type" : item.signature ?? "") + "</span>";
}

function defCard(c) {
  const p = c.page;
  const badges = [
    '<span class="badge">' + (p.kind === "type" ? "type" : p.kind === "class" ? "class" : "term") + "</span>",
    p.place && p.place !== "anywhere" ? '<span class="badge ' + p.place + '">' + p.place + "</span>" : "",
    p.endpoint ? '<span class="badge">' + (p.streaming ? "streaming endpoint" : "endpoint") + "</span>" : "",
    p.test ? '<span class="badge ' + p.test + '">test ' + p.test + "</span>" : "",
  ].join("");
  const actions = ["source", "edit", "usages", p.kind === "term" ? "run" : "", p.kind === "term" ? "debug" : "", "rename", "copy"].filter(Boolean)
    .map((a) => '<button data-action="' + a + '">' + a[0].toUpperCase() + a.slice(1) + "</button>").join("");
  let h = '<div class="head"><h2>' + esc(p.names[0] ?? p.short) + '</h2><span class="hash">' + esc(p.short) + "</span>" + badges +
    '<div class="actions">' + actions + "</div></div>";
  if (p.names.length > 1) h += '<div class="section why">also named ' + p.names.slice(1).map(esc).join(", ") + "</div>";
  if (p.place) h += '<div class="section why">Runs ' + RUNS[p.place] + (p.why ? ": it " + esc(p.why) : "") + "." + (p.endpoint ? " The browser calls it by hash." : "") + "</div>";
  if (c.docHtml) h += '<div class="doc">' + c.docHtml + "</div>";
  for (const prob of p.docProblems) h += '<div class="problem">' + esc(prob) + "</div>";
  h += '<pre class="src">' + p.sourceHtml + "</pre>";
  const lists = [];
  if (p.uses.length) lists.push('<div class="list"><h4>Uses</h4><ul>' + p.uses.map((u) => "<li>" + link(u, c.key) + "</li>").join("") + "</ul></div>");
  if (p.usedBy.length) lists.push('<div class="list"><h4>Used by</h4><ul>' + p.usedBy.map((u) => "<li>" + link(u, c.key) + "</li>").join("") + "</ul></div>");
  // react@19 opens the package page; builtins and #tcm/server are just named
  const pkgLink = (e) => { const m = /^((?:@[^/@]+\\/)?[^@/]+)@([^/#]+)/.exec(e); return m ? '<a data-package-name="' + esc(m[1]) + '" data-package-range="' + esc(m[2]) + '">' + esc(e) + "</a>" : esc(e); };
  if (p.externals.length) lists.push('<div class="list"><h4>Packages</h4><ul>' + p.externals.map((e) => "<li>" + pkgLink(e) + "</li>").join("") + "</ul></div>");
  if (lists.length) h += '<div class="lists">' + lists.join("") + "</div>";
  return h;
}

const ROLES = [["app", "Apps"], ["type", "Types"], ["table", "Data"], ["schedule", "Jobs"], ["server", "Server"], ["browser", "Browser"], ["shared", "Shared"], ["test", "Tests"]];
function packageCard(c) {
  const p = c.page;
  let h = '<div class="head"><h2>' + esc(p.name) + '</h2><span class="badge">range ' + esc(p.range) + '</span><span class="hash">' + esc(p.version) + "</span>" +
    (p.license ? '<span class="badge">' + esc(p.license) + "</span>" : "") +
    '<div class="actions"><button data-action="upgradePackage">Upgrade</button><button data-action="upgradePackageTo">Move to another range</button>' +
    (p.homepage ? '<button data-url="' + esc(p.homepage) + '">Homepage</button>' : "") + '<button data-url="https://www.npmjs.com/package/' + esc(p.name) + '/v/' + esc(p.version) + '">npm</button></div></div>';
  if (p.description) h += '<div class="section why">' + esc(p.description) + "</div>";
  const facts = [p.types ? "types from @types (" + esc(p.types) + ")" : "", p.integrity ? "tarball " + esc(p.integrity.slice(0, 24)) + "…" : "",
    p.otherRanges.length ? "also runs " + p.otherRanges.map((r) => '<a data-package-name="' + esc(p.name) + '" data-package-range="' + esc(r) + '">' + esc(r) + "</a>").join(", ") : ""].filter(Boolean);
  if (facts.length) h += '<div class="section why">' + facts.join(" · ") + "</div>";
  if (p.users.length) h += '<div class="lists"><div class="list"><h4>Used by</h4><ul>' + p.users.map((u) => "<li>" + link({ hash: u.hash, name: u.path, kind: u.kind, signature: u.signature }, c.key) + "</li>").join("") + "</ul></div></div>";
  if (c.readmeHtml) h += '<div class="group"><h3>README</h3></div><div class="doc">' + c.readmeHtml + "</div>";
  if (p.api.length) {
    h += '<div class="group"><h3>API (' + p.api.length + ")</h3></div>";
    h += p.api.map((a, i) => '<div class="section"><b class="f">' + esc(a.name) + '</b> <span class="badge">' + esc(a.kind) + "</span>" +
      (a.signature ? '<pre class="src">' + esc(a.signature) + "</pre>" : "") + (c.docs[i] ? '<div class="doc">' + c.docs[i] + "</div>" : "") + "</div>").join("");
  }
  return h;
}

const LEVELS = [["major", "Breaking", "level-major"], ["minor", "Additions", "level-minor"], ["patch", "Same API", "level-patch"]];
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
function releaseCard(c) {
  const p = c.page;
  const n = p.next;
  const latest = p.releases[0];
  const sub = (s) => (s === "." ? p.name : p.name + s.slice(1));
  let h = '<div class="head"><h2>' + esc(p.name) + '</h2><span class="badge">' + esc(latest ? latest.version : "unreleased") + "</span>" +
    '<div class="actions"><button data-action="packPackage">Pack</button>' + (p.releases.length ? '<button data-action="saveChangelog">Save changelog</button>' : "") +
    '<button data-hash="' + esc(p.manifestHash) + '">Manifest</button></div></div>';
  if (p.description) h += '<p class="lede">' + esc(p.description) + "</p>";
  const facts = [
    ["Namespace", "<code>" + esc(p.namespace || "(the codebase)") + "</code>"],
    ["Exports", p.exports.map((e) => "<code>" + esc(sub(e.subpath)) + "</code> " + e.count + " definition" + (e.count === 1 ? "" : "s")).join(", ")],
    p.bin.length ? ["Commands", p.bin.map((b) => "<code>" + esc(b.command) + "</code> runs " + esc(b.target)).join(", ")] : null,
    p.with.length ? ["Also needs", p.with.map((w) => "<code>" + esc(w) + "</code>").join(", ")] : null,
    ["Releases", p.releases.length ? p.releases.length + ", latest " + esc(latest.version) + " on " + day(latest.ts) : "none yet"],
  ].filter(Boolean);
  h += '<dl class="facts">' + facts.map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("") + "</dl>";

  // the next release: what it would be, and why
  const tone = n.blocked ? "blocked" : n.upToDate ? "done" : n.level ? "level-" + n.level : "level-patch";
  h += '<section class="next ' + tone + '"><div class="next-head">';
  if (n.upToDate) h += '<h3>Up to date</h3><span class="muted">nothing new since ' + esc(n.after) + "</span>";
  else h += "<h3>Next release: " + esc(n.version) + '</h3><span class="muted">' + (n.after ? "after " + esc(n.after) + " · " : "") + esc(n.reason) + "</span>";
  if (!n.upToDate) h += '<div class="next-actions">' + (n.blocked ? "" : '<button class="primary" data-action="release">Release ' + esc(n.version) + "</button>") + '<button data-action="draftRelease">Write notes</button></div>';
  h += "</div>";
  if (n.blocked) h += '<p class="problem">' + esc(n.blocked) + "</p>";
  for (const [level, label, cls] of LEVELS) {
    const fs = n.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    h += '<h4 class="' + cls + '">' + label + '</h4><ul class="findings">' + fs.map((f) =>
      '<li><div>' + (f.hash ? '<a data-hash="' + esc(f.hash) + '">' + esc(f.path) + "</a>" : "<code>" + esc(f.path) + "</code>") + " " + esc(f.summary) +
      (f.detail ? ": <code>" + esc(f.detail) + "</code>" : "") + '</div><div class="why">' + esc(f.why) + ' · <span class="lint">' + esc(f.lint) + "</span></div></li>").join("") + "</ul>";
  }
  if (n.following.length) h += '<p class="muted">' + n.following.length + " definition(s) only follow these changes.</p>";
  if (!n.upToDate && c.nextHtml) h += '<details class="preview"><summary>Preview its notes</summary><div class="doc notes">' + c.nextHtml + "</div></details>";
  h += "</section>";

  // the changelog
  h += '<h3 class="section-title">Releases</h3>';
  if (!p.releases.length) h += '<p class="muted">None yet.</p>';
  h += '<ol class="timeline">' + p.releases.map((r, i) =>
    '<li><details' + (i < 3 ? " open" : "") + '><summary><span class="version">' + esc(r.version) + '</span><span class="muted">' + day(r.ts) + " · " + esc(r.author) + " · " + esc(r.causal) + "</span></summary>" +
    '<div class="doc notes">' + c.notesHtml[i] + "</div></details></li>").join("") + "</ol>";
  return h;
}

function namespaceCard(c) {
  const p = c.page;
  let h = '<div class="head"><h2>' + esc(p.namespace || "(root)") + '</h2><span class="badge">namespace</span></div>';
  if (c.readmeHtml) h += '<div class="doc">' + c.readmeHtml + "</div>";
  if (p.namespaces.length) h += '<div class="group"><h3>Namespaces</h3><ul>' + p.namespaces.map((n) => '<li><a data-namespace="' + esc(n.path) + '" data-from="' + c.key + '">' + esc(n.name) + "</a> <span class=\\"sig\\">" + n.count + "</span></li>").join("") + "</ul></div>";
  for (const [role, label] of ROLES) {
    const defs = p.definitions.filter((d) => d.role === role);
    if (!defs.length) continue;
    h += '<div class="group"><h3>' + label + "</h3><ul>" + defs.map((d) => "<li>" + link(d, c.key) + (d.summary ? '<div class="summary">' + esc(d.summary) + "</div>" : "") + "</li>").join("") + "</ul></div>";
  }
  return h;
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type !== "page") return;
  const c = m.card;
  const root = document.getElementById("cards");
  root.innerHTML = '<div class="card">' + (c.error ? '<div class="problem">' + esc(c.error) + "</div>" : c.kind === "def" ? defCard(c) : c.kind === "package" ? packageCard(c) : c.kind === "release" ? releaseCard(c) : namespaceCard(c)) + "</div>";
  root.firstChild.addEventListener("click", (ev) => {
    const a = ev.target.closest("a, button");
    if (!a) return;
    if (a.dataset.hash) return vscode.postMessage({ type: "open", hash: a.dataset.hash });
    if (a.dataset.namespace !== undefined) return vscode.postMessage({ type: "open", namespace: a.dataset.namespace });
    if (a.dataset.packageName) return vscode.postMessage({ type: "open", package: { name: a.dataset.packageName, range: a.dataset.packageRange } });
    if (a.dataset.url) return vscode.postMessage({ type: "external", url: a.dataset.url });
    const href = a.getAttribute("href") || "";
    if (href.startsWith("tcm-page:")) { ev.preventDefault(); return vscode.postMessage({ type: "open", hash: href.slice(9) }); }
    if (a.dataset.action) return vscode.postMessage({ type: "action", action: a.dataset.action, page: c.page });
  });
});
</script></body></html>`;
}

module.exports = { Pages, html };
