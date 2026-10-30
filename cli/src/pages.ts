// Definition pages, as in Unison's codebase UI: a definition with its rendered doc (links, embeds, evaluated
// examples), its source highlighted with every reference a link, where it runs, what it uses and what uses it.
// Plus the search behind the editor's finder. The language server sends these to the editor as data.
import { ts } from "@tcm/core";
import { SERVER_API_MODULE, shortHash, type DefRecord } from "@tcm/core";
import { render } from "@tcm/loader";
import { resultKey } from "./vitest.ts";
import type { Codebase } from "./codebase.ts";
import { Placement } from "./placement.ts";
import { renderDoc } from "./docs.ts";
import { searchByType } from "./search.ts";
import { isTestPath } from "./testing.ts";
import { isTypeOnlyImport, parse } from "../../core/src/ts.ts";
import { linkedName, markdownLinks, isBytes, formatOf } from "./files.ts";
import fs from "node:fs";
import assert from "node:assert/strict";
import { viewText, viewFile } from "./views.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Keywords that change control flow, coloured apart from the rest (as VS Code's default themes do). */
const CONTROL = new Set(["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "throw", "try", "catch", "finally", "await", "yield", "import", "export", "from", "as"]);

/**
 * Source as HTML: tokens classed for colouring (k keyword, x control keyword, s string, n number, c comment,
 * f called function, t type name), each reference to a definition a link (`<a data-hash>`), and an import's module
 * a link to its namespace's or package's page. Uses TypeScript's scanner, re-scanning where it needs context: a
 * `}` that resumes a template literal, a `/` that starts a regex.
 */
export function highlight(text: string, refs: HighlightRef[], typeHashes: Set<string>, jsx = false): string {
  const scanner = ts.createScanner(false, ts.LanguageVariant.Standard, text);
  const at = new Map(refs.map((r) => [r.start, r]));
  // (the scanner alone reads JSX's text as code: those parts come from the syntax tree)
  const pieces = jsx ? jsxPieces(text, at) : undefined;
  // open braces since each template substitution started (`${`): the `}` closing one resumes the template
  const templates: number[] = [];
  let previous = ts.SyntaxKind.Unknown;
  const endsExpression = (k: ts.SyntaxKind) =>
    k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.CloseParenToken || k === ts.SyntaxKind.CloseBracketToken || k === ts.SyntaxKind.CloseBraceToken ||
    k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.ThisKeyword || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateTail;
  let out = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.OpenBraceToken && templates.length) templates[templates.length - 1]!++;
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.length) {
      if (templates.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
      } else templates[templates.length - 1]!--;
    }
    if (kind === ts.SyntaxKind.TemplateHead) templates.push(0);
    if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && !endsExpression(previous)) kind = scanner.reScanSlashToken();
    const start = scanner.getTokenStart();
    const piece = pieces?.get(start);
    if (piece) {
      out += piece.html;
      scanner.resetTokenState(piece.end);
      // (a JSX element ends an expression)
      previous = ts.SyntaxKind.Identifier;
      continue;
    }
    const raw = text.slice(start, scanner.getTokenEnd());
    const trivia = kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia;
    const ref = at.get(start);
    // a name followed by a call (or type arguments, then a call): coloured as a function, linked or not
    const called = kind === ts.SyntaxKind.Identifier && /^\s*(<[^>()]*>)?\s*\(/.test(text.slice(scanner.getTokenEnd(), scanner.getTokenEnd() + 80));
    if (ref?.hash && kind === ts.SyntaxKind.Identifier) {
      // (a link keeps the colour the name would have)
      out += `<a class="ref${typeHashes.has(ref.hash) ? " t" : called ? " f" : ""}" data-hash="${ref.hash}">${esc(raw)}</a>`;
    } else if (ref && kind === ts.SyntaxKind.StringLiteral && (ref.namespace !== undefined || ref.package)) {
      const to = ref.package ? `data-package-name="${esc(ref.package.name)}" data-package-range="${esc(ref.package.range)}"` : `data-namespace="${esc(ref.namespace!)}"`;
      out += `<a class="ref s" ${to}>${esc(raw)}</a>`;
    } else {
      const cls =
        kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia ? "c"
        : kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword ? (CONTROL.has(raw) ? "x" : "k")
        : kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.RegularExpressionLiteral || (kind >= ts.SyntaxKind.FirstTemplateToken && kind <= ts.SyntaxKind.LastTemplateToken) ? "s"
        : kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral ? "n"
        : called ? "f"
        : "";
      out += cls ? `<span class="${cls}">${esc(raw)}</span>` : esc(raw);
    }
    if (!trivia && kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) previous = kind;
  }
  return out;
}

