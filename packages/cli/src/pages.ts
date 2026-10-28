// Definition pages, as in Unison's codebase UI: a definition with its rendered doc (links, embeds, evaluated
// examples), its source highlighted with every reference a link, where it runs, what it uses and what uses it.
// Plus the search behind the editor's finder. The language server sends these to the editor as data.
import ts from "typescript";
import { SERVER_API_MODULE, shortHash, type DefRecord } from "@tcm/core";
import { render } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import type { Placement } from "./placement.ts";
import { renderDoc } from "./docs.ts";
import { searchByType } from "./search.ts";
import { isTestPath } from "./tests.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Keywords that change control flow, coloured apart from the rest (as VS Code's default themes do). */
const CONTROL = new Set(["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "throw", "try", "catch", "finally", "await", "yield", "import", "export", "from", "as"]);

/**
 * Source as HTML: tokens classed for colouring (k keyword, x control keyword, s string, n number, c comment,
 * f called function, t type name), and each reference to a definition a link (`<a data-hash>`). Uses TypeScript's
 * scanner, re-scanning where it needs context: a `}` that resumes a template literal, a `/` that starts a regex.
 */
export function highlight(text: string, refs: { start: number; end: number; hash: string }[], typeHashes: Set<string>): string {
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text);
  const at = new Map(refs.map((r) => [r.start, r]));
  // open braces since each template substitution started (`${`): the `}` closing one resumes the template
  const templates: number[] = [];
  let previous = ts.SyntaxKind.Unknown;
  const endsExpression = (k: ts.SyntaxKind) =>
    k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.CloseParenToken || k === ts.SyntaxKind.CloseBracketToken || k === ts.SyntaxKind.CloseBraceToken ||
    k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.ThisKeyword || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateTail;
  let out = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
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
    if (ref && kind === ts.SyntaxKind.Identifier) {
      out += `<a class="ref${typeHashes.has(ref.hash) ? " t" : ""}" data-hash="${ref.hash}">${esc(raw)}</a>`;
    } else {
      const next = kind === ts.SyntaxKind.Identifier ? /^\s*(<[^>()]*>)?\s*\(/.test(text.slice(scanner.getTokenEnd(), scanner.getTokenEnd() + 80)) : false;
      const cls =
        kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia ? "c"
        : kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword ? (CONTROL.has(raw) ? "x" : "k")
        : kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.RegularExpressionLiteral || (kind >= ts.SyntaxKind.FirstTemplateToken && kind <= ts.SyntaxKind.LastTemplateToken) ? "s"
        : kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral ? "n"
        : next ? "f"
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
  const test = isTest ? cb.store.testResult(hash, process.version) : undefined;
  const item = (h: string) => ({ hash: h, name: nameOf(h), kind: cb.store.getDef(h)?.kind, signature: cb.store.getDef(h)?.signature, uri: links.viewUri(h) });
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
    sourceHtml: highlight(r.text.trimEnd(), r.refs.filter((x) => x.hash !== hash || x.from !== hash), typeHashes),
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
