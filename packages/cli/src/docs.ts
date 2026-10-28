// Rendering docs, Unison-style: a doc's links and embeds show current names (they're stored by hash, and follow
// updates through patches), and its ```ts examples are typechecked and evaluated against the current code, with
// results cached by hash like watch expressions.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { docExamples, docTags, SERVER_API_MODULE, shortHash, type DefRecord, type DocRef } from "@tcm/core";
import { evaluateWatches, render } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

export interface ExampleResult {
  /** didn't typecheck: why */
  error?: string;
  /** one per top-level expression in the example, in order */
  values: { line: number; ok: boolean; value: string }[];
}

export interface RenderOptions {
  /** evaluate examples (or only show them) */
  evaluate: boolean;
  /** how a link to a definition is written: a markdown URL, or undefined for plain code */
  link?: (hash: string, name: string) => string | undefined;
}

/**
 * A string result as its text: watch results are printed with util.inspect (`'a\n' +\n  'b'`), but a doc shows
 * a string's text itself, as Unison shows Text. Undefined for anything that isn't a printed string.
 */
export function printedText(value: string): string | undefined {
  const piece = /'((?:[^'\\]|\\.)*)'/y;
  let out = "";
  let at = 0;
  for (let first = true; ; first = false) {
    if (!first) {
      const plus = /\s*\+\s*/y;
      plus.lastIndex = at;
      if (!plus.exec(value)) break;
      at = plus.lastIndex;
    }
    piece.lastIndex = at;
    const m = piece.exec(value);
    if (!m) return undefined;
    at = piece.lastIndex;
    const json = m[1]!.replace(/"/g, '\\"').replace(/\\'/g, "'").replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1");
    try {
      out += JSON.parse(`"${json}"`) as string;
    } catch {
      return undefined;
    }
  }
  return at === value.length ? out : undefined;
}

/** The newest version of a definition (following updates), its current path, and how a doc shows it. */
function current(cb: Codebase, hash: string): { hash: string; name: string; shown: string } {
  const h = cb.store.patched(hash);
  const p = cb.store.pathsOf(h)[0];
  return p ? { hash: h, name: p, shown: shortestName(cb, p) } : { hash: h, name: `#${shortHash(h).slice(1)}`, shown: shortHash(h) };
}
/** The shortest suffix of a path no other name ends with: `square` for lib.square, unless that's ambiguous. */
function shortestName(cb: Codebase, p: string): string {
  const segs = p.split(".");
  const others = cb.store.names().map((n) => n.path).filter((x) => x !== p);
  for (let i = segs.length - 1; i > 0; i--) {
    const suffix = segs.slice(i).join(".");
    if (!others.some((o) => o === suffix || o.endsWith(`.${suffix}`))) return suffix;
  }
  return p;
}
const lastSegment = (name: string) => name.slice(name.lastIndexOf(".") + 1);

/**
 * An example as a scratch-like module: the code with current names, and imports for the definitions it uses.
 * Names that would collide get an alias.
 */
