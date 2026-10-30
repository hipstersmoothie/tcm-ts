// Contributions, as Unison Share has them: a branch proposed for merging into another, reviewed as a diff of
// definitions (not text), commented on, and merged by history on the server. They live in the served
// codebase; `tcm contribute` and `tcm contribution …` work against any remote (a `tcm serve` URL or another
// codebase directory), and `tcm serve` has a review page for each.
import os from "node:os";
import { shortHash } from "@tcm/core";
import type { Comment, Contribution } from "@tcm/store";
import type { Codebase } from "./codebase.ts";
import { diffNamespaces, diffReport, printReport, stateOf, type ReportLine } from "./diff.ts";
import { mergeBranch, planMerge } from "./merge.ts";
import { bold, cyan, dim, green, red, yellow } from "./style.ts";

/** Who's commenting or merging: $TCM_AUTHOR, else the OS user. (The server's token is shared; names aren't checked.) */
export function author(): string {
  return process.env.TCM_AUTHOR || os.userInfo().username;
}

export class ContributionError extends Error {}

/** Whether a contribution can be merged as it stands. */
export type Mergeable = { kind: "up-to-date" | "fast-forward" | "clean" } | { kind: "conflicts"; names: string[] };

export interface ContributionView {
  contribution: Contribution;
  comments: Comment[];
  /** the changes, from where the branch left its target (or, once merged, what the merge brought) */
  report: ReportLine[];
  /** names the changes touch, for commenting on */
  changed: string[];
  mergeable: Mergeable | null;
}

function find(cb: Codebase, id: number): Contribution {
  const c = cb.store.contribution(id);
  if (!c) throw new ContributionError(`no contribution #${id}`);
  return c;
}

// ---- the served side ---------------------------------------------------------------------------------------

/** Open a contribution of `source` into `target` (both branches here), or find the open one there already is. */
export function openContribution(cb: Codebase, c: { title: string; description: string; source: string; target: string; author: string }): { id: number; created: boolean } {
  for (const b of [c.source, c.target]) if (!cb.store.hasBranch(b)) throw new ContributionError(`no branch '${b}' here`);
  if (c.source === c.target) throw new ContributionError("a branch can't be contributed to itself");
  const open = cb.store.openContribution(c.source, c.target);
  if (open) {
    cb.store.touchContribution(open.id);
    return { id: open.id, created: false };
  }
  return { id: cb.store.createContribution(c), created: true };
}

export function viewContribution(cb: Codebase, id: number): ContributionView {
  const c = find(cb, id);
  const stateAt = (causal: string) => stateOf(cb.store.namespaceRows(cb.store.causal(causal)!.namespace));
  const irOf = (h: string) => cb.store.getDef(h)!.ir;
  let from: string;
  let to: string;
  if (c.status === "merged" && c.mergedFrom && c.mergedAs) [from, to] = [c.mergedFrom, c.mergedAs];
  else if (cb.store.hasBranch(c.source) && cb.store.hasBranch(c.target)) {
    to = cb.store.head(c.source);
    from = cb.store.mergeBase(cb.store.head(c.target), to);
  } else return { contribution: c, comments: cb.store.comments(id), report: [[["dim", "  its branches are gone"]]], changed: [], mergeable: null };
  const [before, after] = [stateAt(from), stateAt(to)];
  const d = diffNamespaces(before, after, irOf);
  const title = c.status === "merged" ? `merged into ${c.target} as ${shortHash(to)}` : `changes on ${c.source} since it left ${c.target} (${shortHash(from)})`;
  const changed = [...new Set([...d.edited, ...d.propagated, ...d.added, ...d.removed, ...d.conflicted].map((x) => x.path).concat(d.renamed.map((r) => r.to)))].sort();
  return { contribution: c, comments: cb.store.comments(id), report: diffReport(cb, d, before, after, title), changed, mergeable: c.status === "open" ? mergeable(cb, c) : null };
}

