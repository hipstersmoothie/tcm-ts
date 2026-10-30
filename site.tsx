import { createHighlighter } from "shiki";
import { Fragment, useState } from "react";
import { README } from "#codebase/tcmts/examples";
import { "tutorial-codebase" as tutorial_codebase, "tutorial-app" as tutorial_app, testing, sync, "server-reference" as server_reference, "server-api" as server_api, search, "scratch-files" as scratch_files, releases, react, publishing, production, pages, packages, linting, limitations, jobs, introduction, importing, history, hashing, "getting-started" as getting_started, formatting, files, execution, editors, documentation, developing, debugging, data, contributions, "compiler-options" as compiler_options, cli, apps, agents, README as README_1 } from "#codebase/tcmts/docs";
import { Marked } from "marked";
import type { Tokens } from "marked";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
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
body { margin: 0; font: 15px/1.55 "Courier New", Courier, ui-monospace, monospace; }
.site { display: grid; grid-template-columns: 30ch minmax(0, 76ch); gap: 0 5ch; padding: 32px 24px 64px; justify-content: center; }
a { color: var(--link); } a:visited { color: var(--visited); }
.rule { height: 1.55em; overflow: hidden; color: var(--rule); }
.rule::before { content: "------------------------------------------------------------------------------------------------------------------------"; }
h1 + .rule::before, .side .rule::before { content: "========================================================================================================================"; }

/* the menu */
.side { position: sticky; top: 32px; align-self: start; max-height: calc(100vh - 64px); overflow-y: auto; }
.side .home { color: var(--fg); text-decoration: none; font-weight: bold; }
.side ol { list-style: none; margin: 0; padding: 0; }
.side .filter { display: block; width: 100%; margin: 0 0 8px; padding: 1px 1ch; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: 0; }
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
  .site { display: block; padding: 20px 16px 48px; }
  .side { position: static; max-height: none; margin-bottom: 20px; }
  .side ol { columns: 2; } .side ul { display: none; }
}
`;

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const plain = (s: string) => s.replace(/`/g, "").replace(/\*\*?/g, "").replace(/<[^>]+>/g, "");

/**
 * GitHub's heading anchors (what the docs' own links use).
 */
export const slug = (text: string) => text.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");

/**
 * tcm's docs site as an app (`tcm dev tcmts.site.Docs`): the page the URL names, rendered on the server from the
 * codebase's pages, with a menu that filters in the browser.
 */
export function Docs() {
  return <DocsPage path={location.pathname} />;
}

/**
 * The page at `path` (`/apps`; `/` is the index), rendered on the server.
 */
export async function DocsPage({ path }: { path: string }) {
  const pages = pageList(SOURCES["docs/README.md"]!);
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.html$/, "");
  const page = pages.find((p) => p.file === `${name}.html`) ?? pages[0]!;
  const rendered = renderPage(page, pages, SOURCES[page.src] ?? "", await highlighter(), () => true, true);
  return (
    <>
      <title>{titleOf(page, rendered)}</title>
      <style>{STYLE}</style>
      <Layout page={page} pages={pages} rendered={rendered} version="" live />
    </>
  );
}

/**
 * What highlights the pages' code.
 */
export type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

/**
 * A page of the site: the menu, the page, and the pages before and after it. The same markup in the app and in
 * the static build; `version` is the commit it was built from, if known.
 */
export function Layout({ page, pages, rendered, version, live }: { page: Page; pages: Page[]; rendered: Rendered; version: string; live: boolean }) {
  const prev = pages[page.n - 1];
  const next = pages[page.n + 1];
  return (
    <div className="site">
      <nav className="side" aria-label="pages">
        <a className="home" href={hrefFor("index.html", live)}>tcm-ts.txt</a>
        <div className="rule" aria-hidden="true" />
        <Menu pages={pages} here={page.file} toc={rendered.toc} live={live} />
      </nav>
      <main>
        <article dangerouslySetInnerHTML={{ __html: rendered.html }} />
        <div className="rule" aria-hidden="true" />
        <footer>
          <span>{prev && <>&lt;&lt; <a href={hrefFor(prev.file, live)}>[{prev.n}] {prev.label}</a></>}</span>
          <span>{next && <><a href={hrefFor(next.file, live)}>[{next.n}] {next.label}</a> &gt;&gt;</>}</span>
        </footer>
        {version && <p className="build">built from {version}</p>}
      </main>
    </div>
  );
}

