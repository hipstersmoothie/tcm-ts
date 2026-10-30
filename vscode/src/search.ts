import * as vscode from "vscode";
import type { Request } from "./releases.ts";

/**
 * A definition or page with matching lines; `uri` is its document's (a page has none: it opens as a page).
 */
export interface SearchHit {
  path: string;
  hash: string;
  kind: string;
  uri?: string;
  lines: SearchLine[];
}

/**
 * A line that matched: its number in the document, the part of it shown, and where the matches are in that.
 */
export interface SearchLine {
  line: number;
  column: number;
  text: string;
  ranges: [number, number][];
}

/**
 * What's searched for: the text, and how it matches.
 */
export interface SearchQuery {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/**
 * The Search view: find in files, for the codebase. Every line of its definitions (as they read now, with current
 * names) and pages with the text in them, by definition, as VS Code's search shows files: a definition opens its
 * page, a line its document at that line. Searched again when the codebase changes.
 */
export class SearchView implements vscode.WebviewViewProvider {
  request: Request;
  openPage: (hash: string) => unknown;
  view: vscode.WebviewView | undefined;
  last: SearchQuery | undefined;
  hits: SearchHit[] = [];
  /** the latest search: answers to earlier ones are dropped */
  seq = 0;

  constructor(request: Request, openPage: (hash: string) => unknown) {
    this.request = request;
    this.openPage = openPage;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = searchHtml(view.webview);
    view.webview.onDidReceiveMessage((m: { type: string; query?: SearchQuery; hit?: number; line?: number }) => {
      if (m.type === "search") return this.search(m.query!);
      const hit = this.hits[m.hit ?? -1];
      if (!hit) return;
      if (m.type === "page" || !hit.uri) return this.openPage(hit.hash);
      const line = hit.lines[m.line ?? 0]!;
      const length = line.ranges[0] ? line.ranges[0][1] - line.ranges[0][0] : 0;
      return vscode.window.showTextDocument(vscode.Uri.parse(hit.uri), { selection: new vscode.Range(line.line, line.column, line.line, line.column + length), preview: true });
    });
  }

  async search(q: SearchQuery): Promise<void> {
    this.last = q;
    const n = ++this.seq;
    if (!q.query) {
      this.hits = [];
      this.view?.webview.postMessage({ type: "results", hits: [], matches: 0, truncated: false });
      return;
    }
    try {
      const r = await this.request("tcm/searchCode", q);
      if (n !== this.seq) return;
      this.hits = r.hits;
      this.view?.webview.postMessage({ type: "results", ...r });
    } catch (e) {
      if (n === this.seq) this.view?.webview.postMessage({ type: "results", hits: [], matches: 0, truncated: false, error: (e as Error).message });
    }
  }

  /** Show the view, searching for `text` if given (the editor's selection). */
  async show(text?: string): Promise<void> {
    await vscode.commands.executeCommand("tcm.search.focus");
    this.view?.webview.postMessage({ type: "focus", ...(text ? { query: text } : {}) });
  }

