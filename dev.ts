import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { Marked } from "marked";
import type { Tokens } from "marked";
import { createHighlighter } from "shiki";
import { TS_VERSION } from "./core/src/program.ts";
import { analyzeProject } from "./core/src/analyze.ts";

/**
 * tcm's repository: up from here, the directory with its workspace. (Files kept outside the codebase, while some are.)
 */
export function repository(): string {
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    if (path.dirname(d) === d) throw new Error(`${process.cwd()} isn't in tcm's repository`);
  }
}

/**
 * Run a program to the end: whether it passed, and what it printed.
 */
export function sh(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string } {
  const r = spawnSync(program, args, { cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env }, encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

/**
 * Everything a change to tcm must pass, run from its codebase (`pnpm verify`, which is `pnpm tcm run
 * tcmts.dev.verify`), with the codebase's own tcm:
 *
 * 1. nothing needs fixing (`tcm todo`), and every definition renders and re-hashes to itself (`tcm verify`);
 * 2. while the codebase is mirrored to the repository, the files hash to what it holds (`tcm mirror --check`, the
 *    fixed point: this tcm reads its own source as the codebase it is) and typecheck;
 * 3. its tests pass (`tcm test`: the test definitions, and the end-to-end tests, each run against this tcm),
 *    run again only where code they ran changed;
 * 4. its docs (tcmts.docs) build into the site, every link and anchor resolving;
 * 5. the tcm-ts package packed from it installs, works far from the repository, and passes the end-to-end
 *    tests too (`tcm test --bin`), likewise run again only where code changed.
 *
 * When all of that passes, the package is the known-good tcm that `pnpm tcm` runs (dist/known-good).
 */
export async function verify(): Promise<void> {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const codebase = process.cwd();
  const repo = repository();
  const started = Date.now();
  let failed = false;
  const step = (name: string, show: RegExp, run: () => { ok: boolean; out: string }) => {
    const t0 = Date.now();
    const r = run();
    console.log(`${name}: ${r.ok ? "ok" : "FAILED"} (${Math.round((Date.now() - t0) / 1000)}s)`);
    const lines = r.out.split("\n");
    for (const l of lines.filter((l) => show.test(l))) console.log(`  ${l.trim()}`);
    if (!r.ok) for (const l of lines.filter((l) => /^\s*✗ /.test(l) || /error|failed/i.test(l)).slice(0, 30)) console.log(`  ${l.trim()}`);
    failed ||= !r.ok;
    return r.ok;
  };
  const run = (...args: string[]) => sh(process.execPath, [tcm, ...args], codebase);

  step("codebase", /nothing to do|verified/, () => {
    const todo = run("todo");
    const identity = run("verify");
    return { ok: todo.ok && /nothing to do/.test(todo.out) && identity.ok, out: `${todo.out}\n${identity.out}` };
  });
  step("files", /the files hash|difference/, () => {
    const mirror = run("mirror", "--check");
    const typecheck = sh(path.join(repo, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], repo);
    return { ok: mirror.ok && typecheck.ok, out: `${mirror.out}\n${typecheck.out}` };
  });
  step("tests", /^(\d+ passed|suites:)/, () => run("test", "tcmts"));
  const docs = await buildSite(fs.mkdtempSync(path.join(os.tmpdir(), "tcm site ")));
  const docsOut = docs.problems.length ? docs.problems.join("\n") : `${docs.pages} pages, every link and anchor resolving`;
  step("docs", /pages|link/, () => ({ ok: !docs.problems.length, out: docsOut }));

  const dist = path.join(repo, "dist");
  const candidate = path.join(dist, "candidate");
  const bin = path.join(candidate, "node_modules", "tcm-ts", "bin", "tcm.js");
  const packed = step("package", /^(installed|far away|\d+ passed|suites:)/, () => {
    const out = path.join(dist, "package");
    fs.rmSync(candidate, { recursive: true, force: true });
    fs.mkdirSync(candidate, { recursive: true });
    const steps = [
      () => run("pack", "tcm-ts", "--out", out),
      () => sh("npm", ["pack", "--silent", "--pack-destination", candidate], out),
      () => sh("npm", ["init", "-y"], candidate),
      () => sh("npm", ["install", ...fs.readdirSync(candidate).filter((f) => f.endsWith(".tgz")).map((f) => `./${f}`), "--no-audit", "--no-fund", "--loglevel=error"], candidate),
    ];
    let log = "";
    for (const s of steps) {
      const r = s();
      log += r.out;
      if (!r.ok) return { ok: false, out: log };
    }
    log += `installed tcm-ts, packed from the codebase, in ${path.relative(repo, candidate)}\n`;
    // far from the repository: nothing it needs is found by walking up to its node_modules
    const far = fs.mkdtempSync(path.join(os.tmpdir(), "tcm far "));
    const init = sh(process.execPath, [bin, "init"], far);
    fs.writeFileSync(path.join(far, "scratch.ts"), "export const platform = () => process.platform;\n");
    const add = sh(process.execPath, [bin, "add"], far);
    if (!init.ok || !add.ok) return { ok: false, out: `${log}${init.out}${add.out}` };
    log += `far away: the packed tcm makes a codebase in ${far} and checks code against @types/node there\n`;
    const tests = run("test", "tcmts", "--bin", `tcm=${bin}`);
    return { ok: tests.ok, out: `${log}${tests.out}` };
  });

  // the tcm that runs on tcm's codebase from now on: what was just verified
  if (!failed && packed) {
    const git = (...args: string[]) => sh("git", ["-C", repo, ...args], repo);
    const commit = git("rev-parse", "--short", "HEAD").out.trim();
    const changed = !git("diff", "--quiet", "HEAD").ok;
    fs.writeFileSync(path.join(candidate, "VERIFIED"), `${commit}${changed ? " with changes" : ""}, verified ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`);
    const good = path.join(dist, "known-good");
    fs.rmSync(good, { recursive: true, force: true });
    fs.renameSync(candidate, good);
    console.log(`known-good tcm: ${fs.readFileSync(path.join(good, "VERIFIED"), "utf8").trim()}; pnpm tcm and the MCP server run it`);
  }
  console.log(`${failed ? "FAILED" : "all passed"} in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = failed ? 1 : 0;
}

/**
 * Languages code blocks are highlighted in.
 */
export const LANGS = ["ts", "typescript", "js", "json", "sh", "bash", "toml", "lua"];

/**
 * A page of the docs site.
 */
export interface Page {
  /** where it's kept, relative to the repository (its pages are the codebase's, in docs/) */
  src: string;
  /** output file name */
  file: string;
  /** menu label */
  label: string;
  /** section number (0 for the index) */
  n: number;
  /** the docs' section it's in (Start, Guides, ...) */
  section?: string;
}

export const STYLE = `/* tcm-ts docs: a text file with a menu */
:root { --bg: #fff; --fg: #111; --dim: #777; --rule: #999; --link: #00e; --visited: #551a8b; --here: #111; --code: #f4f4f1; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0c0c0c; --fg: #d6d6d6; --dim: #7a7a7a; --rule: #555; --link: #8ab4ff; --visited: #c4a3ff; --here: #fff; --code: #151515; }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0; font: 15px/1.55 "Courier New", Courier, ui-monospace, monospace; display: grid; grid-template-columns: 30ch minmax(0, 76ch); gap: 0 5ch; padding: 32px 24px 64px; justify-content: center; }
a { color: var(--link); } a:visited { color: var(--visited); }
.rule { height: 1.55em; overflow: hidden; color: var(--rule); }
.rule::before { content: "------------------------------------------------------------------------------------------------------------------------"; }
h1 + .rule::before, .side .rule::before { content: "========================================================================================================================"; }

/* the menu */
.side { position: sticky; top: 32px; align-self: start; max-height: calc(100vh - 64px); overflow-y: auto; }
.side .home { color: var(--fg); text-decoration: none; font-weight: bold; }
.side ol { list-style: none; margin: 0; padding: 0; }
.side li { margin: 0 0 1px; }
.side li.section { margin: 14px 0 3px; color: var(--dim); }
.side li.section::before { content: "-- "; }
.side li > a, .side li > span { display: block; padding-left: 2ch; }
.side li.here > span { font-weight: bold; color: var(--here); }
.side li.here > span::before { content: "> "; margin-left: -2ch; }
.side ul { list-style: none; margin: 2px 0 6px 6ch; padding: 0; font-size: 13.5px; }
.side ul li { padding-left: 5ch; text-indent: -5ch; }
.side ul a { display: inline; padding: 0; color: var(--dim); text-decoration: none; } .side ul a:hover { text-decoration: underline; }

/* the page */
main { min-width: 0; }
h1, h2, h3 { font: inherit; font-weight: bold; margin: 26px 0 8px; }
h1 { text-transform: uppercase; margin: 0; }
h2 { text-transform: uppercase; }
p, ul, ol, .table { margin: 0 0 14px; }
ul, ol { padding-left: 4ch; } li { margin: 2px 0; }
code { font: inherit; }
pre { margin: 0 0 14px; padding: 8px 2ch; background: var(--code); overflow-x: auto; font: inherit; }
pre.shiki { background: var(--code) !important; }
pre.shiki code { font: inherit; }
.shiki span { color: var(--shiki-light); }
@media (prefers-color-scheme: dark) { .shiki span { color: var(--shiki-dark); } }
.table { overflow-x: auto; }
table { border-collapse: collapse; }
th { font-weight: normal; text-decoration: underline; text-align: left; }
th, td { padding: 1px 3ch 1px 0; vertical-align: top; }
dl { margin: 0 0 14px; }
dt { margin-top: 10px; font-weight: bold; } dt:first-child { margin-top: 0; }
dd { margin: 0 0 0 4ch; }
blockquote { margin: 0 0 14px; padding-left: 2ch; border-left: 1px solid var(--rule); }
.path { color: var(--dim); }
footer { display: flex; justify-content: space-between; }
.build { color: var(--dim); margin-top: 6px; }
:target { background: color-mix(in srgb, var(--link) 15%, transparent); }

/* narrow screens: the menu goes on top */
@media (max-width: 900px) {
  body { display: block; padding: 20px 16px 48px; }
  .side { position: static; max-height: none; margin-bottom: 20px; }
  .side ol { columns: 2; } .side ul { display: none; }
}
`;

/**
 * Content types the docs dev server sends.
 */
export const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" }

/**
 * Build the docs site into `out`: tcm's docs pages, from the codebase (tcmts.docs, written out with `tcm export`,
 * which takes in any edited by hand first), and the examples page, as plain, text-file-looking HTML. Pages are
 * ordered by the index's tables, numbered like sections of a text file, with a numbered menu down the side.
 * Every relative link and anchor must resolve: what doesn't is a problem, so the docs can't quietly rot.
 */
export async function buildSite(out: string): Promise<{ pages: number; problems: string[] }> {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const repo = repository();
  // the pages as the codebase has them: the docs, and the examples' page
  const exported = new Map<string, string>();
  for (const ns of ["docs", "examples"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tcm ${ns} `));
    const r = sh(process.execPath, [tcm, "export", `tcmts.${ns}`, dir], process.cwd());
    if (!r.ok) return { pages: 0, problems: [`tcm export tcmts.${ns}: ${r.out.trim()}`] };
    exported.set(`${ns}/`, dir);
  }
  const read = (src: string) => {
    for (const [prefix, dir] of exported) if (src.startsWith(prefix)) return fs.readFileSync(path.join(dir, src.slice(prefix.length)), "utf8");
    return fs.readFileSync(path.join(repo, src), "utf8");
  };

  // pages, in the order the index lists them: its `## headings` are sections, the links in their tables pages
  const index = read("docs/README.md");
  const pages: Page[] = [{ src: "docs/README.md", file: "index.html", label: "index", n: 0 }];
  let section: string | undefined;
  for (const line of index.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) section = h[1]!.trim();
    const m = /^\| \[([^\]]+)\]\(([^)]+)\) \|/.exec(line);
    if (!m) continue;
    const src = path.normalize(path.join("docs", m[2]!));
    const name = src === "examples/README.md" ? "examples" : path.basename(src, ".md");
    pages.push({ src, file: `${name}.html`, label: m[1]!.toLowerCase(), n: pages.length, ...(section ? { section } : {}) });
  }
  const bySrc = new Map(pages.map((p) => [p.src, p]));
  // code is highlighted when the site is built (no script on the page): a light and a dark theme, as CSS
  // variables, so the colours follow the system like the rest of the page
  const highlighter = await createHighlighter({ themes: ["github-light", "github-dark"], langs: LANGS });
  const problems: string[] = [];
  const anchors = new Map<string, Set<string>>();
  const links: { from: string; file: string; anchor?: string; text: string }[] = [];
  const render = (page: Page): { html: string; title: string; toc: { id: string; text: string; num: string }[] } => {
    const md = read(page.src);
    const ids = new Set<string>();
    anchors.set(page.file, ids);
    const toc: { id: string; text: string; num: string }[] = [];
    let title = page.label;
    let h2 = 0;
    let h3 = 0;
    const marked = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth, text }: Tokens.Heading) {
          const inner = this.parser.parseInline(tokens);
          const id = slug(plain(text));
          ids.add(id);
          if (depth === 1) {
            title = plain(text);
            return `<h1 id="${id}">${page.n ? `${page.n}. ` : ""}${inner}</h1>\n<div class="rule" aria-hidden="true"></div>\n`;
          }
          const num = depth === 2 ? `${page.n}.${++h2}` : `${page.n}.${h2}.${++h3}`;
          if (depth === 2) h3 = 0;
          if (depth === 2) toc.push({ id, text: plain(text), num });
          return `<h${depth} id="${id}">${page.n ? `${num} ` : ""}${inner}</h${depth}>\n`;
        },
        link({ href, tokens }: Tokens.Link) {
          const text = this.parser.parseInline(tokens);
          if (/^[a-z]+:/i.test(href)) return `<a href="${esc(href)}">${text}</a>`;
          const [target, anchor] = href.split("#") as [string, string | undefined];
          // a link within the docs: to the page it names, or to an anchor on this one
          const resolved = target ? path.normalize(path.join(path.dirname(page.src), target)) : page.src;
          const to = bySrc.get(resolved);
          if (!to) {
            // a file in the repository but not on the site (source code, AGENTS.md): shown as its path
            if (fs.existsSync(path.join(repo, resolved))) return `${text} <span class="path">(${esc(resolved)})</span>`;
            problems.push(`${page.src}: link to ${href}: no such page`);
            return text;
          }
          links.push({ from: page.src, file: to.file, anchor, text: href });
          return `<a href="${to.file}${anchor ? `#${anchor}` : ""}">${text}</a>`;
        },
        code({ text, lang }: Tokens.Code) {
          if (lang && LANGS.includes(lang)) {
            return highlighter.codeToHtml(text, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false }) + "\n";
          }
          return `<pre${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(text)}</pre>\n`;
        },
        table(token: Tokens.Table) {
          const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens);
          // a two-column table is a list of terms and what they mean: shown the man-page way, the term on its line
          // and the description indented under it, so long terms (commands with all their flags) wrap freely
          if (token.header.length === 2) {
            const rows = token.rows.map((r) => `<dt>${cell(r[0]!)}</dt><dd>${cell(r[1]!)}</dd>`).join("\n");
            return `<dl>\n${rows}\n</dl>\n`;
          }
          const head = `<tr>${token.header.map((c) => `<th>${cell(c)}</th>`).join("")}</tr>`;
          const body = token.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("\n");
          return `<div class="table"><table>\n<thead>${head}</thead>\n<tbody>${body}</tbody>\n</table></div>\n`;
        },
      },
    });
    return { html: marked.parse(md) as string, title, toc };
  }

  const version = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();
  const template = (page: Page, body: string, title: string, toc: { id: string; text: string; num: string }[]): string => {
    const menu = pages
      .map((p, i) => {
        const heading = p.section && p.section !== pages[i - 1]?.section ? `<li class="section">${esc(p.section.toLowerCase())}</li>\n` : "";
        const here = p === page;
        const label = `[${p.n}] ${esc(p.label)}`;
        const sections = here && toc.length ? `<ul>${toc.map((t) => `<li><a href="#${t.id}">${t.num} ${esc(t.text.toLowerCase())}</a></li>`).join("")}</ul>` : "";
        return `${heading}<li${here ? ' class="here"' : ""}>${here ? `<span>${label}</span>` : `<a href="${p.file}">${label}</a>`}${sections}</li>`;
      })
      .join("\n");
    const prev = pages[page.n - 1];
    const next = pages[page.n + 1];
    return `<!doctype html>
  <html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.n ? `${title} — tcm-ts` : "tcm-ts")}</title>
  <link rel="stylesheet" href="style.css">
  </head><body>
  <nav class="side" aria-label="pages">
  <a class="home" href="index.html">tcm-ts.txt</a>
  <div class="rule" aria-hidden="true"></div>
  <ol>
  ${menu}
  </ol>
  </nav>
  <main>
  ${body}
  <div class="rule" aria-hidden="true"></div>
  <footer>
  <span>${prev ? `&lt;&lt; <a href="${prev.file}">[${prev.n}] ${esc(prev.label)}</a>` : ""}</span>
  <span>${next ? `<a href="${next.file}">[${next.n}] ${esc(next.label)}</a> &gt;&gt;` : ""}</span>
  </footer>
  ${version ? `<p class="build">built from ${version}</p>` : ""}
  </main>
  </body></html>
  `;
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "style.css"), STYLE);
  for (const page of pages) {
    const r = render(page);
    fs.writeFileSync(path.join(out, page.file), template(page, r.html, r.title, r.toc));
  }
  for (const l of links) {
    if (l.anchor && !anchors.get(l.file)?.has(l.anchor)) problems.push(`${l.from}: link to ${l.text}: no heading #${l.anchor} there`);
  }
  for (const dir of exported.values()) fs.rmSync(dir, { recursive: true, force: true });
  return { pages: pages.length, problems };
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const plain = (s: string) => s.replace(/`/g, "").replace(/\*\*?/g, "").replace(/<[^>]+>/g, "");

/**
 * Build the docs site (`pnpm docs:site`, which is `pnpm tcm run tcmts.dev.site`) into `out`, dist/site by default.
 */
export async function site(out?: string): Promise<void> {
  const to = path.resolve(out ?? path.join(repository(), "dist", "site"));
  const r = await buildSite(to);
  for (const p of r.problems) console.error(`docs site: ${p}`);
  if (!r.problems.length) console.log(`docs site: ${r.pages} pages in ${path.relative(process.cwd(), to) || to}`);
  process.exitCode = r.problems.length ? 1 : 0;
}

/**
 * The docs site while writing docs (`pnpm docs:dev`): serves it, builds it again when a page changes (in the
 * codebase's files, or examples/), and reloads open pages after each build. On `port`, or the next free one.
 */
export async function siteDev(port = "4321"): Promise<void> {
  const repo = repository();
  const out = path.join(repo, "dist", "site");
  const clients = new Set<http.ServerResponse>();
  // pages reload themselves when the site is built again
  const RELOAD = `<script>new EventSource("/__reload").onmessage = () => location.reload();</script>`;
  const build = async () => {
    const r = await buildSite(out);
    for (const p of r.problems) console.error(`docs site: ${p}`);
    if (!r.problems.length) console.log(`docs site: ${r.pages} pages`);
    return !r.problems.length;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__reload") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const file = path.join(out, path.normalize(url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
    if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const body = fs.readFileSync(file);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(type.startsWith("text/html") ? body.toString().replace("</body>", `${RELOAD}</body>`) : body);
  });
  await build();
  let timer: NodeJS.Timeout | undefined;
  for (const dir of ["docs", "examples"]) {
    fs.watch(path.join(repo, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void build().then((ok) => ok && clients.forEach((c) => c.write("data: reload\n\n"))), 100);
    });
  }
  // the next free port if this one is taken (4321 is a popular default)
  let tries = 0;
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE" || ++tries > 20) throw e;
    server.listen(Number(port) + tries, "127.0.0.1");
  });
  server.on("listening", () => {
    const a = server.address() as { port: number };
    console.log(`docs dev server: http://127.0.0.1:${a.port}/  (builds again when a page changes)`);
  });
  server.listen(Number(port), "127.0.0.1");
  await new Promise(() => {});
}