function mergeable(cb: Codebase, c: Contribution): Mergeable {
  const plan = planMerge(cb, c.target, c.source);
  if (plan.kind !== "merge") return { kind: plan.kind };
  return plan.result.conflicts.length ? { kind: "conflicts", names: plan.result.conflicts } : { kind: "clean" };
}

/** Run `fn` without its console output: a merge made for a remote client reports through the result, not here. */
function quietly<T>(fn: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

/** Run `fn` with `branch` current, then go back to the branch that was. */
function onBranch<T>(cb: Codebase, branch: string, fn: () => T): T {
  const was = cb.store.branch().name;
  if (was === branch) return fn();
  cb.store.switchBranch(branch);
  try {
    return fn();
  } finally {
    cb.store.switchBranch(was);
    cb.refreshShim(true);
  }
}

/**
 * Merge a contribution into its target, by history: a fast-forward, or a three-way merge with no conflicts.
 * With conflicts it's refused, saying how to bring the target in first.
 */
export function mergeContribution(cb: Codebase, id: number, by: string): { mergedAs: string; todo: number } {
  const c = find(cb, id);
  if (c.status !== "open") throw new ContributionError(`#${id} is ${c.status}`);
  const m = mergeable(cb, c);
  if (m.kind === "conflicts") {
    throw new ContributionError(
      `#${id} conflicts with ${c.target} in ${m.names.join(", ")}: merge ${c.target} into ${c.source} (\`tcm pull <remote> ${c.target}\` on that branch), resolve, push, and merge again`,
    );
  }
  const from = cb.store.head(c.target);
  const todo = onBranch(cb, c.target, () => {
    cb.store.endBatch();
    if (m.kind !== "up-to-date") quietly(() => mergeBranch(cb, c.source, `merge #${id}: ${c.title}`));
    return cb.store.todos().length;
  });
  const as = cb.store.head(c.target);
  cb.store.setContributionStatus(id, "merged", { from, as });
  cb.store.addComment(id, { author: by, body: `merged into ${c.target} as ${shortHash(as)}` });
  return { mergedAs: as, todo };
}

export function closeContribution(cb: Codebase, id: number, by: string, reopen = false) {
  const c = find(cb, id);
  if (reopen ? c.status !== "closed" : c.status !== "open") throw new ContributionError(`#${id} is ${c.status}`);
  cb.store.setContributionStatus(id, reopen ? "open" : "closed");
  cb.store.addComment(id, { author: by, body: reopen ? "reopened" : "closed" });
}

export function commentOn(cb: Codebase, id: number, c: { author: string; body: string; about?: string | null }): number {
  find(cb, id);
  if (!c.body.trim()) throw new ContributionError("an empty comment");
  return cb.store.addComment(id, c);
}

// ---- the terminal ------------------------------------------------------------------------------------------

const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16);
const STATUS: Record<Contribution["status"], (s: string) => string> = { open: green, merged: cyan, closed: dim };

