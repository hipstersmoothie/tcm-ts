// Definition pages, as in Unison's codebase UI: a definition with its rendered doc (links, embeds, evaluated
// examples), its source highlighted with every reference a link, where it runs, what it uses and what uses it.
// Plus the search behind the editor's finder. The language server sends these to the editor as data.
import { ts } from "@tcm/core";
import { SERVER_API_MODULE, shortHash, type DefRecord } from "@tcm/core";
import { render } from "@tcm/loader";
import { resultKey } from "./vitest.ts";
import type { Codebase } from "./codebase.ts";
import type { Placement } from "./placement.ts";
import { renderDoc } from "./docs.ts";
import { searchByType } from "./search.ts";
import { isTestPath } from "./testing.ts";
import { isTypeOnlyImport, parse } from "../../core/src/ts.ts";
import { linkedName, markdownLinks, isBytes, formatOf } from "./files.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Keywords that change control flow, coloured apart from the rest (as VS Code's default themes do). */
const CONTROL = new Set(["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "throw", "try", "catch", "finally", "await", "yield", "import", "export", "from", "as"]);

/**
 * Source as HTML: tokens classed for colouring (k keyword, x control keyword, s string, n number, c comment,
 * f called function, t type name), each reference to a definition a link (`<a data-hash>`), and an import's module
 * a link to its namespace's or package's page. Uses TypeScript's scanner, re-scanning where it needs context: a
 * `}` that resumes a template literal, a `/` that starts a regex.
 */
export function highlight(text: string, refs: HighlightRef[], typeHashes: Set<string>): string {
  const scanner = ts.createScanner(false, ts.LanguageVariant.Standard, text);
  const at = new Map(refs.map((r) => [r.start, r]));
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
    if (format !== "md") return { ...page, ...related, sourceHtml: ["ts", "tsx", "js", "json"].includes(format) ? highlight(text, [], new Set()) : esc(text) };
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
    sourceHtml: highlight(r.text.trimEnd(), [...r.refs.filter((x) => x.hash !== hash || x.from !== hash), ...importRefs(cb, r.text.trimEnd(), rec)], typeHashes),
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
