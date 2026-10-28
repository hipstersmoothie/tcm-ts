// Builds the docs site: docs/*.md (and the examples page) as plain, text-file-looking HTML in dist/site.
//
//   node scripts/docs-site.ts [outDir]
//
// Pages are ordered by the table in docs/README.md, numbered like sections of a text file, with a numbered menu
// down the side. Every relative link and #anchor must resolve, or the build fails: the docs can't quietly rot.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Marked, type Tokens } from "marked";
import { createHighlighter } from "shiki";

const repo = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.argv[2] ?? path.join(repo, "dist", "site"));

interface Page {
  /** source, relative to the repo */
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

// ---- pages, in the order docs/README.md lists them -------------------------------------------------------------

const index = fs.readFileSync(path.join(repo, "docs", "README.md"), "utf8");
const pages: Page[] = [{ src: "docs/README.md", file: "index.html", label: "index", n: 0 }];
// sections are the index's `## headings`; pages are the links in the tables under them, labelled by their text
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

// code is highlighted when the site is built (no script on the page): a light and a dark theme, as CSS variables,
// so the colours follow the system like the rest of the page
const LANGS = ["ts", "typescript", "js", "json", "sh", "bash", "toml", "lua"];
const highlighter = await createHighlighter({ themes: ["github-light", "github-dark"], langs: LANGS });

/** GitHub's heading anchors (what the docs' own links use). */
const slug = (text: string) => text.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const plain = (s: string) => s.replace(/`/g, "").replace(/\*\*?/g, "").replace(/<[^>]+>/g, "");

// ---- rendering -------------------------------------------------------------------------------------------------

const problems: string[] = [];
const anchors = new Map<string, Set<string>>(); // file → ids
const links: { from: string; file: string; anchor?: string; text: string }[] = [];

function render(page: Page): { html: string; title: string; toc: { id: string; text: string; num: string }[] } {
  const md = fs.readFileSync(path.join(repo, page.src), "utf8");
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

// ---- the page template -----------------------------------------------------------------------------------------

const version = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

function template(page: Page, body: string, title: string, toc: { id: string; text: string; num: string }[]): string {
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
<title>${esc(page.n ? `${title} — ucm-ts` : "ucm-ts")}</title>
<link rel="stylesheet" href="style.css">
</head><body>
<nav class="side" aria-label="pages">
<a class="home" href="index.html">ucm-ts.txt</a>
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

const STYLE = `/* ucm-ts docs: a text file with a menu */
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

// ---- build -----------------------------------------------------------------------------------------------------

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
if (problems.length) {
  for (const p of problems) console.error(`docs-site: ${p}`);
  process.exit(1);
}
console.log(`docs site: ${pages.length} pages in ${path.relative(process.cwd(), out) || out}`);
