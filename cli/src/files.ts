import { createHash } from "node:crypto";
import path from "node:path";
import { serializeIR, hashIR } from "@tcm/core";
import type { DefRecord, Span, IR } from "@tcm/core";
import type { Codebase } from "./codebase.ts";
import fs from "node:fs";

export const BINARY_FORMATS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "pdf"]);

/**
 * Formats kept as written, by extension: text ones as text, the rest as bytes.
 */
export const TEXT_FORMATS = new Set(["md", "txt", "css", "svg", "json", "html", "yaml", "yml", "toml", "csv"]);

/**
 * A namespace segment for a directory, as the mirror names them (`src` directories don't count).
 */
export const dirSegment = (dir: string): string => dir.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1");

/**
 * A file definition's content as it reads now: its `{@link}`s naming what they reach by its current name, from `ns`.
 */
export function fileContent(cb: Codebase, rec: DefRecord, ns: string): Buffer {
  if (isBytes(rec)) return Buffer.from(rec.sourceText, "base64");
  let text = rec.sourceText;
  for (const s of [...rec.spans].sort((a, b) => b.start - a.start)) {
    const p = s.hash && cb.store.pathsOf(s.hash)[0];
    if (!p) continue;
    // as short as it reads from here: within the nearest namespace above that has it, if that finds it still
    let short = p;
    for (let n = ns; n; n = n.slice(0, Math.max(0, n.lastIndexOf(".")))) {
      if (p.startsWith(`${n}.`) && linkedCode(cb, ns, p.slice(n.length + 1)) === s.hash) {
        short = p.slice(n.length + 1);
        break;
      }
    }
    text = text.slice(0, s.start) + short + text.slice(s.end);
  }
  return Buffer.from(text, "utf8");
}

/**
 * A file kept in the codebase as written, as a definition named `name`. Markdown's `{@link}`s to code are
 * references by hash, so they read with current names and follow updates; its links to other files are kept as
 * written, and checked: one to a file of the codebase that isn't there (and isn't among `alsoNew`) is a
 * warning. A binary format's bytes are kept as base64.
 */
export function fileDefinition(cb: Codebase, name: string, format: string, content: Buffer, alsoNew = new Set<string>()): { def: DefRecord; problems: string[]; warnings: string[] } {
  const leaf = name.slice(name.lastIndexOf(".") + 1);
  const ns = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
  const problems: string[] = [];
  const warnings: string[] = [];
  const record = (ir: IR, sourceText: string, spans: Span[]): DefRecord => {
    const hash = hashIR(ir);
    return {
      hash,
      kind: "file",
      componentHash: hash,
      componentIndex: 0,
      componentSize: 1,
      ir: serializeIR(ir),
      sourceText,
      spans,
      reservedNames: [],
      initKind: "hoisted",
      nameHint: leaf,
      nominal: false,
      deps: [...new Set(spans.map((s) => s.hash!))].map((h) => ({ ref: `#${h}`, pos: "value" as const, strict: false })),
      // (a file with no extension: text, or bytes)
      signature: format || ((ir as unknown[][])[2]?.[0] === "Bytes" ? "bytes" : "text"),
    };
  };
  // kept as bytes by its format, or because it isn't text (UTF-8)
  if (BINARY_FORMATS.has(format) || !isText(content)) return { def: record(["File", format, ["Bytes", createHash("sha256").update(content).digest("hex")]], content.toString("base64"), []), problems, warnings };
  const text = content.toString("utf8");
  const ir: IR[] = ["File", format];
  const spans: Span[] = [];
  let at = 0;
  if (format === "md") {
    for (const l of markdownLinks(text)) {
      if (l.code) {
        const h = linkedCode(cb, ns, l.target);
        if (!h) {
          problems.push(`{@link ${l.target}}: there's no ${l.target} in the codebase`);
          continue;
        }
        ir.push(text.slice(at, l.start), ["Ref", h]);
        spans.push({ start: l.start, end: l.end, pos: "value", hash: h });
        at = l.end;
        continue;
      }
      const to = linkedName(name, l.target);
      if (to && !alsoNew.has(to.name) && !cb.store.hashesAt(to.name).some((h) => cb.store.getDef(h)?.kind === "file")) warnings.push(`${name} links to ${l.target}, and there's no ${to.name} in the codebase`);
    }
  }
  ir.push(text.slice(at));
  return { def: record(ir, text, spans), problems, warnings };
}