export interface PageLinks {
  /** where a definition's text document is (`tcm:/lib/square.ts`) */
  viewUri(hash: string): string;
}

/** Everything a definition's page shows. */
export function definitionPage(cb: Codebase, hash: string, placement: Placement, links: PageLinks) {
  const rec = cb.store.getDef(hash);
  if (!rec) return undefined;
  const names = cb.store.pathsOf(hash);
  const nameOf = (h: string) => cb.store.pathsOf(h)[0] ?? shortHash(h);
  // the source without its doc (the doc is rendered above it), references as links
  const r = render([{ ...rec, doc: undefined }], cb.source(), cb.lay, { style: "scratch", exportDeclarations: true });
  const deps = [...new Set(rec.deps.filter((d) => d.ref.startsWith("#") && d.ref !== `#${hash}`).map((d) => d.ref.slice(1)))];
  const typeHashes = new Set([...deps, hash].filter((h) => cb.store.getDef(h)?.kind === "type"));
  const doc = renderDoc(cb, rec, { evaluate: true, link: (h) => `tcm-page:${h}` });
  const where = rec.kind === "term" ? placement.placeOf(hash) : undefined;
  const isTest = rec.kind !== "type" && names.some(isTestPath);
  const test = isTest ? cb.store.testResult(hash, resultKey(cb)) : undefined;
  const item = (h: string) => ({ hash: h, name: nameOf(h), kind: cb.store.getDef(h)?.kind, signature: cb.store.getDef(h)?.signature, uri: links.viewUri(h) });
  // a file kept as written: its content (Markdown rendered, an image shown, other text as it is)
  if (rec.kind === "file") {
    const format = formatOf(rec);
    const page = { hash, short: shortHash(hash), names, kind: rec.kind, format, signature: rec.signature, docProblems: [] as string[], externals: [] as string[] };
    const related = { uses: deps.map(item).sort((a, b) => (a.name < b.name ? -1 : 1)), usedBy: [...new Set(cb.store.dependents(hash))].filter((d) => cb.store.pathsOf(d).length).map(item).sort((a, b) => (a.name < b.name ? -1 : 1)), uri: links.viewUri(hash) };
    if (isBytes(rec)) {
      const mime = IMAGE_TYPES[format];
      return { ...page, ...related, ...(mime ? { image: `data:${mime};base64,${rec.sourceText}` } : { sourceHtml: esc(`(${format || "bytes"}, ${Buffer.from(rec.sourceText, "base64").length} bytes)`) }) };
    }
    const text = rec.sourceText;
    if (format === "svg") return { ...page, ...related, image: `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`, sourceHtml: esc(text) };
    if (format !== "md") return { ...page, ...related, sourceHtml: ["ts", "tsx", "js", "json"].includes(format) ? highlight(text, [], new Set(), format === "tsx") : esc(text) };
    // Markdown: its links to code and to other pages open their pages
    // (a span is the name in `{@link name}`: the whole of it becomes the link)
    const edits: { start: number; end: number; text: string }[] = rec.spans.flatMap((sp) => {
      if (!sp.hash) return [];
      const open = /\{@link\s+$/.exec(text.slice(Math.max(0, sp.start - 20), sp.start));
      const close = /^\s*\}/.exec(text.slice(sp.end));
      return [{ start: open ? sp.start - open[0].length : sp.start, end: close ? sp.end + close[0].length : sp.end, text: `[\`${nameOf(sp.hash)}\`](tcm-page:${sp.hash})` }];
    });
    const name = names[0] ?? "";
    for (const l of markdownLinks(text)) {
      if (l.code) continue;
      const to = linkedName(name, l.target);
      const h = to && cb.store.hashesAt(to.name).find((x) => cb.store.getDef(x)?.kind === "file");
      if (h) edits.push({ start: l.start, end: l.end, text: `tcm-page:${h}` });
    }
    let md = text;
    for (const e of edits.sort((x, y) => y.start - x.start)) md = md.slice(0, e.start) + e.text + md.slice(e.end);
    return { ...page, ...related, docMarkdown: md };
  }
  return {
    hash,
    short: shortHash(hash),
    names,
    kind: rec.kind,
    signature: rec.signature,
    ...(where && !isTest ? { place: where.place, why: where.why } : {}),
    ...(where?.place === "server" && placement.crossable(hash) ? { endpoint: true, streaming: placement.streams(hash) } : {}),
    ...(isTest ? { test: test ? (test.ok ? "passed" : "failed") : "not run" } : {}),
    docMarkdown: doc?.markdown,
    docProblems: doc?.problems ?? [],
    sourceHtml: highlight(r.text.trimEnd(), [...r.refs.filter((x) => x.hash !== hash || x.from !== hash), ...importRefs(cb, r.text.trimEnd(), rec)], typeHashes, !!rec.jsx),
    uses: deps.map(item).sort((a, b) => (a.name < b.name ? -1 : 1)),
    // what it imports from outside the codebase, as written in code: a package, a Node builtin, #tcm/server
    externals: [...new Set(rec.spans.flatMap((s) => (s.ext ? [s.ext.module === SERVER_API_MODULE ? "#tcm/server" : s.ext.module.replace(/^npm:/, "")] : [])))],
    usedBy: [...new Set(cb.store.dependents(hash))].filter((d) => d !== hash && cb.store.pathsOf(d).length).map(item).sort((a, b) => (a.name < b.name ? -1 : 1)),
    uri: links.viewUri(hash),
  };
}

