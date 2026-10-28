// Definitions as files: `.tcm/src/lib/square.ts` is lib.square rendered with current names, exactly as the editor
// shows it (a header line with its names, hash and where it runs, then the code). They're generated and
// read-only; they exist because debuggers and stack traces need files to point at: every generated module's
// source map leads here (or to the scratch file a definition hasn't left yet).
import fs from "node:fs";
import path from "node:path";
import { shortHash, type DefRecord, type ProjectDef } from "@tcm/core";
import { render, writeIfChanged, type Rendered } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { Placement } from "./placement.ts";

export interface View {
  text: string;
  refs: Rendered["refs"];
  starts: Map<string, number>;
  /** where `export ` was put in front of each member's statements (offsets in its body) */
  inserts: Map<string, number[]>;
  hashes: string[];
}

/** The view of these definitions (one name's: a type and a value can share it), as the editor shows it. */
export function viewText(cb: Codebase, hashes: string[], placement = new Placement(cb)): View | undefined {
  const recs = hashes.map((h) => cb.store.getDef(h)).filter((r): r is DefRecord => !!r);
  if (!recs.length) return undefined;
  const header =
    recs
      .map((r) => {
        const where = r.kind === "term" ? placement.label(r.hash) : "";
        return `// ${cb.store.pathsOf(r.hash).join(", ") || "(unnamed)"} ${shortHash(r.hash)}${where ? ` · ${where}` : ""}`;
      })
      .join("\n") + "\n";
  const r = render(recs, cb.source(), cb.lay, { style: "scratch", exportDeclarations: true });
  const shift = header.length;
  return {
    text: header + r.text,
    refs: r.refs.map((x) => ({ ...x, start: x.start + shift, end: x.end + shift })),
    starts: new Map([...r.starts].map(([h, o]) => [h, o + shift])),
    inserts: r.inserts,
    hashes: recs.map((r) => r.hash),
  };
}

export const srcDir = (cb: Codebase) => path.join(cb.lay.tcmDir, "src");

/** The file a definition's view is in: by its (first) name, else by hash. */
export function viewFile(cb: Codebase, hash: string): string {
  const p = cb.store.pathsOf(hash)[0];
  const jsx = (p ? cb.lookup(p) : [hash]).some((h) => cb.store.getDef(h)?.jsx);
  return path.join(srcDir(cb), `${p ? p.replaceAll(".", "/") : `@${hash}`}${jsx ? ".tsx" : ".ts"}`);
}

/** The definitions a view file shows: `lib/square.ts` → lib.square, `@<hash>.ts` → that hash. */
export function hashesOfViewFile(cb: Codebase, file: string): string[] {
  const rel = path.relative(srcDir(cb), file).split(path.sep).join("/").replace(/\.tsx?$/, "");
  if (rel.startsWith("..")) return [];
  try {
    return rel.startsWith("@") ? cb.lookup(`#${rel.slice(1)}`) : cb.lookup(rel.replaceAll("/", "."));
  } catch {
    return [];
  }
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length - 1;

/** Write a definition's view file (if it changed); where its declaration starts in it. */
function writeView(cb: Codebase, hash: string, placement?: Placement): { file: string; line: number; inserts: number[] } | undefined {
  const file = viewFile(cb, hash);
  const p = cb.store.pathsOf(hash)[0];
  const v = viewText(cb, p ? cb.lookup(p) : [hash], placement);
  if (!v) return undefined;
  writeIfChanged(file, v.text);
  return { file, line: lineOf(v.text, v.starts.get(hash) ?? 0), inserts: v.inserts.get(hash) ?? [] };
}

/** Regenerate .tcm/src for the branch's names, removing files no name has any more. */
export function writeViews(cb: Codebase) {
  const placement = new Placement(cb);
  const keep = new Set<string>();
  for (const n of cb.store.names()) {
    const w = writeView(cb, n.hash, placement);
    if (w) keep.add(w.file);
  }
  const walk = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
  for (const f of walk(srcDir(cb))) if (!keep.has(f) && !path.basename(f).startsWith("@")) fs.rmSync(f);
}

/**
 * Where a definition reads as written, for source maps: an unsaved one in its scratch file, a stored one in its
 * view file (written now if it isn't there yet).
 */
export function viewOf(cb: Codebase, rec: DefRecord | undefined, cache: Map<string, { file: string; line: number; inserts?: number[] } | undefined>) {
  if (!rec) return undefined;
  if (cache.has(rec.hash)) return cache.get(rec.hash);
  const scratch = rec as Partial<ProjectDef>;
  let out: { file: string; line: number; inserts?: number[] } | undefined;
  if (!cb.store.hasDef(rec.hash) && scratch.file && scratch.range && fs.existsSync(scratch.file)) {
    out = { file: scratch.file, line: lineOf(fs.readFileSync(scratch.file, "utf8"), scratch.range.start) };
  } else if (cb.store.hasDef(rec.hash)) {
    out = writeView(cb, rec.hash);
  }
  cache.set(rec.hash, out);
  return out;
}