/**
 * GitHub's heading anchors (what the docs' own links use).
 */
export const slug = (text: string) => text.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");

/**
 * Hashes don't depend on the compiler (`pnpm compare-compilers`): tcm's source hashed with TypeScript 7 and with
 * tsrs (TypeScript 7 in Rust, installed into a temporary directory) must be the same, and the golden hashes must
 * pass with tsrs too.
 */
export function compareCompilers(): void {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcm tsrs "));
  fs.writeFileSync(path.join(tmp, "package.json"), '{"private":true}\n');
  const installed = sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "tsrs"], tmp);
  if (!installed.ok) throw new Error(`installing tsrs: ${installed.out}`);
  const tsrs = sh(process.execPath, ["--input-type=module", "-e", 'import("./node_modules/tsrs/lib/getExePath.js").then((m) => console.log(m.default()))'], tmp).out.trim();
  const hashes = (env: NodeJS.ProcessEnv) => {
    const r = sh(process.execPath, [tcm, "run", "tcmts.dev.hashProject", repository()], process.cwd(), env);
    if (!r.ok) throw new Error(r.out);
    return r.out.split("\n").filter((l) => /^\S+:\S+ [a-z2-7]+$/.test(l));
  };
  const ours = hashes({});
  const theirs = hashes({ TCM_TYPESCRIPT: tsrs });
  const differ = ours.filter((l, i) => l !== theirs[i]);
  if (differ.length || ours.length !== theirs.length) {
    console.log(`hashes differ: ${differ.slice(0, 10).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`identical hashes (${ours.length} definitions)`);
  const golden = sh(process.execPath, [tcm, "test", "tcmts.core.test", "--definitions", "--fresh"], process.cwd(), { TCM_TYPESCRIPT: tsrs });
  console.log(`golden hashes with tsrs: ${golden.out.trim().split("\n").at(-1)}`);
  process.exitCode = golden.ok ? 0 : 1;
}

/**
 * Print `<file>:<name> <hash>` for every definition of the project in `dir` (tcm's repository by default), as this
 * process's compiler hashes it: with TCM_TYPESCRIPT, another one (`compareCompilers`).
 */
export function hashProject(dir?: string): void {
  const root = path.resolve(dir ?? repository());
  // (not tests, directories of files kept as written (examples), builds, or codebases)
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return ["node_modules", "test", "dist"].includes(e.name) || e.name.startsWith(".") || fs.existsSync(path.join(p, ".tcm-files")) || fs.existsSync(path.join(p, ".tcm")) ? [] : walk(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
    });
  const a = analyzeProject(walk(root), { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "tcm-hash-")), resolveName: () => "" });
  if (a.errors.length || a.diagnostics.length) {
    console.error([...a.errors, ...a.diagnostics.map((d) => d.formatted)].join("\n"));
    process.exitCode = 1;
    return;
  }
  console.error(`typescript ${TS_VERSION}: ${a.defs.length} definitions`);
  for (const d of a.defs.map((d) => `${path.relative(root, d.file)}:${d.nameHint} ${d.hash}`).sort()) console.log(d);
}

/**
 * Deploy tcm's server: `tcm serve` of tcm's codebase, and the docs site, on Railway (`server/`). What's uploaded is
 * the server's files, the known-good tcm's package (the build the last passing `pnpm verify` tested) and the docs
 * site built from the codebase, to the `tcm-server` service of the Railway project the repository is linked to
 * (`railway link`). `pnpm server:deploy`.
 */
export async function deployServer(): Promise<void> {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const repo = repository();
  const good = path.join(repo, "dist", "known-good");
  const tgz = fs.existsSync(good) ? fs.readdirSync(good).find((f) => f.endsWith(".tgz")) : undefined;
  if (!tgz) throw new Error("no known-good tcm to deploy: `pnpm verify` makes one");
  // the project and environment the repository is linked to (uploading from elsewhere, railway needs them said)
  const status = sh("railway", ["status", "--json"], repo);
  if (!status.ok) throw new Error(`railway status: ${status.out.trim()} (link the repository with \`railway link\`)`);
  const linked = JSON.parse(status.out.slice(status.out.indexOf("{"))) as { id: string; environments: { edges: { node: { id: string; name: string } }[] } };
  const environment = linked.environments.edges.find((e) => e.node.name === "production")?.node.id;
  if (!environment) throw new Error("the linked Railway project has no production environment");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-server-"));
  const files = sh(process.execPath, [tcm, "export", "tcmts.server", stage], process.cwd());
  if (!files.ok) throw new Error(`tcm export tcmts.server: ${files.out.trim()}`);
  fs.copyFileSync(path.join(good, tgz), path.join(stage, "tcm-ts.tgz"));
  const site = await buildSite(path.join(stage, "site"));
  if (site.problems.length) throw new Error(`docs site:\n${site.problems.join("\n")}`);
  const up = sh("railway", ["up", "--project", linked.id, "--environment", environment, "--service", "tcm-server", "--detach", "--yes"], stage);
  console.log(up.out.trim());
  if (up.ok) console.log(`deploying the known-good tcm: ${fs.readFileSync(path.join(good, "VERIFIED"), "utf8").trim()}`);
  process.exitCode = up.ok ? 0 : 1;
}

/**
 * Bring the repository up to tcm's server, for GitHub (a mirror of it): pull from `origin` (the mirror writes what
 * changed into the files, as edits), then commit them, with a message listing the history entries since the last
 * such commit (which its `tcm-causal:` trailer names). Pushing to GitHub is by hand. Refuses while the repository has
 * changes git doesn't have yet, so a commit only ever holds what came from the server. `pnpm mirror:commit`.
 */
export function mirrorCommit(): void {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const repo = repository();
  const git = (...args: string[]) => sh("git", ["-C", repo, ...args], repo);
  if (git("status", "--porcelain").out.trim()) throw new Error("the repository has changes git doesn't have yet: commit or stash them first");
  const tcmIn = (...args: string[]) => sh(process.execPath, [tcm, ...args], process.cwd());
  const pulled = tcmIn("pull", "origin");
  if (!pulled.ok) throw new Error(`tcm pull origin: ${pulled.out.trim()}`);
  console.log(pulled.out.trim());
  if (!git("status", "--porcelain").out.trim()) {
    console.log("the repository is up to date with tcm's server");
    return;
  }
  // the entries since the last commit made from the server: `#hash  n  date  command`, then what each changed
  const since = /tcm-causal: #?(\w+)/.exec(git("log", "-1", "--format=%B", "--grep=^tcm-causal:").out)?.[1];
  const entries: { hash: string; command: string; changes: string[] }[] = [];
  for (const line of tcmIn("history", "200").out.split("\n")) {
    const head = /^#(\w+)\s+\d+\s+\S+ \S+\s+(.*)$/.exec(line);
    if (head) {
      if (since && head[1] === since) break;
      entries.push({ hash: head[1]!, command: head[2]!, changes: [] });
    } else if (line.startsWith("    ") && entries.length) entries.at(-1)!.changes.push(line.trim());
  }
  const subject = entries.length === 1 ? entries[0]!.command : `${entries.length} changes from tcm's server`;
  const body = entries.map((e) => [`${e.command}`, ...e.changes.slice(0, 20).map((c) => `  ${c}`), ...(e.changes.length > 20 ? [`  and ${e.changes.length - 20} more`] : [])].join("\n")).join("\n\n");
  git("add", "-A");
  const committed = git("commit", "-q", "-m", `${subject}\n\n${body}\n\ntcm-causal: #${entries[0]?.hash ?? since}`);
  if (!committed.ok) throw new Error(`git commit: ${committed.out.trim()}`);
  console.log(`committed ${git("log", "-1", "--format=%h %s").out.trim()}; push it to GitHub by hand`);
}