  /** The codebase changed: the last search, again. */
  refresh(): void {
    if (this.last?.query) void this.search(this.last);
  }
}

/**
 * The Search view's page: a search box with VS Code's three toggles, and the results, in its colours.
 */
export function searchHtml(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 0 0 12px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .box { position: sticky; top: 0; z-index: 1; padding: 6px 12px 4px 20px; background: var(--vscode-sideBar-background); }
  .input { display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .input:focus-within { border-color: var(--vscode-focusBorder); }
  input { flex: 1; min-width: 0; padding: 4px 6px; border: none; outline: none; background: none; color: var(--vscode-input-foreground); font: inherit; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .opt { margin: 0 2px; padding: 0 3px; height: 20px; min-width: 20px; border: 1px solid transparent; border-radius: 3px; background: none; color: var(--vscode-foreground); font: 12px var(--vscode-editor-font-family); cursor: pointer; opacity: .75; }
  .opt:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .opt.on { opacity: 1; color: var(--vscode-inputOption-activeForeground); background: var(--vscode-inputOption-activeBackground); border-color: var(--vscode-inputOption-activeBorder); }
  .opt.word { text-decoration: underline; text-underline-offset: 2px; }
  .summary { padding: 6px 0 2px; opacity: .75; font-size: .92em; }
  .summary.error { color: var(--vscode-errorForeground); opacity: 1; }
  .row { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 12px 0 8px; cursor: pointer; white-space: nowrap; overflow: hidden; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .twistie { width: 12px; flex: none; text-align: center; opacity: .8; font-size: .8em; }
  .kind { flex: none; width: 14px; text-align: center; font: bold 11px var(--vscode-editor-font-family); opacity: .8; }
  .kind.file { color: var(--vscode-charts-yellow); } .kind.type { color: var(--vscode-charts-green); } .kind.class { color: var(--vscode-charts-orange); } .kind.term { color: var(--vscode-charts-purple); }
  .name { overflow: hidden; text-overflow: ellipsis; }
  .ns { opacity: .6; overflow: hidden; text-overflow: ellipsis; font-size: .92em; }
  .count { margin-left: auto; flex: none; padding: 0 6px; border-radius: 9px; font-size: .85em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .line { padding-left: 38px; font-family: var(--vscode-editor-font-family); font-size: calc(var(--vscode-editor-font-size) * .95); }
  .line .text { overflow: hidden; text-overflow: ellipsis; }
  .line .num { flex: none; opacity: .5; min-width: 2.5em; text-align: right; }
  mark { color: inherit; background: var(--vscode-editor-findMatchHighlightBackground); border: 1px solid var(--vscode-editor-findMatchHighlightBorder, transparent); border-radius: 2px; }
  .hidden { display: none; }
</style></head><body>
<div class="box">
  <div class="input">
    <input id="q" placeholder="Search the codebase's code" spellcheck="false" autofocus>
    <button class="opt" id="case" title="Match Case">Aa</button>
    <button class="opt word" id="word" title="Match Whole Word">ab</button>
    <button class="opt" id="regex" title="Use Regular Expression">.*</button>
  </div>
  <div class="summary" id="summary"></div>
</div>
<div id="results"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { query: "", caseSensitive: false, wholeWord: false, regex: false, closed: [] };
  const q = document.getElementById("q");
  const results = document.getElementById("results");
  const summary = document.getElementById("summary");
  const toggles = { caseSensitive: document.getElementById("case"), wholeWord: document.getElementById("word"), regex: document.getElementById("regex") };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let timer;
  const save = () => vscode.setState(state);
  const search = () => {
    clearTimeout(timer);
    state.query = q.value;
    save();
    vscode.postMessage({ type: "search", query: { query: state.query, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, regex: state.regex } });
  };
  q.value = state.query;
  for (const [key, el] of Object.entries(toggles)) {
    el.classList.toggle("on", state[key]);
    el.addEventListener("click", () => { state[key] = !state[key]; el.classList.toggle("on", state[key]); search(); q.focus(); });
  }
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 200); });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  // a line with its matches marked
  const marked = (l) => {
    let out = "", at = 0;
    for (const [a, b] of l.ranges) { out += esc(l.text.slice(at, a)) + "<mark>" + esc(l.text.slice(a, b)) + "</mark>"; at = b; }
    return out + esc(l.text.slice(at));
  };
  const kinds = { term: "f", type: "T", class: "C", file: "¶" };
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "focus") {
      if (m.query !== undefined) { q.value = m.query; search(); }
      q.focus();
      q.select();
      return;
    }
    if (m.type !== "results") return;
    summary.classList.toggle("error", !!m.error);
    const defs = m.hits.length;
    summary.textContent = m.error ? m.error
      : !state.query ? ""
      : !m.matches ? "No results"
      : m.matches + " result" + (m.matches === 1 ? "" : "s") + " in " + defs + " definition" + (defs === 1 ? "" : "s") + (m.truncated ? " (the first ones: there are more)" : "");
    const closed = new Set(state.closed);
    results.innerHTML = m.hits.map((h, i) => {
      const dot = h.path.lastIndexOf(".");
      const open = !closed.has(h.path);
      const lines = h.lines.map((l, j) => '<div class="row line" data-hit="' + i + '" data-line="' + j + '" title="' + esc(h.path + ":" + (l.line + 1)) + '"><span class="text">' + marked(l) + '</span></div>').join("");
      return '<div class="hit"><div class="row head" data-hit="' + i + '" title="' + esc(h.path) + '"><span class="twistie" data-toggle="' + esc(h.path) + '">' + (open ? "▾" : "▸") + '</span>'
        + '<span class="kind ' + esc(h.kind) + '">' + (kinds[h.kind] || "·") + '</span><span class="name">' + esc(h.path.slice(dot + 1)) + '</span><span class="ns">' + esc(h.path.slice(0, Math.max(dot, 0))) + '</span>'
        + '<span class="count">' + h.lines.reduce((n, l) => n + l.ranges.length, 0) + '</span></div><div class="' + (open ? "" : "hidden") + '">' + lines + "</div></div>";
    }).join("");
  });
  results.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      const p = toggle.dataset.toggle;
      const closed = new Set(state.closed);
      closed.has(p) ? closed.delete(p) : closed.add(p);
      state.closed = [...closed];
      save();
      toggle.textContent = closed.has(p) ? "▸" : "▾";
      toggle.closest(".hit").lastElementChild.classList.toggle("hidden", closed.has(p));
      return;
    }
    const row = e.target.closest(".row");
    if (!row) return;
    for (const r of results.querySelectorAll(".selected")) r.classList.remove("selected");
    row.classList.add("selected");
    vscode.postMessage(row.classList.contains("head") ? { type: "page", hit: Number(row.dataset.hit) } : { type: "line", hit: Number(row.dataset.hit), line: Number(row.dataset.line) });
  });
  if (state.query) search();
</script>
</body></html>`;
}