/** A definition's doc, first paragraph only, as plain text (for overviews and search results). */
export function docSummary(rec: DefRecord): string | undefined {
  const first = rec.doc?.split(/\n\s*\n/)[0]?.replace(/\{@\w+\s+([^}|\s]+)(?:\s*\|\s*([^}]*)|\s+([^}]*))?\}/g, (_m, name, a, b) => (a ?? b ?? name).trim());
  return first?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * The finder: definitions by name (the letters in order, best matches first), by words in their docs, and, when
 * the query looks like a type (`(xs: T[]) => T`, or anything starting with `:`), by type.
 */
export function find(cb: Codebase, query: string, viewUri: (hash: string) => string) {
  const q = query.trim();
  if (!q) return [];
  const item = (p: string, hash: string, detail?: string) => {
    const rec = cb.store.getDef(hash)!;
    return { path: p, hash, kind: rec.kind, signature: rec.signature, detail: detail ?? docSummary(rec), uri: viewUri(hash) };
  };
  const looksLikeType = q.startsWith(":") || /=>|^\(|<.*>|\[\]$/.test(q);
  if (looksLikeType) {
    try {
      return searchByType(cb, q.replace(/^:/, "")).hits.map((h) => ({ ...item(h.path, h.hash, h.notes.join(", ") || "same type"), match: "type" }));
    } catch (e) {
      return [{ path: "", hash: "", kind: "error", signature: "", detail: (e as Error).message, uri: "", match: "error" }];
    }
  }
  const lower = q.toLowerCase();
  const scoreName = (p: string) => {
    const last = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    const full = p.toLowerCase();
    if (last === lower) return 100;
    if (last.startsWith(lower)) return 80;
    if (full.includes(lower)) return 60;
    let i = 0;
    for (const ch of full) if (ch === lower[i]) i++;
    return i === lower.length ? 40 - (full.length - lower.length) / 100 : 0;
  };
  const names = cb.store.names();
  const scored = names.map((n) => {
    const name = scoreName(n.path);
    const doc = name ? 0 : cb.store.getDef(n.hash)?.doc?.toLowerCase().includes(lower) ? 20 : 0;
    return { n, score: Math.max(name, doc), match: name ? "name" : "doc" };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.n.path < b.n.path ? -1 : 1))
    .slice(0, 60)
    .map((s) => ({ ...item(s.n.path, s.n.hash), match: s.match }));
}

/**
 * A link in highlighted source: to a definition (`hash`), or, from an import's module, a namespace or package.
 */
export interface HighlightRef {
  start: number;
  end: number;
  hash?: string;
  namespace?: string;
  package?: { name: string; range: string };
}

/**
 * The links in a page's imports: each name brought in from the codebase to its definition, `#codebase/a/b` to the
 * namespace's page, and a package to its page (at the range the definition uses). Node's builtins aren't pages.
 */
export function importRefs(cb: Codebase, text: string, rec: DefRecord): HighlightRef[] {
  const out: HighlightRef[] = [];
  const ranges = new Map<string, string>();
  for (const sp of rec.spans) {
    const m = sp.ext && /^npm:((?:@[^/@]+\/)?[^@/]+)@([^/#]+)/.exec(sp.ext.module);
    if (m) ranges.set(m[1]!, m[2]!);
  }
  const sf = parse("page.ts", text);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const at = { start: st.moduleSpecifier.getStart(sf), end: st.moduleSpecifier.end };
    if (spec === "#codebase" || spec.startsWith("#codebase/")) {
      const ns = spec.slice("#codebase".length).replace(/^\//, "").replaceAll("/", ".");
      out.push({ ...at, namespace: ns });
      const b = st.importClause?.namedBindings;
      if (!b || !ts.isNamedImports(b)) continue;
      for (const el of b.elements) {
        const id = el.propertyName ?? el.name;
        const hs = cb.store.hashesAt(ns ? `${ns}.${id.text}` : id.text);
        // a name holding a type and a value: the one imported
        const typeOnly = isTypeOnlyImport(st.importClause) || el.isTypeOnly;
        const h = hs.find((x) => (cb.store.getDef(x)?.kind === "type") === typeOnly) ?? hs[0];
        if (h) out.push({ start: id.getStart(sf), end: id.end, hash: h });
      }
      continue;
    }
    const name = /^((?:@[^/]+\/)?[^/]+)/.exec(spec)?.[1];
    const range = name && ranges.get(name);
    if (name && range) out.push({ ...at, package: { name, range } });
  }
  return out;
}

/**
 * Images a page shows, by format.
 */
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon" }

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
 * How code search matches: case, whole words, a regular expression.
 */
export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/**
 * What code search found: the definitions and pages with matching lines, how many matches, and why it can't search.
 */
export interface SearchResults {
  hits: { path: string; hash: string; kind: string; uri?: string; lines: SearchLine[] }[];
  matches: number;
  truncated: boolean;
  error?: string;
}

/**
 * A named definition's text as its document shows it (current names; `first` is the line its code starts on,
 * after the header), or a page's: what code search reads.
 */
export interface SearchText {
  path: string;
  hash: string;
  kind: string;
  text: string;
  first: number;
}

/**
 * Code search, as an editor's find in files: every line of the codebase's definitions (as their documents show
 * them, with current names) and pages that has `query` in it, by definition. At most 500 definitions or 5000
 * matches; `truncated` says there were more.
 */
export function searchCode(cb: Codebase, query: string, opts: SearchOptions, viewUri: (hash: string) => string): SearchResults {
  const none: SearchResults = { hits: [], matches: 0, truncated: false };
  if (!query) return none;
  let re: RegExp;
  try {
    const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(opts.wholeWord ? `\\b(?:${source})\\b` : source, opts.caseSensitive ? "g" : "gi");
  } catch (e) {
    return { ...none, error: (e as Error).message };
  }
  const out = none;
  for (const t of searchableTexts(cb)) {
    const lines = t.text.split("\n");
    const found: SearchLine[] = [];
    for (let i = t.first; i < lines.length; i++) {
      const line = lines[i]!;
      const ranges: [number, number][] = [];
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        ranges.push([m.index, m.index + m[0].length]);
      }
      if (!ranges.length) continue;
      // shown from a little before the first match, without the indentation
      const indent = line.length - line.trimStart().length;
      const from = Math.max(indent, ranges[0]![0] - 40);
      const text = line.slice(from, from + 240);
      found.push({ line: i, column: ranges[0]![0], text, ranges: ranges.map(([a, b]): [number, number] => [a - from, Math.min(b - from, text.length)]).filter(([a]) => a < text.length) });
      out.matches += ranges.length;
    }
    if (!found.length) continue;
    out.hits.push({ path: t.path, hash: t.hash, kind: t.kind, ...(t.kind === "file" ? {} : { uri: viewUri(t.hash) }), lines: found });
    if (out.matches >= 5000 || out.hits.length >= 500) {
      out.truncated = true;
      break;
    }
  }
  return out;
}

/**
 * The texts code search read last, by the branch and history entry they're of.
 */
export const searchTexts = new Map<string, SearchText[]>();

/**
 * Every named definition's and page's text, made again when the names change. A definition's is its document's
 * (`.tcm/src`), read from it when it's there and current.
 */
export function searchableTexts(cb: Codebase): SearchText[] {
  const key = `${cb.sessionDir ?? ""}|${cb.store.branch().name}@${cb.store.logHead()}`;
  const known = searchTexts.get(key);
  if (known) return known;
  const placement = new Placement(cb);
  const out: SearchText[] = [];
  const seen = new Set<string>();
  for (const n of cb.store.names(undefined, true)) {
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    const rec = cb.store.getDef(n.hash);
    if (!rec) continue;
    if (rec.kind === "file") {
      if (!isBytes(rec)) out.push({ path: n.path, hash: n.hash, kind: "file", text: rec.sourceText, first: 0 });
      continue;
    }
    const hashes = cb.lookup(n.path);
    const file = viewFile(cb, n.hash);
    // (a session doesn't keep documents: its definitions are rendered here)
    const text = !cb.sessionDir && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : viewText(cb, hashes, placement)?.text;
    if (text) out.push({ path: n.path, hash: n.hash, kind: rec.kind, text, first: hashes.length });
  }
  searchTexts.clear();
  searchTexts.set(key, out);
  return out;
}

/**
 * Code search finds text in definitions as they read now (current names), and in pages, by line; a regular
 * expression, whole words and case work as an editor's do.
 */
export const testSearchCode = () => {
  const lines = (q: string, opts: SearchOptions = {}) => {
    searchTexts.clear();
    searchTexts.set("|b@0", [
      { path: "lib.square", hash: "h1", kind: "term", text: "// lib.square #h1\nexport const square = (x: number): number => x * x;\n", first: 1 },
      { path: "docs.guide", hash: "h2", kind: "file", text: "# Guide\n\nSquare things with `square`.\n", first: 0 },
    ]);
    const cb = { sessionDir: "", store: { branch: () => ({ name: "b" }), logHead: () => 0 } } as unknown as Codebase;
    return searchCode(cb, q, opts, (h) => `file:///${h}`);
  };
  const r = lines("square");
  assert.deepEqual(r.hits.map((h) => [h.path, h.lines.map((l) => l.line)]), [["lib.square", [1]], ["docs.guide", [2]]]);
  assert.equal(r.matches, 3);
  assert.equal(r.hits[0]!.uri, "file:///h1");
  assert.equal(r.hits[1]!.uri, undefined);
  assert.deepEqual(r.hits[0]!.lines[0]!.ranges, [[13, 19]]);
  // the header line, with the name in it, isn't searched
  assert.equal(lines("lib.square").matches, 0);
  assert.equal(lines("Square", { caseSensitive: true }).matches, 1);
  assert.equal(lines("squar", { wholeWord: true }).matches, 0);
  assert.equal(lines("x \\* x", { regex: true }).matches, 1);
  assert.match(lines("(", { regex: true }).error ?? "", /Invalid regular expression/);
}

/**
 * The parts of JSX that highlighting takes from the syntax tree rather than the scanner, by where each starts: text
 * between tags (which the scanner would read as code), closing tags, and tag and attribute names (`aria-label` is
 * one name). A built-in tag (`div`) is coloured as a tag (g), a component as a type (t), linked if it's in `refs`;
 * an attribute name as an attribute (a).
 */
export function jsxPieces(text: string, refs: Map<number, HighlightRef>): Map<number, { end: number; html: string }> {
  const sf = parse("code.tsx", text);
  const out = new Map<number, { end: number; html: string }>();
  const tag = (n: ts.Node) => {
    const start = n.getStart(sf);
    const raw = text.slice(start, n.end);
    const ref = refs.get(start);
    if (ref?.hash) return `<a class="ref t" data-hash="${ref.hash}">${esc(raw)}</a>`;
    return `<span class="${/^[a-z][\w-]*$/.test(raw) ? "g" : "t"}">${esc(raw)}</span>`;
  };
  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      if (n.end > n.pos) out.set(n.pos, { end: n.end, html: esc(text.slice(n.pos, n.end)) });
      return;
    }
    if (ts.isJsxClosingElement(n)) {
      const start = n.getStart(sf);
      const name = n.tagName;
      out.set(start, { end: n.end, html: esc(text.slice(start, name.getStart(sf))) + tag(name) + esc(text.slice(name.end, n.end)) });
      return;
    }
    if (ts.isJsxClosingFragment(n)) {
      const start = n.getStart(sf);
      out.set(start, { end: n.end, html: esc(text.slice(start, n.end)) });
      return;
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) out.set(n.tagName.getStart(sf), { end: n.tagName.end, html: tag(n.tagName) });
    if (ts.isJsxAttribute(n)) {
      const start = n.name.getStart(sf);
      out.set(start, { end: n.name.end, html: `<span class="a">${esc(text.slice(start, n.name.end))}</span>` });
    }
    n.forEachChild(walk, (arr) => void arr.forEach(walk));
  };
  walk(sf);
  return out;
}

/**
 * JSX is highlighted as JSX: text between tags isn't code (an apostrophe in it starts no string), tags and
 * attributes have colours of their own, and a component that's a definition is a link.
 */
export const testHighlightJsx = () => {
  const text = `const Hi = () => <p className="x" aria-label="hi">don't <Name /></p>;`;
  const at = text.indexOf("<Name") + 1;
  const html = highlight(text, [{ start: at, end: at + 4, hash: "h1" }], new Set(), true);
  assert.match(html, /<span class="g">p<\/span> <span class="a">className<\/span>=<span class="s">&quot;x&quot;<\/span> <span class="a">aria-label<\/span>/);
  assert.match(html, /&gt;don't &lt;<a class="ref t" data-hash="h1">Name<\/a> \/&gt;&lt;\/<span class="g">p<\/span>&gt;;$/);
  // without JSX, the scanner reads the text as code
  assert.doesNotMatch(highlight(text, [], new Set()), /don't &lt;/);
}
