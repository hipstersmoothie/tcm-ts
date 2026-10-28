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
    const key = target.hash ? `def:${target.hash}` : `ns:${target.namespace}`;
    const open = this.panels.get(key);
    if (open) {
      open.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("ucm.page", target.title ?? "…", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, enableCommandUris: false });
    panel.iconPath = this.icon;
    this.panels.set(key, { panel, target });
    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "open") return this.open(m.hash ? { hash: m.hash } : { namespace: m.namespace });
      if (m.type === "action") return this.actions[m.action]?.(m.page);
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
      if (target.hash) {
        const page = await this.request("ucm/page", { hash: target.hash });
        const name = page.names[0] ?? page.short;
        panel.title = name.slice(name.lastIndexOf(".") + 1);
        panel.webview.postMessage({ type: "page", card: { kind: "def", page, docHtml: page.docMarkdown ? await markdown(page.docMarkdown) : "" } });
      } else {
        const page = await this.request("ucm/namespace", { namespace: target.namespace });
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
  const actions = ["source", "edit", "usages", p.kind === "term" ? "run" : "", "rename", "copy"].filter(Boolean)
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
  if (p.externals.length) lists.push('<div class="list"><h4>Packages</h4><ul>' + p.externals.map((e) => "<li>" + esc(e) + "</li>").join("") + "</ul></div>");
  if (lists.length) h += '<div class="lists">' + lists.join("") + "</div>";
  return h;
}

const ROLES = [["app", "Apps"], ["type", "Types"], ["table", "Data"], ["schedule", "Jobs"], ["server", "Server"], ["browser", "Browser"], ["shared", "Shared"], ["test", "Tests"]];
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
  root.innerHTML = '<div class="card">' + (c.error ? '<div class="problem">' + esc(c.error) + "</div>" : c.kind === "def" ? defCard(c) : namespaceCard(c)) + "</div>";
  root.firstChild.addEventListener("click", (ev) => {
    const a = ev.target.closest("a, button");
    if (!a) return;
    if (a.dataset.hash) return vscode.postMessage({ type: "open", hash: a.dataset.hash });
    if (a.dataset.namespace !== undefined) return vscode.postMessage({ type: "open", namespace: a.dataset.namespace });
    const href = a.getAttribute("href") || "";
    if (href.startsWith("ucm-page:")) { ev.preventDefault(); return vscode.postMessage({ type: "open", hash: href.slice(9) }); }
    if (a.dataset.action) return vscode.postMessage({ type: "action", action: a.dataset.action, page: c.page });
  });
});
</script></body></html>`;
}

module.exports = { Pages, html };