/**
 * The menu down the side: every page, numbered, under its section, and the sections of the one being read. In
 * the app (`live`) a filter at the top narrows it to the pages whose names have what's typed.
 */
export function Menu({ pages, here, toc, live }: { pages: Page[]; here: string; toc: TocEntry[]; live: boolean }) {
  const [q, setQ] = useState("");
  const shown = pages.filter((p) => !q || p.label.includes(q.trim().toLowerCase()));
  return (
    <>
      {live && <input className="filter" type="search" placeholder="filter pages" aria-label="filter pages" value={q} onChange={(e) => setQ(e.target.value)} />}
      <ol>
        {shown.map((p, i) => (
          <Fragment key={p.file}>
            {p.section && p.section !== shown[i - 1]?.section && <li className="section">{p.section.toLowerCase()}</li>}
            <li className={p.file === here ? "here" : undefined}>
              {p.file === here ? <span>[{p.n}] {p.label}</span> : <a href={hrefFor(p.file, live)}>[{p.n}] {p.label}</a>}
              {p.file === here && toc.length > 0 && (
                <ul>
                  {toc.map((t) => (
                    <li key={t.id}>
                      <a href={`#${t.id}`}>{t.num} {t.text.toLowerCase()}</a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </>
  );
}

/**
 * A page rendered: its HTML, title and sections, the anchors it has, the links it makes to other pages (to
 * check that their anchors resolve), and what's wrong with it.
 */
export interface Rendered {
  html: string;
  title: string;
  toc: TocEntry[];
  ids: string[];
  links: { file: string; anchor?: string; text: string }[];
  problems: string[];
}

/**
 * The site's pages as the codebase has them, by where they're kept in the repository: tcm's docs, and the
 * examples' page. They're values, so the site depends on each by hash: changing a page changes the site.
 */
export const SOURCES: Record<string, string> = {
  "docs/README.md": README_1,
  "docs/agents.md": agents,
  "docs/apps.md": apps,
  "docs/cli.md": cli,
  "docs/compiler-options.md": compiler_options,
  "docs/contributions.md": contributions,
  "docs/data.md": data,
  "docs/debugging.md": debugging,
  "docs/developing.md": developing,
  "docs/documentation.md": documentation,
  "docs/editors.md": editors,
  "docs/execution.md": execution,
  "docs/files.md": files,
  "docs/formatting.md": formatting,
  "docs/getting-started.md": getting_started,
  "docs/hashing.md": hashing,
  "docs/history.md": history,
  "docs/importing.md": importing,
  "docs/introduction.md": introduction,
  "docs/jobs.md": jobs,
  "docs/limitations.md": limitations,
  "docs/linting.md": linting,
  "docs/packages.md": packages,
  "docs/pages.md": pages,
  "docs/production.md": production,
  "docs/publishing.md": publishing,
  "docs/react.md": react,
  "docs/releases.md": releases,
  "docs/scratch-files.md": scratch_files,
  "docs/search.md": search,
  "docs/server-api.md": server_api,
  "docs/server-reference.md": server_reference,
  "docs/sync.md": sync,
  "docs/testing.md": testing,
  "docs/tutorial-app.md": tutorial_app,
  "docs/tutorial-codebase.md": tutorial_codebase,
  "examples/README.md": README,
}

/**
 * An entry of a page's table of contents: one of its `##` sections.
 */
export interface TocEntry {
  id: string;
  text: string;
  num: string;
}

/**
 * The code highlighter: a light and a dark theme, as CSS variables, so the colours follow the system like the
 * rest of the page.
 */
export function highlighter(): Promise<Highlighter> {
  let h = highlighters.get("site");
  if (!h) highlighters.set("site", (h = createHighlighter({ themes: ["github-light", "github-dark"], langs: LANGS })));
  return h;
}

/**
 * The highlighters made, one per process: making one loads every language's grammar.
 */
export const highlighters = new Map<string, Promise<Highlighter>>();

/**
 * The site's pages, in the order the index (`docs/README.md`) lists them: its `## headings` are sections, the
 * links in their tables pages.
 */
export function pageList(index: string): Page[] {
  const pages: Page[] = [{ src: "docs/README.md", file: "index.html", label: "index", n: 0 }];
  let section: string | undefined;
  for (const line of index.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) section = h[1]!.trim();
    const m = /^\| \[([^\]]+)\]\(([^)]+)\) \|/.exec(line);
    if (!m) continue;
    const src = resolvePath("docs", m[2]!);
    const name = src === "examples/README.md" ? "examples" : src.slice(src.lastIndexOf("/") + 1).replace(/\.md$/, "");
    pages.push({ src, file: `${name}.html`, label: m[1]!.toLowerCase(), n: pages.length, ...(section ? { section } : {}) });
  }
  return pages;
}

/**
 * One page, Markdown `md`, as plain, text-file-looking HTML: headings numbered like sections of a text file,
 * code highlighted, two-column tables as lists of terms. Links to other pages go to their files; a link to
 * something not on the site is shown as its path if `elsewhere` says it's a file of the repository, and is a
 * problem otherwise.
 */
export function renderPage(page: Page, pages: Page[], md: string, hl: Highlighter, elsewhere: (src: string) => boolean, live: boolean): Rendered {
  const bySrc = new Map(pages.map((p) => [p.src, p]));
  const dir = page.src.slice(0, Math.max(0, page.src.lastIndexOf("/")));
  const r: Rendered = { html: "", title: page.label, toc: [], ids: [], links: [], problems: [] };
  let h2 = 0;
  let h3 = 0;
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(plain(text));
        r.ids.push(id);
        if (depth === 1) {
          r.title = plain(text);
          return `<h1 id="${id}">${page.n ? `${page.n}. ` : ""}${inner}</h1>\n<div class="rule" aria-hidden="true"></div>\n`;
        }
        const num = depth === 2 ? `${page.n}.${++h2}` : `${page.n}.${h2}.${++h3}`;
        if (depth === 2) h3 = 0;
        if (depth === 2) r.toc.push({ id, text: plain(text), num });
        return `<h${depth} id="${id}">${page.n ? `${num} ` : ""}${inner}</h${depth}>\n`;
      },
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (/^[a-z]+:/i.test(href)) return `<a href="${esc(href)}">${text}</a>`;
        const [target, anchor] = href.split("#") as [string, string | undefined];
        // a link within the docs: to the page it names, or to an anchor on this one
        const resolved = target ? resolvePath(dir, target) : page.src;
        const to = bySrc.get(resolved);
        if (!to) {
          // a file in the repository but not on the site (source code, AGENTS.md): shown as its path
          if (elsewhere(resolved)) return `${text} <span class="path">(${esc(resolved)})</span>`;
          r.problems.push(`link to ${href}: no such page`);
          return text;
        }
        r.links.push({ file: to.file, ...(anchor ? { anchor } : {}), text: href });
        return `<a href="${hrefFor(to.file, live)}${anchor ? `#${anchor}` : ""}">${text}</a>`;
      },
      code({ text, lang }: Tokens.Code) {
        if (lang && LANGS.includes(lang)) return hl.codeToHtml(text, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false }) + "\n";
        return `<pre${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(text)}</pre>\n`;
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens);
        // a two-column table is a list of terms and what they mean: shown the man-page way, the term on its line
        // and the description indented under it, so long terms (commands with all their flags) wrap freely
        if (token.header.length === 2) {
          const rows = token.rows.map((row) => `<dt>${cell(row[0]!)}</dt><dd>${cell(row[1]!)}</dd>`).join("\n");
          return `<dl>\n${rows}\n</dl>\n`;
        }
        const head = `<tr>${token.header.map((c) => `<th>${cell(c)}</th>`).join("")}</tr>`;
        const body = token.rows.map((row) => `<tr>${row.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("\n");
        return `<div class="table"><table>\n<thead>${head}</thead>\n<tbody>${body}</tbody>\n</table></div>\n`;
      },
    },
  });
  r.html = marked.parse(md) as string;
  return r;
}

/**
 * `rel` resolved against the directory `dir`, both relative to the repository (`docs`, `../examples/README.md`
 * is `examples/README.md`).
 */
export function resolvePath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const s of `${dir}/${rel}`.split("/")) {
    if (s === "..") out.pop();
    else if (s && s !== ".") out.push(s);
  }
  return out.join("/");
}

/**
 * A page of the static site (`pnpm docs:site`), as a whole HTML document, its style in `style.css`.
 */
export function staticPage(page: Page, pages: Page[], rendered: Rendered, version: string): string {
  const body = renderToStaticMarkup(<Layout page={page} pages={pages} rendered={rendered} version={version} live={false} />);
  return `<!doctype html>\n<html lang="en"><head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(titleOf(page, rendered))}</title>\n<link rel="stylesheet" href="style.css">\n</head><body>\n${body}\n</body></html>\n`;
}

/**
 * A page's title, as the browser's tab shows it.
 */
export const titleOf = (page: Page, rendered: Rendered): string => (page.n ? `${rendered.title} — tcm-ts` : "tcm-ts");

/**
 * Where a link to the page kept in `file` goes: the file itself in the static site, and its path without the
 * `.html` in the app (`apps`, and `./` for the index), which renders it on the server.
 */
export const hrefFor = (file: string, live: boolean): string => (!live ? file : file === "index.html" ? "./" : file.replace(/\.html$/, ""));

/**
 * A page links to the others by their files in the static site, and by paths without `.html` in the app (which
 * renders only those on the server); code is highlighted, and a link to nothing is a problem.
 */
export const testPageLinksInTheAppAndStatically = async () => {
  const pages = [
    { src: "docs/README.md", file: "index.html", label: "index", n: 0 },
    { src: "docs/apps.md", file: "apps.html", label: "web apps", n: 1 },
  ];
  const md = "# Index\n\n## Start here\n\nSee [apps](apps.md#how), [nowhere](gone.md) and `code`.\n\n```ts\nconst x = 1;\n```\n";
  const hl = await highlighter();
  const live = renderPage(pages[0]!, pages, md, hl, () => false, true);
  assert.match(live.html, /<a href="apps#how">apps<\/a>/);
  assert.match(live.html, /class="shiki/);
  assert.deepEqual(live.toc, [{ id: "start-here", text: "Start here", num: "0.1" }]);
  assert.deepEqual(live.problems, ["link to gone.md: no such page"]);
  assert.match(renderPage(pages[0]!, pages, md, hl, () => false, false).html, /<a href="apps\.html#how">apps<\/a>/);
  assert.equal(hrefFor("index.html", true), "./");
  assert.equal(hrefFor("apps.html", true), "apps");
  assert.equal(hrefFor("apps.html", false), "apps.html");
}

/**
 * The site's pages are the index's, in its order and sections, and every one is a page the site has.
 */
export const testPagesFollowTheIndex = () => {
  const pages = pageList(SOURCES["docs/README.md"]!);
  assert.deepEqual(pages[0], { src: "docs/README.md", file: "index.html", label: "index", n: 0 });
  assert.ok(pages.length > 30);
  assert.ok(pages.some((p) => p.src === "examples/README.md" && p.file === "examples.html"));
  for (const p of pages) assert.ok(p.src in SOURCES, `${p.src} is one of the site's pages`);
  assert.equal(resolvePath("docs", "../examples/README.md"), "examples/README.md");
  assert.equal(resolvePath("docs", "./apps.md"), "docs/apps.md");
}