function exampleModule(cb: Codebase, code: string, refs: DocRef[]) {
  const locals = new Map<string, string>(); // hash → local name
  const taken = new Map<string, string>(); // local name → hash
  const imports: string[] = [];
  // imports from outside the codebase keep the name the example uses
  const external = new Map<string, string>();
  for (const r of refs) {
    if (!r.ext) continue;
    const local = code.slice(r.start, r.end);
    if (external.has(local)) continue;
    const e = r.ext;
    const from =
      e.module === SERVER_API_MODULE ? "#tcm/server"
      : e.module.startsWith("npm:") ? e.module.replace(/^npm:(@?[^@]+)@.*$/, "$1") + (e.subpath ? `/${e.subpath}` : "")
      : e.module + (e.subpath ? `/${e.subpath}` : "");
    external.set(local, from);
    taken.set(local, "");
    imports.push(e.export === "default" ? `import ${local} from "${from}";` : e.export === "*" ? `import * as ${local} from "${from}";` : `import { ${e.export === local ? local : `${e.export} as ${local}`} } from "${from}";`);
  }
  for (const r of refs) {
    if (!r.hash) continue;
    const c = current(cb, r.hash);
    if (locals.has(c.hash) || c.name.startsWith("#")) continue;
    let local = lastSegment(c.name);
    for (let i = 1; taken.has(local) && taken.get(local) !== c.hash; i++) local = `${lastSegment(c.name)}_${i}`;
    locals.set(c.hash, local);
    taken.set(local, c.hash);
    const ns = c.name.includes(".") ? c.name.slice(0, c.name.lastIndexOf(".")) : "";
    const kind = cb.store.getDef(c.hash)?.kind;
    const exported = lastSegment(c.name);
    imports.push(`import ${kind === "type" ? "type " : ""}{ ${exported === local ? local : `${exported} as ${local}`} } from "${ns ? `#codebase/${ns.replaceAll(".", "/")}` : "#codebase"}";`);
  }
  let text = code;
  for (const r of [...refs].sort((a, b) => b.start - a.start)) {
    if (!r.hash) continue;
    const local = locals.get(current(cb, r.hash).hash);
    if (local) text = text.slice(0, r.start) + local + text.slice(r.end);
  }
  return { code: text, header: imports };
}

/** Typecheck an example, and evaluate it unless `evaluate` is false. */
export function runExample(cb: Codebase, code: string, refs: DocRef[], evaluate: boolean): ExampleResult & { code: string } {
  const m = exampleModule(cb, code, refs);
  const dir = path.join(cb.lay.tcmDir, "examples");
  fs.mkdirSync(dir, { recursive: true });
  const text = (m.header.length ? m.header.join("\n") + "\n" : "") + m.code;
  const file = path.join(dir, `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.ts`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text);
  cb.refreshShim();
  const a = cb.analyze(file, cb.scratchSalts());
  const problem = a.errors[0] ?? a.diagnostics[0]?.message;
  if (problem) return { code: m.code, error: problem.replace(`${file}:`, "").replace(ANSI, ""), values: [] };
  if (!evaluate) return { code: m.code, values: [] };
  // an example reads top to bottom: every statement runs, in order (as definitions, `const first = await vote(…)`
  // would otherwise only run if a later expression used it). Its values are cached by the whole example, every
  // statement's hash, since a statement can matter for its effects alone.
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const steps = [...a.defs.map((d) => ({ hash: d.hash, componentHash: d.componentHash, line: lineOf(d.range.start), shown: false })), ...a.watches.map((w) => ({ hash: w.hash, componentHash: w.componentHash, line: w.line, shown: true }))].sort((x, y) => x.line - y.line);
  const key = `example:${createHash("sha256").update(steps.map((s) => s.hash).join(" ")).digest("hex")}`;
  const cached = cb.store.watchResult(key, process.version);
  if (cached) return { code: m.code, values: JSON.parse(cached.value) as ExampleResult["values"] };
  const results = evaluateWatches(steps, cb.source([...a.defs, ...a.watches]), cb.lay);
  const values = steps
    .filter((s) => s.shown)
    .map((s) => {
      const r = results.find((x) => x.line === s.line);
      return { line: s.line - m.header.length, ok: !!r?.ok, value: (r?.value ?? "").replace(ANSI, "") };
    });
  if (!results.some((r) => r.infrastructure)) cb.store.putWatchResult(key, process.version, { ok: true, value: JSON.stringify(values) });
  return { code: m.code, values };
}

/** A definition's doc as markdown: current names, links, embeds, and (if asked) evaluated examples. */
export function renderDoc(cb: Codebase, rec: DefRecord, opts: RenderOptions): { markdown: string; problems: string[] } | undefined {
  const doc = rec.doc;
  if (!doc) return undefined;
  const refs = rec.docRefs ?? [];
  const problems: string[] = [];
  const examples = docExamples(doc);
  const inExample = (at: number) => examples.some((e) => at >= e.start && at < e.end);
  const tags = docTags(doc).filter((t) => !inExample(t.start));
  const linked = (h: string, name: string, code: boolean) => {
    const url = opts.link?.(h, name);
    const text = code ? `\`${name}\`` : name;
    return url ? `[${text}](${url})` : text;
  };
  type Part = { start: number; end: number; text: string };
  const parts: Part[] = [];
  for (const t of tags) {
    const ref = refs.find((r) => r.start === t.nameStart && r.hash);
    if (!ref?.hash) {
      parts.push({ start: t.start, end: t.end, text: t.label ?? `\`${t.name}\`` });
      continue;
    }
    const c = current(cb, ref.hash);
    const target = cb.store.getDef(c.hash);
    if (t.tag === "link") parts.push({ start: t.start, end: t.end, text: t.label ? linked(c.hash, t.label, false) : linked(c.hash, c.shown, true) });
    else if (t.tag === "linkcode") parts.push({ start: t.start, end: t.end, text: linked(c.hash, t.label ?? c.shown, true) });
    else if (t.tag === "signature") parts.push({ start: t.start, end: t.end, text: target ? `\`${target.kind === "type" ? `type ${c.shown}` : `${c.shown} : ${target.signature}`}\`` : `\`${c.shown}\`` });
    else if (t.tag === "source" && target) {
      // the code itself: its own doc is the target's business
      const src = render([{ ...target, doc: undefined }], cb.source(), cb.lay, { style: "scratch", exportDeclarations: true }).text.trimEnd();
      parts.push({ start: t.start, end: t.end, text: `\n\n\`\`\`ts\n${src}\n\`\`\`\n` });
    }
  }
  for (const ex of examples) {
    const inner = refs.filter((r) => r.start >= ex.start && r.end <= ex.end).map((r) => ({ ...r, start: r.start - ex.start, end: r.end - ex.start }));
    const r = runExample(cb, ex.code, inner, opts.evaluate);
    // the closing fence line follows the code; results go after it
    const close = doc.indexOf("```", ex.end);
    const after = close < 0 ? ex.end : doc.indexOf("\n", close) < 0 ? doc.length : doc.indexOf("\n", close);
    let results = "";
    if (r.error) {
      problems.push(`example: ${r.error}`);
      results = `\n\n> ✗ this example doesn't typecheck: ${r.error.split("\n")[0]}\n`;
    } else if (r.values.length) {
      // each result in its own block: a string as its text, anything else as printed
      results = r.values
        .map((v) => {
          const text = v.ok ? printedText(v.value) : undefined;
          return text !== undefined ? `\n\n\`\`\`text\n${text}\n\`\`\`` : `\n\n\`\`\`text\n${v.ok ? "⧩" : "✗"} ${v.value}\n\`\`\``;
        })
        .join("") + "\n";
    }
    parts.push({ start: ex.start, end: ex.end, text: r.code });
    if (results) parts.push({ start: after, end: after, text: results });
  }
  let out = "";
  let at = 0;
  for (const p of parts.sort((a, b) => a.start - b.start || a.end - b.end)) {
    out += doc.slice(at, p.start) + p.text;
    at = p.end;
  }
  return { markdown: blockTags(out + doc.slice(at)), problems };
}

/**
 * JSDoc's block tags as markdown: `@param` lines become a Parameters list, `@returns`, `@throws`, `@see` and
 * `@example` headed paragraphs, `@deprecated` a warning. A tag's text runs until a blank line or the next tag.
 * Code blocks are left alone.
 */
export function blockTags(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence = false;
  let params: string[] = [];
  const flush = () => {
    if (!params.length) return;
    out.push("**Parameters**", "", ...params.map((p) => `- ${p}`), "");
    params = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^@(\w+)\s*(.*)$/.exec(line.trim());
    if (!m) {
      if (params.length && line.trim()) flush();
      out.push(line);
      continue;
    }
    // the tag's text continues over the following lines, up to a blank line or another tag
    let text = m[2]!;
    while (i + 1 < lines.length && lines[i + 1]!.trim() && !/^\s*(@\w|```)/.test(lines[i + 1]!)) text += " " + lines[++i]!.trim();
    const tag = m[1]!;
    if (tag === "param" || tag === "arg" || tag === "argument") {
      const p = /^(?:\{[^}]*\}\s*)?(\[?[\w$.]+(?:=[^\]]*)?\]?)\s*(?:-\s*)?(.*)$/.exec(text);
      params.push(p ? `\`${p[1]!.replace(/^\[|\]$/g, "")}\`${p[2] ? ` — ${p[2]}` : ""}` : text);
      continue;
    }
    flush();
    const strip = (s: string) => s.replace(/^\{[^}]*\}\s*/, "");
    if (tag === "returns" || tag === "return") out.push(`**Returns** ${strip(text)}`, "");
    else if (tag === "throws" || tag === "exception") out.push(`**Throws** ${strip(text)}`, "");
    else if (tag === "see") out.push(`**See also** ${text}`, "");
    else if (tag === "example") out.push(`**Example**${text ? ` ${text}` : ""}`, "");
    else if (tag === "deprecated") out.push(`> **Deprecated**${text ? ` ${text}` : ""}`, "");
    else out.push(`*@${tag}* ${text}`, "");
  }
  flush();
  return out.join("\n");
}

/**
 * After an add or update: the examples in these definitions' docs, and in docs that refer to anything updated,
 * must still typecheck. Returns one message per broken example.
 */
export function checkDocExamples(cb: Codebase, added: Iterable<string>): string[] {
  const live = cb.store.names();
  const saved = new Set(added);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of live) {
    if (seen.has(n.hash)) continue;
    seen.add(n.hash);
    const rec = cb.store.getDef(n.hash);
    if (!rec?.doc || !docExamples(rec.doc).length) continue;
    // a doc is affected if it was just saved, or names something that has since been replaced
    const affected = saved.has(n.hash) || (rec.docRefs ?? []).some((r) => r.hash && cb.store.patched(r.hash) !== r.hash);
    if (!affected) continue;
    const r = renderDoc(cb, rec, { evaluate: false });
    for (const p of r?.problems ?? []) out.push(`${n.path}: doc ${p}`);
  }
  return out;
}