/**
 * The format of a file kept in the codebase as written (not code), from its name: its extension, or undefined.
 */
export function fileFormat(file: string): string | undefined {
  const ext = path.extname(file).slice(1).toLowerCase();
  return TEXT_FORMATS.has(ext) || BINARY_FORMATS.has(ext) ? ext : undefined;
}

/**
 * A file's name in its namespace: its name without the extension (dashes kept; no dots), and without the dot a
 * hidden file's name starts with (`.gitignore` is `gitignore`, `.mcp.json` is `mcp`).
 */
export function fileLeaf(file: string): string {
  const name = path.basename(file).replace(/^\./, "");
  const leaf = name.slice(0, name.length - path.extname(name).length);
  if (!/^[\w$-]+$/.test(leaf)) throw new Error(`${path.basename(file)}: a file is named in the codebase by its name without the extension, which can have letters, digits, _ and - (not dots)`);
  return leaf;
}

/**
 * A file's name on disk: its name in the codebase, and its format as the extension (none for a file without one,
 * like `Dockerfile`).
 */
export const fileName = (leaf: string, rec: DefRecord): string => (formatOf(rec) ? `${leaf}.${formatOf(rec)}` : leaf);

/**
 * Whether a file definition holds bytes (an image, or anything that isn't text) rather than text.
 */
export const isBytes = (rec: DefRecord): boolean => (JSON.parse(rec.ir) as unknown[][])[2]?.[0] === "Bytes";

/**
 * Whether content is text: valid UTF-8.
 */
