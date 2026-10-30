// The table viewer: a webview grid over one table's rows. Sorting, searching and paging happen in the language
// server (in SQLite), so big tables stay fast; the webview only draws what it's sent.
import * as vscode from "vscode";
import type { Request } from "./releases.ts";

interface Query {
  offset: number;
  limit: number;
  search: string;
  sort?: { field: string; desc: boolean };
}

interface Viewer {
  table: string;
  panel: vscode.WebviewPanel;
  query: Query;
  load?: () => Promise<void>;
}

/** The open viewers, by table. */
export const panels = new Map<string, Viewer>();
export const PAGE = 100;

/** Open (or reveal) the viewer for a table. `request` sends a request to the language server. */
export function showTable(table: string, request: Request, openUri: (uri: string) => unknown, icon?: vscode.Uri): void {
  const existing = panels.get(table);
  if (existing) {
    existing.panel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel("tcm.table", `${table} (table)`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const state: Viewer = { table, panel, query: { offset: 0, limit: PAGE, search: "", sort: undefined } };
  panels.set(table, state);
  if (icon) panel.iconPath = icon;
  panel.onDidDispose(() => panels.delete(table));

  const load = async () => {
    try {
      const [tables, page] = await Promise.all([request("tcm/data", {}), request("tcm/rows", { table, ...state.query })]);
      panel.webview.postMessage({ type: "data", info: (tables as { table: string }[]).find((t) => t.table === table) ?? { table, rows: 0, older: 0 }, page, query: state.query });
    } catch (e) {
      panel.webview.postMessage({ type: "error", message: (e as Error).message });
    }
  };
  state.load = load;
  panel.webview.onDidReceiveMessage(async (m: { type: string; query?: Partial<Query>; uri?: string }) => {
    if (m.type === "query") {
      state.query = { ...state.query, ...m.query };
      await load();
    } else if (m.type === "openDefinition" && m.uri) openUri(m.uri);
    else if (m.type === "migrate") {
      await vscode.commands.executeCommand("tcm.migrateTable", { table });
      await load();
    }
  });
  panel.webview.html = html(panel.webview);
  load();
}

/** Reload every open viewer (the data changed). */
export function refreshTables(): void {
  for (const p of panels.values()) p.load?.();
}

export function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  header { padding: 10px 14px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  h1 { font-size: 1.25em; margin: 0 0 4px; font-weight: 600; }
  .meta { opacity: .8; } .meta a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .older { color: var(--vscode-editorWarning-foreground); }
  .bar { display: flex; gap: 8px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  input { flex: 1; max-width: 360px; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  button { padding: 3px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .4; cursor: default; }
  .count { opacity: .75; margin-left: auto; }
  main { display: flex; height: calc(100vh - 92px); }
  .grid { flex: 1; overflow: auto; }
  table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground); text-align: left; padding: 5px 10px; cursor: pointer; white-space: nowrap; border-bottom: 1px solid var(--vscode-panel-border); }
  th .type { opacity: .6; font-weight: normal; }
  th.sorted::after { content: " ▲"; } th.sorted.desc::after { content: " ▼"; }
  td { padding: 4px 10px; border-bottom: 1px solid var(--vscode-editorGroup-border); white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
  td.id { opacity: .65; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .badge { font-size: .8em; padding: 0 5px; border-radius: 3px; margin-left: 6px; background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  aside { width: 38%; min-width: 260px; border-left: 1px solid var(--vscode-panel-border); overflow: auto; padding: 10px 14px; display: none; }
  aside.open { display: block; }
  aside pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; margin: 6px 0 0; }
  .empty { padding: 24px 14px; opacity: .7; }
</style></head>
<body>
<header><h1 id="title"></h1><div class="meta" id="meta"></div></header>
<div class="bar">
  <input id="search" placeholder="Search rows" />
  <button class="secondary" id="prev">‹ Prev</button><button class="secondary" id="next">Next ›</button>
  <button id="migrate" style="display:none">Migrate rows</button>
  <span class="count" id="count"></span>
</div>
<main><div class="grid" id="grid"></div><aside id="detail"></aside></main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let state = { query: {}, page: { rows: [], total: 0, fields: [] }, selected: undefined };
const send = (query) => vscode.postMessage({ type: "query", query });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let timer;
$("search").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => send({ search: e.target.value, offset: 0 }), 250); });
$("prev").onclick = () => send({ offset: Math.max(0, state.query.offset - state.query.limit) });
$("next").onclick = () => send({ offset: state.query.offset + state.query.limit });
$("migrate").onclick = () => vscode.postMessage({ type: "migrate" });

function render() {
  const { info, page, query } = state;
  $("title").textContent = info.table;
  const declared = info.path ? 'declared by <a id="def">' + esc(info.path) + "</a>" : "not declared by any definition now";
  $("meta").innerHTML = declared + " · " + info.rows + " row" + (info.rows === 1 ? "" : "s") +
    (info.older ? ' · <span class="older">' + info.older + " stored as an older row type</span>" : "");
  if ($("def")) $("def").onclick = () => vscode.postMessage({ type: "openDefinition", uri: info.uri });
  $("migrate").style.display = info.older ? "" : "none";
  const first = page.total ? query.offset + 1 : 0;
  $("count").textContent = (query.search ? page.total + " matching · " : "") + first + "–" + (query.offset + page.rows.length) + " of " + page.total;
  $("prev").disabled = query.offset === 0;
  $("next").disabled = query.offset + page.rows.length >= page.total;
  if (!page.rows.length) {
    $("grid").innerHTML = '<div class="empty">' + (query.search ? "No rows match." : "No rows yet.") + "</div>";
    return;
  }
  const cols = [{ name: "id" }, ...page.fields, { name: "updated", type: "written" }];
  const sort = query.sort || {};
  let h = "<table><thead><tr>";
  for (const c of cols) {
    const cls = sort.field === c.name ? "sorted" + (sort.desc ? " desc" : "") : "";
    h += '<th class="' + cls + '" data-field="' + esc(c.name) + '">' + esc(c.name) + (c.type ? ' <span class="type">' + esc(c.type) + "</span>" : "") + "</th>";
  }
  h += "</tr></thead><tbody>";
  for (const r of page.rows) {
    h += '<tr data-id="' + esc(r.id) + '"' + (state.selected === r.id ? ' class="selected"' : "") + ">";
    h += '<td class="id">' + esc(r.id) + (r.older ? '<span class="badge">older</span>' : "") + "</td>";
    for (const f of page.fields) h += '<td title="' + esc(r.cells[f.name] ?? "") + '">' + esc(r.cells[f.name] ?? "") + "</td>";
    h += "<td>" + esc(new Date(r.updated).toLocaleString()) + "</td></tr>";
  }
  $("grid").innerHTML = h + "</tbody></table>";
  for (const th of document.querySelectorAll("th")) th.onclick = () => {
    const field = th.dataset.field;
    send({ sort: { field, desc: sort.field === field ? !sort.desc : false }, offset: 0 });
  };
  for (const tr of document.querySelectorAll("tbody tr")) tr.onclick = () => { state.selected = tr.dataset.id; render(); };
  const sel = page.rows.find((r) => r.id === state.selected);
  $("detail").className = sel ? "open" : "";
  $("detail").innerHTML = sel ? "<strong>" + esc(sel.id) + "</strong>" + (sel.older ? '<span class="badge">older row type</span>' : "") + "<pre>" + esc(sel.detail) + "</pre>" : "";
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type === "error") { $("grid").innerHTML = '<div class="empty">' + esc(m.message) + "</div>"; return; }
  state = { ...state, info: m.info, page: m.page, query: m.query };
  render();
});
</script></body></html>`;
}