export function printContributions(list: Contribution[], where: string) {
  if (!list.length) return console.log(dim(`no contributions on ${where}`));
  for (const c of list) {
    console.log(`${bold(`#${c.id}`.padEnd(5))} ${STATUS[c.status](c.status.padEnd(7))} ${c.title}  ${dim(`${c.source} → ${c.target} · ${c.author} · ${when(c.updated)}`)}`);
  }
}

export function printContribution(v: ContributionView) {
  const c = v.contribution;
  console.log(`${bold(`#${c.id} ${c.title}`)}  ${STATUS[c.status](c.status)}`);
  console.log(dim(`  ${c.source} → ${c.target} · opened by ${c.author} ${when(c.created)} · ${v.comments.length} comment(s)`));
  if (c.description) console.log(`\n${c.description.replace(/^/gm, "  ")}`);
  const m = v.mergeable;
  if (m) {
    const says = {
      "up-to-date": dim(`${c.target} already has these changes`),
      "fast-forward": green(`✓ merges as a fast-forward`),
      clean: green(`✓ merges cleanly`),
      conflicts: red(`✗ conflicts with ${c.target} in ${m.kind === "conflicts" ? m.names.join(", ") : ""}`),
    }[m.kind];
    console.log(`\n  ${says}`);
  }
  console.log();
  printReport(v.report);
  if (v.comments.length) console.log(`\n${bold("Comments")}`);
  for (const k of v.comments) {
    console.log(`  ${bold(k.author)} ${dim(when(k.ts))}${k.about ? ` ${yellow(`on ${k.about}`)}` : ""}`);
    console.log(k.body.replace(/^/gm, "    "));
  }
}

// ---- the review page (tcm serve) -------------------------------------------------------------------------

/**
 * The review page `tcm serve` serves at /contributions and /contributions/<id>. It holds no data: it reads the
 * token from the URL's fragment (never sent to the server; then kept in this browser) and calls the same
 * routes the CLI does.
 */
export function reviewPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contributions · tcm</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --bg2: #f6f8fa; --red: #cf222e; --green: #1a7f37; --yellow: #9a6700; --cyan: #0969da; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --bg2: #161b22; --red: #ff7b72; --green: #3fb950; --yellow: #d29922; --cyan: #58a6ff; } }
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg); max-width: 980px; margin: 2rem auto; padding: 0 1rem; }
  a { color: var(--cyan); text-decoration: none; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .muted, .dim { color: var(--muted); }
  .status { font-size: .8rem; padding: .1rem .5rem; border-radius: 1rem; border: 1px solid var(--line); margin-left: .5rem; vertical-align: middle; }
  .status.open { color: var(--green); } .status.merged { color: var(--cyan); }
  table { border-collapse: collapse; width: 100%; } td { padding: .5rem; border-top: 1px solid var(--line); }
  pre.diff { background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 1rem; overflow-x: auto; font: 13px/1.45 ui-monospace, monospace; }
  .bold { font-weight: 600; } .red { color: var(--red); } .green { color: var(--green); } .yellow { color: var(--yellow); } .cyan { color: var(--cyan); }
  .comment { border: 1px solid var(--line); border-radius: 6px; padding: .5rem .75rem; margin: .75rem 0; white-space: pre-wrap; }
  .comment header { color: var(--muted); font-size: .85rem; white-space: normal; }
  textarea, input, select { font: inherit; width: 100%; box-sizing: border-box; padding: .4rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  textarea { min-height: 5rem; } .row { display: flex; gap: .5rem; margin: .5rem 0; } .row > * { flex: 1; }
  button { font: inherit; padding: .4rem 1rem; border-radius: 6px; border: 1px solid var(--line); background: var(--bg2); color: inherit; cursor: pointer; }
  button.primary { background: var(--green); color: white; border-color: var(--green); }
  .error { color: var(--red); }
</style>
</head>
<body>
<main id="main"><p class="muted">Loading…</p></main>
<script>
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("token")) {
    localStorage.setItem("tcm.token", params.get("token"));
    history.replaceState(null, "", location.pathname);
  }
  const token = localStorage.getItem("tcm.token");
  const main = document.getElementById("main");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const when = (ts) => new Date(ts).toISOString().replace("T", " ").slice(0, 16);
  async function api(route, body) {
    const res = await fetch("/" + route, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  const status = (s) => '<span class="status ' + s + '">' + s + "</span>";
  const report = (lines) => lines.map((l) => l.map(([t, s]) => '<span class="' + t + '">' + esc(s) + "</span>").join("")).join("\\n");
  const me = () => localStorage.getItem("tcm.author") || "";

  async function list() {
    const { contributions } = await api("contributions", {});
    document.title = "Contributions · tcm";
    main.innerHTML = "<h1>Contributions</h1>" + (contributions.length
      ? "<table>" + contributions.map((c) => '<tr><td><a href="/contributions/' + c.id + '">#' + c.id + " " + esc(c.title) + "</a>" + status(c.status) +
          '</td><td class="muted">' + esc(c.source) + " → " + esc(c.target) + " · " + esc(c.author) + " · " + when(c.updated) + "</td></tr>").join("") + "</table>"
      : '<p class="muted">None yet: <code>tcm contribute</code> proposes a branch.</p>');
  }

  async function view(id) {
    const v = await api("contribution", { id });
    const c = v.contribution;
    document.title = "#" + c.id + " " + c.title + " · tcm";
    const m = v.mergeable;
    const says = !m ? "" : m.kind === "conflicts" ? '<p class="red">✗ conflicts with ' + esc(c.target) + " in " + m.names.map(esc).join(", ") + "</p>"
      : m.kind === "up-to-date" ? '<p class="muted">' + esc(c.target) + " already has these changes</p>"
      : '<p class="green">✓ merges ' + (m.kind === "clean" ? "cleanly" : "as a fast-forward") + "</p>";
    main.innerHTML =
      '<p><a href="/contributions">← Contributions</a></p><h1>#' + c.id + " " + esc(c.title) + status(c.status) + "</h1>" +
      '<p class="muted">' + esc(c.source) + " → " + esc(c.target) + " · opened by " + esc(c.author) + " " + when(c.created) + "</p>" +
      (c.description ? "<p>" + esc(c.description) + "</p>" : "") + says +
      '<pre class="diff">' + report(v.report) + "</pre>" +
      "<h2>Comments</h2>" + v.comments.map((k) => '<div class="comment"><header><b>' + esc(k.author) + "</b> " + when(k.ts) + (k.about ? ' · on <span class="yellow">' + esc(k.about) + "</span>" : "") + "</header>" + esc(k.body) + "</div>").join("") +
      '<form id="comment"><textarea name="body" placeholder="Leave a comment" required></textarea><div class="row">' +
      '<input name="author" placeholder="Your name" value="' + esc(me()) + '" required><select name="about"><option value="">about the whole change</option>' +
      v.changed.map((n) => "<option>" + esc(n) + "</option>").join("") + "</select></div>" +
      '<div class="row" style="justify-content: flex-start; flex: 0"><button type="submit">Comment</button>' +
      (c.status === "open" && m && m.kind !== "conflicts" ? '<button type="button" class="primary" id="merge">Merge into ' + esc(c.target) + "</button>" : "") +
      (c.status === "open" ? '<button type="button" id="close">Close</button>' : c.status === "closed" ? '<button type="button" id="reopen">Reopen</button>' : "") +
      '</div><p class="error" id="error"></p></form>';
    const form = document.getElementById("comment");
    const who = () => { const a = form.author.value.trim(); localStorage.setItem("tcm.author", a); return a; };
    const act = (fn) => async (e) => {
      e.preventDefault();
      if (!form.author.reportValidity()) return;
      try { await fn(); await view(id); } catch (err) { document.getElementById("error").textContent = err.message; }
    };
    form.addEventListener("submit", act(() => api("comment", { id, author: who(), body: form.body.value, about: form.about.value || null })));
    for (const [button, route] of [["merge", "merge-contribution"], ["close", "close-contribution"], ["reopen", "reopen-contribution"]]) {
      const b = document.getElementById(button);
      if (b) b.addEventListener("click", act(() => api(route, { id, author: who() })));
    }
  }

  const route = location.pathname.match(/^\\/contributions\\/(\\d+)/);
  if (!token) main.innerHTML = '<p class="error">No token: open this page from the link <code>tcm contribute</code> prints.</p>';
  else (route ? view(Number(route[1])) : list()).catch((e) => { main.innerHTML = '<p class="error">' + esc(e.message) + "</p>"; });
</script>
</body>
</html>
`;
}