export function isText(content: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * A file definition's format, from its IR.
 */
export const formatOf = (rec: DefRecord): string => (JSON.parse(rec.ir) as string[])[1]!;

/**
 * The definition a page's `@link` tag in `ns` names: by that name, or within `ns` or a namespace above it.
 */
export function linkedCode(cb: Codebase, ns: string, name: string): string | undefined {
  const value = (p: string) => cb.store.hashesAt(p).find((h) => cb.store.getDef(h)?.kind !== "file");
  for (let n = ns; ; n = n.slice(0, Math.max(0, n.lastIndexOf(".")))) {
    const h = value(n ? `${n}.${name}` : name);
    if (h) return h;
    if (!n) return undefined;
  }
}

/**
 * The file in the codebase a page's link reaches, by its name (and the rest of the link: `#anchor`), or undefined
 * for a link that isn't to such a file (a URL, the same page, code, somewhere outside the codebase).
 */
export function linkedName(fromName: string, target: string): { name: string; rest: string } | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(target)) return undefined;
  const cut = target.search(/[#?]/);
  const file = cut < 0 ? target : target.slice(0, cut);
  if (!fileFormat(file)) return undefined;
  const segs = fromName.split(".").slice(0, -1);
  for (const s of file.split("/").slice(0, -1)) {
    if (s === "..") {
      if (!segs.length) return undefined;
      segs.pop();
    } else if (s && s !== "." && s !== "src") segs.push(dirSegment(s));
  }
  let leaf: string;
  try {
    leaf = fileLeaf(file);
  } catch {
    return undefined;
  }
  return { name: [...segs, leaf].join("."), rest: cut < 0 ? "" : target.slice(cut) };
}

/**
 * Where a Markdown file links, outside code (fences and inline code): `[text](target)`, `[label]: target`, and
 * `@link` tags naming code (`code`). Offsets are the target's.
 */
export function markdownLinks(text: string): { start: number; end: number; target: string; code: boolean }[] {
  const out: { start: number; end: number; target: string; code: boolean }[] = [];
  let fence: string | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    const start = at;
    at += line.length + 1;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length && !line.slice(line.indexOf(open) + open.length).trim()) fence = undefined;
      continue;
    }
    if (open) {
      fence = open;
      continue;
    }
    // inline code and HTML comments read as spaces: their links aren't links
    const plain = line.replace(/(`+)[\s\S]*?\1|<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
    for (const m of plain.matchAll(/\]\((<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!.replace(/^<|>$/g, "");
      const s = start + m.index! + 2 + (m[1]!.startsWith("<") ? 1 : 0);
      out.push({ start: s, end: s + target.length, target, code: false });
    }
    const def = /^ {0,3}\[[^\]]+\]:\s*(\S+)/.exec(plain);
    if (def) {
      const s = start + def[0].length - def[1]!.length;
      out.push({ start: s, end: s + def[1]!.length, target: def[1]!, code: false });
    }
    for (const m of plain.matchAll(/\{@link\s+([\w$.-]+)/g)) {
      const s = start + m.index! + m[0].length - m[1]!.length;
      out.push({ start: s, end: s + m[1]!.length, target: m[1]!, code: true });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Write the files kept under `ns` to `dir`, laid out by their names (`ns.a.b` is `a/b.<format>`), and the file
 * named `ns` itself, if there is one and `own`, as `<its name>.<format>`: how many.
 */
export function exportFiles(cb: Codebase, ns: string, dir: string, own = true): number {
  const files = filesIn(cb, ns);
  if (!own) files.delete(ns);
  for (const [name, rec] of files) {
    const rel = (name === ns ? name.slice(name.lastIndexOf(".") + 1) : ns ? name.slice(ns.length + 1) : name).split(".");
    const file = path.join(dir, ...rel.slice(0, -1), fileName(rel.at(-1)!, rec));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fileContent(cb, rec, name.slice(0, Math.max(0, name.lastIndexOf(".")))));
  }
  return files.size;
}

/**
 * The files kept in the codebase under `ns` (all of them for ""): name → definition.
 */
export function filesIn(cb: Codebase, ns: string): Map<string, DefRecord> {
  const out = new Map<string, DefRecord>();
  for (const n of cb.store.names(undefined, true)) {
    if (n.kind !== "file" || (ns && n.path !== ns && !n.path.startsWith(`${ns}.`))) continue;
    out.set(n.path, cb.store.getDef(n.hash)!);
  }
  return out;
}

/**
 * After the file `from` moved to `to`: the pages whose links change, as new definitions, by name.
 */
export function followMove(cb: Codebase, from: string, to: string): Map<string, DefRecord> {
  const out = new Map<string, DefRecord>();
  for (const [page, rec] of filesIn(cb, "")) {
    const text = relinked(cb, page, rec, from, to);
    if (text !== undefined) out.set(page, fileDefinition(cb, page, "md", Buffer.from(text, "utf8")).def);
  }
  return out;
}

/**
 * The pages (Markdown files) that link to the file named `name`.
 */
export function linkingTo(cb: Codebase, name: string): string[] {
  const out: string[] = [];
  for (const [page, rec] of filesIn(cb, "")) {
    if (page === name || formatOf(rec) !== "md") continue;
    if (markdownLinks(rec.sourceText).some((l) => !l.code && linkedName(page, l.target)?.name === name)) out.push(page);
  }
  return out;
}

/**
 * How a page links to a file of the codebase: the relative path from the one name to the other (with its format).
 */
export function relativeLink(fromName: string, toName: string, format: string): string {
  const from = fromName.split(".").slice(0, -1);
  const to = toName.split(".");
  const leaf = to.pop()!;
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common), `${leaf}.${format}`].join("/");
}

/**
 * A page's text with its links following a move: links to `from` lead to `to`, and if the page is the one that
 * moved (`name` was `from`), its links to others are written from where it is now. Undefined if nothing changes.
 */
export function relinked(cb: Codebase, name: string, rec: DefRecord, from: string, to: string): string | undefined {
  if (formatOf(rec) !== "md") return undefined;
  const text = fileContent(cb, rec, name.slice(0, Math.max(0, name.lastIndexOf(".")))).toString("utf8");
  const was = name === to ? from : name;
  let out = text;
  for (const l of markdownLinks(text).reverse()) {
    if (l.code) continue;
    const target = linkedName(was, l.target);
    if (!target) continue;
    const reaches = target.name === from ? to : target.name;
    if (reaches === target.name && was === name) continue;
    const format = path.extname(l.target.replace(/[#?].*$/, "")).slice(1);
    out = out.slice(0, l.start) + relativeLink(name, reaches, format) + target.rest + out.slice(l.end);
  }
  return out === text ? undefined : out;
}
