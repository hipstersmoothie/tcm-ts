// A mirror: a directory of source files that a namespace was imported from and is kept in step with. The
// codebase is the truth; the files are how it reads in git and in an editor that doesn't know tcm. tcm writes
// changes back as edits to the files, leaving the rest of them as written: an edited definition is replaced where
// it is, a new one is added to its namespace's file, a removed one deleted, a rename made at every reference (as
// the editor's rename would). Changes that don't change code's text (dependents re-hashed by `update`, packages
// upgraded) don't touch the files. After writing, the files are analyzed again and must hash to what the codebase
// holds; if they don't, they're put back. A file changed by hand since tcm last saw it stops writing back until it's
// imported again (`tcm import <dir> --update`), so edits are never overwritten.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createProgram, ts, SERVER_API_MODULE, type DefRecord, type ExtRef, type Span } from "@tcm/core";
import type { Codebase } from "./codebase.ts";
import { dim, red, yellow } from "./style.ts";
import { filesIn, fileFormat, fileDefinition, fileLeaf, fileContent, formatOf, dirSegment } from "./files.ts";

// ---- what a project's files are, as namespaces ---------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "dist", "build"]);
/** With `--tests`: directories of tests written as definitions (`test…`), imported like the code they test. */
const TEST_DIRS = new Set(["test", "tests"]);

export function sourceFiles(dir: string, exclude: Set<string>, tests: boolean): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (exclude.has(path.resolve(p))) return [];
    if (e.isDirectory()) return e.name.startsWith(".") || (SKIP_DIRS.has(e.name) && !(tests && TEST_DIRS.has(e.name))) ? [] : sourceFiles(p, exclude, tests);
    return /\.(m|c)?ts$/.test(e.name) && !/\.d\.(m|c)?ts$|\.(test|spec)(-d)?\.(m|c)?ts$/.test(e.name) ? [p] : [];
  });
}

/** `core/src/analyze.ts` → `core.analyze`, `store/src/index.ts` → `store` */
export function namespaceForFile(root: string, file: string): string {
  const segs = path.relative(root, file).replace(/\.(m|c)?ts$/, "").split(path.sep).filter((s) => s !== "src");
  if (segs.at(-1) === "index") segs.pop();
  return segs.map((s) => s.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1")).join(".");
}

export const joinName = (...parts: string[]) => parts.filter(Boolean).join(".");

// ---- the link -------------------------------------------------------------------------------------------

interface MirrorFile {
  /** the namespace the file's definitions live in */
  ns: string;
  /** its content when tcm last read or wrote it */
  sha: string;
  /** its definitions then: name → hash */
  names: Record<string, string>;
}

export interface Mirror {
  /** the mirrored directory (absolute) */
  dir: string;
  into: string;
  tests: boolean;
  exclude: string[];
  /** the name log as of the last sync: later entries say which changes left code's text alone */
  log: number;
  /** by path relative to `dir` */
  files: Record<string, MirrorFile>;
}

const KEY = "mirror";


const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function loadMirror(cb: Codebase): Mirror | undefined {
  const v = cb.store.getSetting(KEY);
  return v ? (JSON.parse(v) as Mirror) : undefined;
}

function saveMirror(cb: Codebase, m: Mirror) {
  cb.store.setSetting(KEY, JSON.stringify(m));
}

export function unlinkMirror(cb: Codebase) {
  cb.store.deleteSetting(KEY);
}

/** The definitions named directly in a namespace (not in namespaces under it): name → hash. */
function namesIn(cb: Codebase, ns: string): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = ns ? `${ns}.` : "";
  for (const n of cb.store.names()) {
    if (!n.path.startsWith(prefix)) continue;
    const leaf = n.path.slice(prefix.length);
    if (!leaf.includes(".")) out[leaf] = n.hash;
  }
  return out;
}

/**
 * Record that `into` mirrors `dir`: each file's namespace, content and definitions as they are now. Following the
 * files, it records what they hold (`held`, by path) as of the log they were last written at, so what the codebase
 * changed meanwhile is written to them at the next sync.
 */
export function linkMirror(cb: Codebase, dir: string, into: string, tests: boolean, exclude: string[], following?: { log: number; held: Map<string, string> }) {
  const root = path.resolve(dir);
  const files: Record<string, MirrorFile> = {};
  for (const f of sourceFiles(root, new Set(exclude.map((e) => path.resolve(root, e))), tests)) {
    const ns = joinName(into, namespaceForFile(root, f));
    const text = fs.readFileSync(f, "utf8");
    // what the file declares (the codebase may have more, made while write-back waited: written at the next sync)
    const inCodebase = namesIn(cb, ns);
    const names: Record<string, string> = {};
    for (const leaf of declarations(f, text).keys()) if (inCodebase[leaf]) names[leaf] = following?.held.get(joinName(ns, leaf)) ?? inCodebase[leaf];
    files[path.relative(root, f)] = { ns, sha: sha(text), names };
  }
  // and the files of the codebase that aren't code: each a name in its directory's namespace
  for (const f of assetFiles(root, new Set(exclude.map((e) => path.resolve(root, e))))) {
    const name = assetName(root, into, f);
    const h = following?.held.get(name) ?? cb.store.hashesAt(name).find((x) => cb.store.getDef(x)?.kind === "file");
    files[path.relative(root, f)] = { ns: name.slice(0, name.lastIndexOf(".")), sha: sha(fs.readFileSync(f, "utf8")), names: h ? { [fileLeaf(f)]: h } : {} };
  }
  saveMirror(cb, { dir: root, into, tests, exclude, log: following?.log ?? cb.store.logHead(), files });
}

// ---- writing back ---------------------------------------------------------------------------------------

/** A top-level declaration in a file: where its code is, where its doc comment is, whether it's exported. */
interface Decl {
  start: number;
  end: number;
  doc?: { start: number; end: number };
  exported: boolean;
  /** declared alongside others in one statement (`const a = 1, b = 2`): rewritten as a whole only */
  shared: boolean;
}

export function declarations(file: string, text: string): Map<string, Decl> {
  const sf = ts.parse(file, text);
  const out = new Map<string, Decl>();
  const add = (name: string, st: ts.Statement, shared = false) => {
    const docs = (st as { jsDoc?: readonly ts.Node[] }).jsDoc;
    const doc = docs?.length ? { start: docs.at(-1)!.getStart(sf), end: docs.at(-1)!.end } : undefined;
    const exported = (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const prev = out.get(name);
    // overloads: one definition from the first signature to the implementation
    if (prev) out.set(name, { ...prev, end: st.end });
    else out.set(name, { start: st.getStart(sf), end: st.end, ...(doc ? { doc } : {}), exported, shared });
  };
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) add(st.name.text, st);
    else if (ts.isVariableStatement(st)) {
      const ds = st.declarationList.declarations;
      for (const d of ds) if (ts.isIdentifier(d.name)) add(d.name.text, st, ds.length > 1);
    }
  }
  return out;
}

const docComment = (doc: string) => `/**\n${doc.split("\n").map((l) => (l ? ` * ${l}` : " *")).join("\n")}\n */\n`;

/** How a module is imported, for an import tcm adds: `node:fs`, `react/jsx-runtime`, `#tcm/server`. */
function specifierOf(ext: ExtRef): string {
  if (ext.module === SERVER_API_MODULE) return "#tcm/server";
  const npm = /^npm:(.+)@[^@]+$/.exec(ext.module);
  const base = npm ? npm[1]! : ext.module;
  return ext.subpath ? `${base}/${ext.subpath}` : base;
}

const extKey = (e: ExtRef) => `${e.module}|${e.subpath}|${e.export}`;

/**
 * How a file spells what its definitions refer to, learned from the definitions already in it: `ts.parse` through
 * a namespace import, `parse` through a named one, `fs` for a default import. A target nothing there refers to yet
 * is spelled like a sibling from the same module (`ts.` again), or gets an import.
 */
class Spelling {
  private exact = new Map<string, string>();
  /** by name too: a definition re-hashed under the same name (updated with others it's in a cycle with) reads the same */
  private byName = new Map<string, string>();
  /** a module (codebase file or package entry) → the namespace prefix it's reached through, `ts.` */
  private prefix = new Map<string, string>();
  /** imports the code written here needs: what each brings in, and whether any use of it is a value's */
  private wanted: { key: string; spec: string; name: string; local: string; value: boolean; file?: string }[] = [];
  private taken: Set<string>;
  private cb: Codebase;
  private file: string;
  private ns: string;
  private fileOf: (hash: string) => { file: string; ns: string; leaf: string } | undefined;

  constructor(
    cb: Codebase,
    file: string,
    ns: string,
    existing: DefRecord[],
    fileOf: (hash: string) => { file: string; ns: string; leaf: string } | undefined,
    taken: Iterable<string>,
    nameWas: (hash: string) => string | undefined,
  ) {
    this.cb = cb;
    this.file = file;
    this.ns = ns;
    this.fileOf = fileOf;
    this.taken = new Set(taken);
    for (const rec of existing) {
      for (const s of rec.spans) {
        const key = this.keyOf(s);
        if (!key || s.literal) continue;
        const text = rec.sourceText.slice(s.start, s.end);
        if (s.shorthand) continue;
        if (!this.exact.has(key)) this.exact.set(key, text);
        const was = s.hash && nameWas(s.hash);
        if (was && !this.byName.has(was)) this.byName.set(was, text);
        const dot = text.lastIndexOf(".");
        const mod = this.moduleOf(s);
        if (dot > 0 && mod && !this.prefix.has(mod)) this.prefix.set(mod, text.slice(0, dot + 1));
      }
    }
  }

  private keyOf(s: Span): string | undefined {
    return s.hash ? `#${s.hash}` : s.ext ? extKey(s.ext) : undefined;
  }

  private moduleOf(s: Span): string | undefined {
    if (s.hash) return this.fileOf(s.hash)?.file;
    return s.ext ? `${s.ext.module}|${s.ext.subpath}` : undefined;
  }

  private local(want: string): string {
    let name = want;
    for (let i = 1; this.taken.has(name); i++) name = `${want}_${i}`;
    this.taken.add(name);
    return name;
  }

  /** How `s` reads here; `self` is the definition's own name. */
  spell(s: Span, written: string, selfHash: string, selfLeaf: string): string {
    if (s.hash === selfHash) return selfLeaf;
    const key = this.keyOf(s);
    if (!key) return written;
    const known = this.exact.get(key);
    if (known) {
      const w = this.wanted.find((x) => x.key === key);
      if (w && s.pos !== "type") w.value = true;
      return known;
    }
    if (s.hash) {
      const t = this.fileOf(s.hash);
      if (!t) throw new Error(`refers to #${s.hash.slice(0, 8)}, which isn't in the mirror`);
      const named = this.byName.get(joinName(t.ns, t.leaf));
      if (named) return this.remember(key, named);
      if (t.ns === this.ns) return this.remember(key, t.leaf);
      const pre = this.prefix.get(t.file);
      if (pre) return this.remember(key, pre + t.leaf);
      const local = this.local(t.leaf);
      const value = s.pos !== "type" && this.cb.store.getDef(s.hash)?.kind !== "type";
      this.wanted.push({ key, spec: specifierFor(this.file, t.file, t.leaf), name: t.leaf, local, value, file: t.file });
      return this.remember(key, local);
    }
    const ext = s.ext!;
    const pre = this.prefix.get(`${ext.module}|${ext.subpath}`);
    if (pre && ext.export !== "default" && ext.export !== "*") return this.remember(key, pre + ext.export);
    const wanted = /^[A-Za-z_$][\w$]*$/.test(written) ? written : ext.export === "default" || ext.export === "*" ? "imported" : ext.export;
    const local = this.local(wanted);
    this.wanted.push({ key, spec: specifierOf(ext), name: ext.export, local, value: s.pos !== "type" });
    return this.remember(key, local);
  }

  /**
   * The imports the code written here needs: a statement per module (another for what's only used as a type),
   * Node's builtins first, then packages, then the project's own files.
   */
  /** The project's files the imports come from, and what from each: their declarations must be exported. */
  get importedFrom(): { file: string; leaf: string }[] {
    return this.wanted.flatMap((w) => (w.file ? [{ file: w.file, leaf: w.name }] : []));
  }

  get imports(): string[] {
    const group = (spec: string) => (spec.startsWith("node:") ? 0 : spec.startsWith(".") ? 2 : 1);
    const out: string[] = [];
    for (const spec of [...new Set(this.wanted.map((w) => w.spec))].sort((a, b) => group(a) - group(b))) {
      const from = JSON.stringify(spec);
      for (const value of [true, false]) {
        const ws = this.wanted.filter((w) => w.spec === spec && w.value === value);
        const type = value ? "" : "type ";
        const star = ws.find((w) => w.name === "*");
        const dflt = ws.find((w) => w.name === "default");
        const named = ws.filter((w) => w.name !== "*" && w.name !== "default").map((w) => (w.local === w.name ? w.local : `${w.name} as ${w.local}`));
        if (star) out.push(`import ${type}* as ${star.local} from ${from};`);
        // (a type-only import has a default or named bindings, not both)
        if (dflt && (value || !named.length)) out.push(`import ${type}${dflt.local}${named.length ? `, { ${named.join(", ")} }` : ""} from ${from};`);
        else {
          if (dflt) out.push(`import type ${dflt.local} from ${from};`);
          if (named.length) out.push(`import ${type}{ ${named.join(", ")} } from ${from};`);
        }
      }
    }
    return out;
  }

  private remember(key: string, text: string): string {
    this.exact.set(key, text);
    return text;
  }
}

/** A definition's code as it reads in its mirror file. */
function codeFor(rec: DefRecord, leaf: string, spelling: Spelling, exported: boolean): string {
  let text = rec.sourceText;
  for (const s of [...rec.spans].sort((a, b) => b.start - a.start)) {
    if (s.literal) continue;
    const written = text.slice(s.start, s.end);
    let spelled = spelling.spell(s, written, rec.hash, leaf);
    if (s.shorthand && spelled !== s.shorthand) spelled = `${s.shorthand}: ${spelled}`;
    text = text.slice(0, s.start) + spelled + text.slice(s.end);
  }
  if (!exported) return text;
  const starts = ts.parse("code.ts", text).statements.map((st) => st.getStart());
  for (const at of [...starts].reverse()) text = text.slice(0, at) + "export " + text.slice(at);
  return text;
}

/** Stored code leaves out a declaration's `;`: put it back where the file (or a variable declaration) has one. */
const terminated = (code: string, semicolon: boolean) => (semicolon && !/[;}]\s*$/.test(code) ? `${code};` : code);

interface Edit {
  start: number;
  end: number;
  text: string;
}

const applyEdits = (text: string, edits: Edit[]) => {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
};

/** The names a file's imports bind. */
function importedNames(file: string, text: string): string[] {
  const out: string[] = [];
  for (const st of ts.parse(file, text).statements) {
    const c = ts.isImportDeclaration(st) ? st.importClause : undefined;
    if (!c) continue;
    if (c.name) out.push(c.name.text);
    const b = c.namedBindings;
    if (b && ts.isNamespaceImport(b)) out.push(b.name.text);
    else if (b) for (const e of b.elements) out.push(e.name.text);
  }
  return out;
}

/** Where new imports go: after the file's last import, or at its top. */
function importsAt(file: string, text: string): number {
  const sf = ts.parse(file, text);
  const last = sf.statements.filter((s) => ts.isImportDeclaration(s)).at(-1);
  return last ? last.end : 0;
}

/** Changes to the name log since `log` that leave code's text as it was: dependents re-hashed, packages upgraded. */
function untextual(cb: Codebase, log: number): Set<string> {
  const out = new Set<string>();
  // a name whose code was also changed (saved from a scratch file, say) since reads differently, even if a
  // propagation re-hashed it again after
  const textual = new Set<string>();
  for (const e of cb.store.history(Number.MAX_SAFE_INTEGER, log)) {
    if (e.op !== "update" || !e.newHash) continue;
    if (e.command.endsWith("(propagated)") || e.command.startsWith("upgrade ")) out.add(e.newHash);
    else textual.add(e.path);
  }
  for (const e of cb.store.history(Number.MAX_SAFE_INTEGER, log)) if (e.newHash && textual.has(e.path)) out.delete(e.newHash);
  return out;
}

/**
 * Bring the mirror's files up to date with the codebase, if this codebase has one and its names changed. Returns
 * whether the files now match.
 */
export function syncMirror(cb: Codebase): boolean {
  const m = loadMirror(cb);
  if (!m || cb.store.logHead() === m.log) return true;
  const abs = (rel: string) => path.join(m.dir, rel);
  // never overwrite a hand edit: until the file is imported again, the mirror waits
  const handEdited = Object.entries(m.files).filter(([rel, f]) => !fs.existsSync(abs(rel)) || sha(fs.readFileSync(abs(rel), "utf8")) !== f.sha);
  if (handEdited.length) {
    console.log(yellow(`mirror: ${handEdited.map(([rel]) => rel).slice(0, 3).join(", ")}${handEdited.length > 3 ? ", …" : ""} changed outside tcm and ${handEdited.length > 1 ? "don't" : "doesn't"} import yet; the codebase's changes are written to the files once they do (at the next command)`));
    return false;
  }
  const untouched = untextual(cb, m.log);
  // the files of code (a namespace each); the rest (Markdown, CSS, images) are files of the codebase, below
  const code = () => Object.entries(m.files).filter(([rel]) => !isAsset(rel));
  const byNs = new Map(code().map(([rel, f]) => [f.ns, rel]));
  const now = new Map<string, Record<string, string>>();
  for (const [, f] of code()) now.set(f.ns, namesIn(cb, f.ns));
  const problems: string[] = [];
  // a definition in a namespace no file is for yet: its file is made, where the namespace says it goes
  const created: string[] = [];
  for (const n of cb.store.names()) {
    if (!n.path.startsWith(m.into ? `${m.into}.` : "")) continue;
    const ns = n.path.slice(0, n.path.lastIndexOf("."));
    if (byNs.has(ns) || [...byNs.keys()].some((k) => k.startsWith(`${ns}.`))) continue;
    const names = namesIn(cb, ns);
    const rel = fileFor(m, ns, Object.values(names).some((h) => cb.store.getDef(h)?.jsx));
    if (!rel) {
      problems.push(`${n.path} is in ${ns}, and there's no file it could be in that the mirror would read as ${ns}; create one, then \`tcm import --update\``);
      continue;
    }
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), "");
    m.files[rel] = { ns, sha: sha(""), names: {} };
    byNs.set(ns, rel);
    now.set(ns, names);
    created.push(rel);
  }
  // where each definition of the mirror lives now, for references to it
  const home = new Map<string, { file: string; ns: string; leaf: string }>();
  for (const [ns, names] of now) for (const [leaf, h] of Object.entries(names)) home.set(h, { file: abs(byNs.get(ns)!), ns, leaf });
  const before = new Map(code().map(([rel]) => [rel, fs.readFileSync(abs(rel), "utf8")]));
  // what each definition the files hold was called when tcm last wrote them
  const named = new Map<string, string>();
  for (const [, f] of code()) for (const [leaf, h] of Object.entries(f.names)) named.set(h, joinName(f.ns, leaf));
  const renames: { rel: string; from: string; to: string }[] = [];
  // definitions gone from one file's namespace to another's: by hash, where from and what they were called there
  const moves: Move[] = [];
  // what the files written import from the project's others
  const imported: { file: string; leaf: string }[] = [];
  const moved = new Map<string, { file: string; leaf: string }>();
  for (const [rel, f] of code()) {
    const cur = new Set(Object.values(now.get(f.ns)!));
    for (const [leaf, h] of Object.entries(f.names)) if (!cur.has(h) && home.has(h) && home.get(h)!.file !== abs(rel)) moved.set(h, { file: abs(rel), leaf });
  }

  for (const [rel, f] of code()) {
    const text = before.get(rel)!;
    const cur = now.get(f.ns)!;
    const decls = declarations(abs(rel), text);
    const curByHash = new Map(Object.entries(cur).map(([l, h]) => [h, l]));
    const edits: Edit[] = [];
    const existing = Object.values(f.names).map((h) => cb.store.getDef(h)).filter((d): d is DefRecord => !!d);
    const spelling = new Spelling(cb, abs(rel), f.ns, existing, (h) => home.get(h), [...decls.keys(), ...Object.keys(cur), ...importedNames(abs(rel), text)], (h) => named.get(h));
    const renamedTo = new Set<string>();
    for (const [leaf, h] of Object.entries(f.names)) {
      const d = decls.get(leaf);
      const to = curByHash.get(h);
      if (cur[leaf] === h) continue;
      // the same definition under a new name: renamed at every reference, below
      if (to && to !== leaf && !(to in f.names)) {
        renames.push({ rel, from: leaf, to });
        renamedTo.add(to);
        continue;
      }
      if (!d) continue;
      const next = cur[leaf];
      if (!next) {
        // moved to another file's namespace: imports of it follow it, below
        if (moved.has(h)) moves.push({ from: abs(rel), to: home.get(h)!.file, leaf, as: leaf });
        // gone from the namespace: its declaration and doc go too, with the blank line after
        const from = d.doc?.start ?? d.start;
        let end = d.end;
        while (text[end] === "\n" && text[end + 1] === "\n") end++;
        edits.push({ start: from, end: end + (text[end] === "\n" ? 1 : 0), text: "" });
        continue;
      }
      if (untouched.has(next)) continue;
      if (d.shared) {
        problems.push(`${joinName(f.ns, leaf)} is declared alongside others in ${rel}; change it there by hand`);
        continue;
      }
      const rec = cb.store.getDef(next)!;
      try {
        edits.push({ start: d.start, end: d.end, text: terminated(codeFor(rec, leaf, spelling, d.exported), text.slice(d.start, d.end).endsWith(";")) });
        const was = cb.store.getDef(h)?.doc;
        if ((rec.doc ?? "") !== (was ?? "")) {
          if (d.doc) edits.push({ start: d.doc.start, end: d.start, text: rec.doc ? docComment(rec.doc) : "" });
          else if (rec.doc) edits.push({ start: d.start, end: d.start, text: docComment(rec.doc) });
        }
      } catch (e) {
        problems.push(`${joinName(f.ns, leaf)}: ${(e as Error).message}`);
      }
    }
    // new in the namespace: added at the end of its file
    let added = "";
    for (const [leaf, h] of Object.entries(cur)) {
      if (leaf in f.names || renamedTo.has(leaf)) continue;
      const rec = cb.store.getDef(h)!;
      // moved here and renamed: written as it was called, then renamed at every reference like any rename
      const was = moved.get(h)?.leaf;
      if (was && was !== leaf) {
        renames.push({ rel, from: was, to: leaf });
        renamedTo.add(leaf);
      }
      try {
        const code = codeFor(rec, was ?? leaf, spelling, true);
        added += `\n${rec.doc ? docComment(rec.doc) : ""}${terminated(code, /^(export )?(const|let|var|type) /.test(code))}\n`;
      } catch (e) {
        problems.push(`${joinName(f.ns, leaf)}: ${(e as Error).message}`);
      }
    }
    // a new file starts with its imports, if any, then its code
    if (added) edits.push({ start: text.length, end: text.length, text: !text ? (spelling.imports.length ? added : added.replace(/^\n/, "")) : (text.endsWith("\n") ? "" : "\n") + added });
    if (spelling.imports.length) {
      const at = importsAt(abs(rel), text);
      edits.push({ start: at, end: at, text: (at ? "\n" : "") + spelling.imports.join("\n") + (at ? "" : "\n") });
    }
    if (edits.length) fs.writeFileSync(abs(rel), pruneImports(abs(rel), text, applyEdits(text, edits)));
    imported.push(...spelling.importedFrom);
  }
  // in the codebase anything can be imported; in the files, what's imported from another is exported there
  for (const file of new Set(imported.map((i) => i.file))) {
    const text = fs.readFileSync(file, "utf8");
    const decls = declarations(file, text);
    const edits: Edit[] = [];
    for (const leaf of new Set(imported.filter((i) => i.file === file).map((i) => i.leaf))) {
      const d = decls.get(leaf);
      if (d && !d.exported && !edits.some((e) => e.start === d.start)) edits.push({ start: d.start, end: d.start, text: "export " });
    }
    if (edits.length) fs.writeFileSync(file, applyEdits(text, edits));
  }
  // files of the codebase that aren't code: written as it has them now, removed with them, made for new ones
  const assetsBefore = new Map<string, Buffer>();
  const createdAssets: string[] = [];
  const recorded = new Set<string>();
  for (const [rel, f] of Object.entries(m.files)) {
    if (!isAsset(rel)) continue;
    const name = joinName(f.ns, fileLeaf(rel));
    recorded.add(name);
    const h = cb.store.hashesAt(name).find((x) => cb.store.getDef(x)?.kind === "file");
    const was = fs.readFileSync(abs(rel));
    // (the same file reads differently when what it names was renamed)
    const content = h && fileContent(cb, cb.store.getDef(h)!, f.ns);
    if (content && content.equals(was)) continue;
    assetsBefore.set(rel, was);
    if (content) fs.writeFileSync(abs(rel), content);
    else fs.rmSync(abs(rel), { force: true });
  }
  for (const [name, rec] of filesIn(cb, m.into)) {
    if (recorded.has(name)) continue;
    const rest = (m.into ? name.slice(m.into.length + 1) : name).split(".");
    const rel = path.join(...rest.slice(0, -1), `${rest.at(-1)}.${formatOf(rec)}`);
    if (fs.existsSync(abs(rel))) {
      problems.push(`${name} would be written to ${rel}, which is there already`);
      continue;
    }
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), fileContent(cb, rec, name.slice(0, name.lastIndexOf("."))));
    m.files[rel] = { ns: name.slice(0, name.lastIndexOf(".")), sha: "", names: {} };
    createdAssets.push(rel);
  }
  // files outside the mirror that a rename reached, as they were
  let outside = new Map<string, string>();
  if (moves.length && !problems.length) {
    const files = [...Object.keys(m.files).map(abs), ...nearbyFiles(m, moves.map((v) => v.leaf))];
    outside = followMoves(files, new Set(Object.keys(m.files).map(abs)), moves, problems);
  }
  if (renames.length && !problems.length) {
    try {
      for (const [file, text] of renameEverywhere(cb, m, renames)) if (!outside.has(file)) outside.set(file, text);
    } catch (e) {
      problems.push(`renaming: ${(e as Error).message}`);
    }
  }

  const restore = () => {
    for (const [rel, text] of before) if (!created.includes(rel)) fs.writeFileSync(abs(rel), text);
    for (const rel of created) fs.rmSync(abs(rel), { force: true });
    for (const [file, text] of outside) fs.writeFileSync(file, text);
    for (const [rel, bytes] of assetsBefore) fs.writeFileSync(abs(rel), bytes);
    for (const rel of createdAssets) {
      fs.rmSync(abs(rel), { force: true });
      delete m.files[rel];
    }
  };
  // nothing written (the codebase's changes left the text alone): the files are as they were
  const wrote = created.length > 0 || outside.size > 0 || assetsBefore.size > 0 || createdAssets.length > 0 || [...before].some(([rel, text]) => fs.readFileSync(abs(rel), "utf8") !== text);
  if (!problems.length && wrote) {
    // the files must hash to what the codebase holds; a renamed function or class doesn't until the codebase takes
    // the renamed code
    const mismatch = checkMirror(cb, m, true);
    if (mismatch.length && renames.length && cb.adoptMirror) {
      console.log(dim(`mirror: ${renames.map((r) => `${r.from} → ${r.to}`).join(", ")} renamed in the code too; importing it`));
      if (cb.adoptMirror(m) && !checkMirror(cb, loadMirror(cb) ?? m, true).length) return true;
      problems.push("importing the renamed code didn't bring the files and the codebase together");
    } else if (mismatch.length) problems.push(...mismatch);
  }
  if (problems.length) {
    restore();
    console.log(red(`mirror: couldn't write the codebase's changes to ${path.relative(process.cwd(), m.dir) || "."}; the files are as they were`));
    for (const p of problems.slice(0, 10)) console.log(red(`  ${p}`));
    return false;
  }
  const changed = [...[...before].filter(([rel, text]) => fs.readFileSync(abs(rel), "utf8") !== text).map(([rel]) => rel), ...assetsBefore.keys(), ...createdAssets];
  if (changed.length) console.log(dim(`mirror: wrote ${changed.join(", ")}${outside.size ? ` (and renamed in ${[...outside.keys()].map((f) => path.relative(m.dir, f)).join(", ")}, outside it)` : ""}`));
  for (const [rel, f] of Object.entries(m.files)) {
    if (!isAsset(rel)) {
      m.files[rel] = { ...f, sha: sha(fs.readFileSync(abs(rel), "utf8")), names: now.get(f.ns)! };
      continue;
    }
    if (!fs.existsSync(abs(rel))) {
      delete m.files[rel];
      continue;
    }
    const h = cb.store.hashesAt(joinName(f.ns, fileLeaf(rel))).find((x) => cb.store.getDef(x)?.kind === "file");
    m.files[rel] = { ...f, sha: sha(fs.readFileSync(abs(rel), "utf8")), names: h ? { [fileLeaf(rel)]: h } : {} };
  }
  m.log = cb.store.logHead();
  saveMirror(cb, m);
  return true;
}

/** Rename definitions at every reference in the mirror's files, as an editor's rename would. */
function renameEverywhere(cb: Codebase, m: Mirror, renames: { rel: string; from: string; to: string }[]): Map<string, string> {
  const files = Object.keys(m.files).map((rel) => path.join(m.dir, rel));
  // and the files around the mirror that may use the names (scripts, tests): renamed too, not checked
  const near = nearbyFiles(m, renames.map((r) => r.from));
  const { program, service } = createProgram([...files, ...near], cb.compilerOptions(m.dir, "import"));
  const edits = new Map<string, Edit[]>();
  for (const r of renames) {
    const file = path.join(m.dir, r.rel);
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`${r.rel} isn't in the program`);
    const name = findDeclarationName(sf, r.from);
    if (!name) throw new Error(`no declaration of ${r.from} in ${r.rel}`);
    for (const entry of service.getReferencedSymbolsForNode(name, name.getStart(sf))) {
      for (const ref of entry.references as unknown as ts.NodeHandle[]) {
        const node = ref.resolve();
        if (!node || !ts.isIdentifier(node) || node.text !== r.from) continue;
        const refFile = node.getSourceFile();
        const text = ts.isShorthandPropertyAssignment(node.parent) ? `${r.from}: ${r.to}` : r.to;
        const list = edits.get(refFile.fileName) ?? [];
        if (!list.some((e) => e.start === node.getStart(refFile))) list.push({ start: node.getStart(refFile), end: node.end, text });
        edits.set(refFile.fileName, list);
      }
    }
  }
  const outside = new Map<string, string>();
  const mirrored = new Set(files);
  for (const [file, list] of edits) {
    const text = fs.readFileSync(file, "utf8");
    if (!mirrored.has(file)) outside.set(file, text);
    fs.writeFileSync(file, applyEdits(text, list));
  }
  return outside;
}

function findDeclarationName(sf: ts.SourceFile, name: string): ts.Identifier | undefined {
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name?.text === name) return st.name;
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.name;
  }
  return undefined;
}

/**
 * What doesn't match between the mirror's files and the codebase, re-analyzing the files as `import` does. With
 * `keepText`, when they match, the codebase keeps each definition's code as the files spell it, so the next write
 * spells references the way the files do (not as the scratch file it was edited in did).
 */
export function checkMirror(cb: Codebase, m: Mirror, keepText = false): string[] {
  const files = sourceFiles(m.dir, new Set(m.exclude.map((e) => path.resolve(m.dir, e))), m.tests);
  const a = cb.analyzeProject(files, (file, name) => cb.lineageSalt(joinName(m.into, namespaceForFile(m.dir, file), name)), [], cb.compilerOptions(m.dir, "import"));
  const problems = [...a.errors, ...a.diagnostics.map((d) => d.message)];
  if (problems.length) return problems;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of a.defs) {
    const p = joinName(m.into, namespaceForFile(m.dir, d.file), d.nameHint);
    seen.add(p);
    const hs = cb.store.hashesAt(p);
    if (!hs.includes(d.hash)) out.push(`${p}: the file's code hashes to #${d.hash.slice(0, 8)}, the codebase has ${hs.length ? hs.map((h) => `#${h.slice(0, 8)}`).join(", ") : "nothing there"}`);
  }
  for (const [rel, f] of Object.entries(m.files)) {
    if (isAsset(rel)) continue;
    for (const leaf of Object.keys(namesIn(cb, f.ns))) if (!seen.has(joinName(f.ns, leaf))) out.push(`${joinName(f.ns, leaf)} is in the codebase but not in the files`);
  }
  // files of the codebase that aren't code: the same content
  for (const file of assetFiles(m.dir, new Set(m.exclude.map((e) => path.resolve(m.dir, e))))) {
    const name = assetName(m.dir, m.into, file);
    seen.add(name);
    const { def } = fileDefinition(cb, name, fileFormat(file)!, fs.readFileSync(file));
    const hs = cb.store.hashesAt(name);
    if (!hs.includes(def.hash)) out.push(`${name}: the file hashes to #${def.hash.slice(0, 8)}, the codebase has ${hs.length ? hs.map((h) => `#${h.slice(0, 8)}`).join(", ") : "nothing there"}`);
  }
  for (const name of filesIn(cb, m.into).keys()) if (!seen.has(name)) out.push(`${name} is in the codebase but not in the files`);
  if (keepText && !out.length) {
    for (const d of a.defs) {
      const was = cb.store.getDef(d.hash);
      if (was && was.sourceText !== d.sourceText) cb.store.replaceSource(d.hash, d.sourceText, d.spans, d.reservedNames);
    }
  }
  return out;
}

// ---- releases, kept in git ------------------------------------------------------------------------------
//
// A release is a point in the codebase's history. A mirrored codebase can be made again from its files, so its
// releases are kept where the files are: `tcm-releases.json` in the mirrored directory records each one (the
// git commit its code is in, and its notes), and a codebase linked to the mirror afresh makes them again by
// importing each one's commit, in order, before the files as they are now.

/** A release as the mirror keeps it. */
export interface ReleaseRecord {
  package: string;
  version: string;
  /** the git commit holding the mirror's files as released */
  commit: string;
  notes: string;
  author: string;
  ts: number;
}

const RECORDS = "tcm-releases.json";

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

export function releaseRecords(dir: string): ReleaseRecord[] {
  const file = path.join(dir, RECORDS);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as ReleaseRecord[]) : [];
}

/**
 * The commit a release of a mirrored codebase is made from: the mirror's files must all be committed, so the
 * release can be made again from git. Undefined when the mirror isn't in a git repository.
 */
export function releaseCommit(m: Mirror): string | undefined {
  if (git(m.dir, "rev-parse", "--is-inside-work-tree") !== "true") return undefined;
  const dirty = git(m.dir, "status", "--porcelain", "--", ".", `:!${RECORDS}`);
  if (dirty === undefined || dirty) {
    throw new Error(`${path.relative(process.cwd(), m.dir) || "the mirror"} has changes git doesn't have yet; commit them first, so the release can be made again from git`);
  }
  return git(m.dir, "rev-parse", "HEAD");
}

/** Add a release to the mirror's records (for git: commit them with the next change). */
export function recordRelease(m: Mirror, r: ReleaseRecord) {
  const records = [...releaseRecords(m.dir).filter((x) => !(x.package === r.package && x.version === r.version)), r];
  fs.writeFileSync(path.join(m.dir, RECORDS), JSON.stringify(records, null, 2) + "\n");
}

/**
 * Let code taken from git (into `root`, a copy of the mirror `dir`) resolve its packages as it did: a workspace
 * package (a directory with a package.json naming it) to its copy here, anything else to what's installed now.
 * Each package gets a node_modules like its counterpart's in `dir` (pnpm installs dependencies per package), with
 * the workspace's own packages pointing at the copies.
 */
function linkPackages(root: string, dir: string, top: string) {
  const workspace = new Map<string, string>();
  const packages = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  for (const p of [root, ...packages]) {
    const pkgJson = path.join(p, "package.json");
    const name = fs.existsSync(pkgJson) ? (JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { name?: string }).name : undefined;
    if (name) workspace.set(name, p);
  }
  const link = (target: string, at: string) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    if (!fs.existsSync(at)) fs.symlinkSync(target, at, "dir");
  };
  for (const [name, p] of workspace) link(p, path.join(top, "node_modules", name));
  for (const p of [root, ...packages]) {
    const installed = path.join(dir, path.relative(root, p), "node_modules");
    if (!fs.existsSync(installed)) continue;
    for (const e of fs.readdirSync(installed)) {
      if (e.startsWith(".")) continue;
      const names = e.startsWith("@") ? fs.readdirSync(path.join(installed, e)).map((n) => `${e}/${n}`) : [e];
      for (const name of names) {
        const target = workspace.get(name) ?? fs.realpathSync(path.join(installed, name));
        link(target, path.join(p, "node_modules", name));
      }
    }
  }
}

/**
 * Make a mirror's recorded releases again, in a codebase that doesn't have them: for each, in order, its commit's
 * files are imported (`importAt`) and the release is put at the history entry that makes. The files are taken
 * from git into a directory inside the repository, so packages resolve as they did, and workspace packages
 * (`@tcm/core`, say) are linked to their copies there rather than to today's.
 */
export function replayReleases(cb: Codebase, dir: string, importAt: (root: string, label: string) => boolean, namespaceOf: (pkg: string) => string | undefined): number {
  const records = releaseRecords(dir).filter((r) => !cb.store.release(r.package, r.version));
  if (!records.length) return 0;
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!top) throw new Error(`${dir} has release records (${RECORDS}) but isn't in a git repository to make them from`);
  const rel = path.relative(top, dir) || ".";
  let made = 0;
  for (const r of records) {
    const at = fs.mkdtempSync(path.join(top, ".tcm-release-"));
    try {
      const tar = spawnSync("sh", ["-c", `git -C "$0" archive "$1" -- "$2" | tar -x -C "$3"`, top, r.commit, rel, at], { encoding: "utf8" });
      if (tar.status !== 0) throw new Error(`can't take ${r.package}@${r.version}'s files from git (commit ${r.commit.slice(0, 8)}): ${tar.stderr.trim()}`);
      const root = path.join(at, rel);
      linkPackages(root, dir, at);
      console.log(dim(`making ${r.package}@${r.version} again from git (${r.commit.slice(0, 8)})…`));
      if (!importAt(root, `${path.relative(process.cwd(), dir) || "."} at ${r.commit.slice(0, 8)}`)) throw new Error(`${r.package}@${r.version}'s files (commit ${r.commit.slice(0, 8)}) didn't import`);
      // its own history entry, which what's imported next doesn't replace (a command's changes are otherwise one)
      cb.store.endBatch();
      const namespace = namespaceOf(r.package);
      if (namespace === undefined) throw new Error(`${r.package}@${r.version}: its commit has no package ${r.package}`);
      cb.store.putRelease({ package: r.package, version: r.version, namespace, causal: cb.store.head(), notes: r.notes, author: r.author, ts: r.ts });
      made++;
    } finally {
      fs.rmSync(at, { recursive: true, force: true });
    }
  }
  return made;
}

/**
 * Drop the imports an edit stopped using: names `after` binds and doesn't mention that `before` did. Imports that
 * were already unused are left as they are (the file's author's business); an import with nothing left goes.
 */
export function pruneImports(file: string, before: string, after: string): string {
  const was = unusedImports(file, before);
  const gone = [...unusedImports(file, after)].filter((n) => !was.has(n));
  if (!gone.length) return after;
  const sf = ts.parse(file, after);
  const edits: Edit[] = [];
  for (const st of sf.statements) {
    const clause = ts.isImportDeclaration(st) ? st.importClause : undefined;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    const names = [...(clause.name ? [clause.name.text] : []), ...(bindings && ts.isNamespaceImport(bindings) ? [bindings.name.text] : bindings ? bindings.elements.map((e) => e.name.text) : [])];
    if (!names.some((n) => gone.includes(n))) continue;
    if (names.every((n) => gone.includes(n))) {
      edits.push({ start: st.getStart(sf), end: after[st.end] === "\n" ? st.end + 1 : st.end, text: "" });
      continue;
    }
    // some of its names stay: take out the others
    if (bindings && !ts.isNamespaceImport(bindings)) {
      const keep = bindings.elements.filter((e) => !gone.includes(e.name.text));
      if (keep.length < bindings.elements.length) edits.push({ start: bindings.getStart(sf), end: bindings.end, text: `{ ${keep.map((e) => e.getText(sf)).join(", ")} }` });
    }
  }
  return applyEdits(after, edits);
}

/**
 * The names a file's imports bind that nothing else in it mentions.
 */
export function unusedImports(file: string, text: string): Set<string> {
  const sf = ts.parse(file, text);
  const mentioned = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) mentioned.add(n.text);
    n.forEachChild(visit);
  };
  for (const st of sf.statements) if (!ts.isImportDeclaration(st)) visit(st);
  return new Set(importedNames(file, text).filter((n) => !mentioned.has(n)));
}

/**
 * Where a new namespace's file goes in a mirror: next to a sibling namespace's file, in a parent's directory (or
 * an index.ts for a namespace with children), or by the namespace's path from the root. Only a path the mirror
 * reads back as that namespace, and that doesn't exist yet.
 */
export function fileFor(m: Mirror, ns: string, jsx: boolean): string | undefined {
  const ext = jsx ? ".tsx" : ".ts";
  const parent = ns.includes(".") ? ns.slice(0, ns.lastIndexOf(".")) : "";
  const leaf = ns.slice(ns.lastIndexOf(".") + 1);
  const candidates: string[] = [];
  for (const [rel, f] of Object.entries(m.files)) {
    const dir = path.dirname(rel);
    const fParent = f.ns.includes(".") ? f.ns.slice(0, f.ns.lastIndexOf(".")) : "";
    if (fParent === parent) candidates.push(path.join(dir, leaf + ext));
    if (f.ns === parent) candidates.push(/^index\.(m|c)?tsx?$/.test(path.basename(rel)) ? path.join(dir, leaf + ext) : path.join(dir, path.basename(rel).replace(/\.(m|c)?tsx?$/, ""), leaf + ext));
    if (fParent === ns) candidates.push(path.join(dir, "index" + ext));
  }
  const rest = (m.into && ns.startsWith(`${m.into}.`) ? ns.slice(m.into.length + 1) : ns).split(".");
  candidates.push(path.join(...rest) + ext);
  return candidates.find((c) => joinName(m.into, namespaceForFile(m.dir, path.join(m.dir, c))) === ns && !fs.existsSync(path.join(m.dir, c)));
}

/**
 * TypeScript files near a mirror that aren't in it and mention any of `names`: the rest of its git repository
 * (or its parent directory), leaving out installed packages, build output, hidden directories and codebases.
 */
export function nearbyFiles(m: Mirror, names: string[]): string[] {
  const top = git(m.dir, "rev-parse", "--show-toplevel") ?? path.dirname(m.dir);
  const mirrored = new Set(Object.keys(m.files).map((rel) => path.join(m.dir, rel)));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !["node_modules", "dist", "build", "coverage"].includes(e.name) && !fs.existsSync(path.join(p, ".tcm"))) walk(p);
        continue;
      }
      if (!/\.(m|c)?tsx?$/.test(e.name) || /\.d\.(m|c)?ts$/.test(e.name) || mirrored.has(p)) continue;
      const text = fs.readFileSync(p, "utf8");
      if (names.some((n) => text.includes(n))) out.push(p);
    }
  };
  walk(top);
  return out;
}

/**
 * The mirror's files changed since tcm last wrote or read them (by hand, or by git: a pull, a checkout), or added or removed.
 */
export function changedFiles(m: Mirror): string[] {
  const out = Object.entries(m.files)
    .filter(([rel, f]) => !fs.existsSync(path.join(m.dir, rel)) || sha(fs.readFileSync(path.join(m.dir, rel), "utf8")) !== f.sha)
    .map(([rel]) => rel);
  const exclude = new Set(m.exclude.map((e) => path.resolve(m.dir, e)));
  for (const f of [...sourceFiles(m.dir, exclude, m.tests), ...assetFiles(m.dir, exclude)]) {
    if (!(path.relative(m.dir, f) in m.files)) out.push(path.relative(m.dir, f));
  }
  return out;
}

/**
 * Whether module `entry` exports `leaf` from `file`, under that name: it is the file, or re-exports it (`export * from`, `export { leaf } from`).
 */
export function exportsFrom(entry: string, file: string, leaf: string, seen: Set<string>): boolean {
  if (entry === file) return true;
  if (seen.has(entry) || !fs.existsSync(entry)) return false;
  seen.add(entry);
  for (const m of fs.readFileSync(entry, "utf8").matchAll(/export\s+(?:type\s+)?(\*|\{([^}]*)\})\s+from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const named = m[2]?.split(",").map((e) => e.trim().replace(/^type\s+/, "").split(/\s+as\s+/));
    if (m[1] !== "*" && !named?.some(([a, b]) => a === leaf && (b ?? a) === leaf)) continue;
    if (exportsFrom(path.resolve(path.dirname(entry), m[3]!), file, leaf, seen)) return true;
  }
  return false;
}

/**
 * The directory of the package a file is in: the nearest with a package.json.
 */
export function packageDirOf(file: string): string | undefined {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

/**
 * How a file imports `leaf` from the project's file `to`: by path, or from another package (the nearest
 * package.json isn't the same, and it's a dependency) by that package's name, when an entry of its `exports`
 * exports it (re-exporting it through barrels counts).
 */
export function specifierFor(from: string, to: string, leaf: string): string {
  const rel = path.relative(path.dirname(from), to).split(path.sep).join("/");
  const relative = rel.startsWith(".") ? rel : `./${rel}`;
  const theirs = packageDirOf(to);
  const ours = packageDirOf(from);
  if (!theirs || !ours || theirs === ours) return relative;
  const read = (dir: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const pkg = read(theirs);
  const deps = read(ours);
  const name = typeof pkg.name === "string" ? pkg.name : undefined;
  if (!name || !["dependencies", "devDependencies", "peerDependencies"].some((k) => typeof deps[k] === "object" && deps[k] && name in (deps[k] as object))) return relative;
  const entries: Record<string, unknown> = typeof pkg.exports === "string" ? { ".": pkg.exports } : pkg.exports && typeof pkg.exports === "object" ? (pkg.exports as Record<string, unknown>) : typeof pkg.main === "string" ? { ".": pkg.main } : {};
  for (const [sub, target] of Object.entries(entries)) {
    if (typeof target !== "string" || sub.includes("*")) continue;
    if (exportsFrom(path.resolve(theirs, target), to, leaf, new Set())) return sub === "." ? name : `${name}${sub.slice(1)}`;
  }
  return relative;
}

/**
 * A definition moved from one mirrored file's namespace to another's (as `as` there, if renamed too).
 */
export interface Move {
  from: string;
  to: string;
  leaf: string;
  as: string;
}

/**
 * Imports and re-exports of moved definitions, pointed at the files they're in now: `{ x }` from the old file
 * becomes an import from the new one (`{ y as x }` if renamed too, so the code using it reads the same), the new
 * file stops importing it, and the old file imports it if its other code still uses it. A namespace import
 * (`a.x`) can't follow: that's a problem. Returns the text of the files outside `mirrored` it changed, as they
 * were.
 */
export function followMoves(files: string[], mirrored: Set<string>, moves: Move[], problems: string[]): Map<string, string> {
  const outside = new Map<string, string>();
  for (const file of new Set(files)) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.parse(file, text);
    const edits: Edit[] = [];
    const added: string[] = [];
    for (const st of sf.statements) {
      const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      if (!spec?.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      const here = moves.filter((v) => v.from === target);
      if (!here.length) continue;
      const clause = ts.isImportDeclaration(st) ? st.importClause : undefined;
      const bindings = clause?.namedBindings ?? (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause : undefined);
      if (bindings && ts.isNamespaceImport(bindings)) {
        for (const v of here) if (new RegExp(`\\b${bindings.name.text}\\.${v.leaf}\\b`).test(text)) problems.push(`${path.relative(process.cwd(), file)} uses ${bindings.name.text}.${v.leaf}, which moved to ${path.relative(path.dirname(file), v.to)}; change it there by hand`);
        continue;
      }
      if (!bindings) continue;
      const elements = bindings.elements as readonly (ts.ImportSpecifier | ts.ExportSpecifier)[];
      const moving = (e: ts.ImportSpecifier | ts.ExportSpecifier) => here.find((v) => (e.propertyName ?? e.name).text === v.leaf);
      if (!elements.some(moving)) continue;
      const keep = elements.filter((e) => !moving(e));
      const kw = ts.isImportDeclaration(st) ? "import" : "export";
      const type = (ts.isImportDeclaration(st) ? ts.isTypeOnlyImport(clause) : ts.isExportDeclaration(st) && st.isTypeOnly) ? " type" : "";
      // what stays imported from the old file
      const dflt = clause?.name ? `${clause.name.text}${keep.length ? ", " : ""}` : "";
      const end = text[st.end] === "\n" ? st.end + 1 : st.end;
      edits.push({ start: st.getStart(sf), end, text: keep.length || dflt ? `${kw}${type} ${dflt}${keep.length ? `{ ${keep.map((e) => e.getText(sf)).join(", ")} }` : ""} from ${JSON.stringify(spec)};\n` : "" });
      // and what's imported from the new ones (nothing, in the file it's in now)
      for (const e of elements) {
        const v = moving(e);
        if (!v || v.to === file) continue;
        const local = e.name.text;
        const name = v.as === local && !e.propertyName ? local : `${v.as} as ${local}`;
        added.push(`${kw}${type} { ${e.isTypeOnly ? "type " : ""}${name} } from ${JSON.stringify(specifierFor(file, v.to, v.as))};`);
      }
    }
    // the old file's code that still uses what moved imports it
    for (const v of moves) {
      if (v.from !== file || importedNames(file, text).includes(v.leaf) || !mentions(sf, v.leaf)) continue;
      added.push(`import { ${v.as === v.leaf ? v.leaf : `${v.as} as ${v.leaf}`} } from ${JSON.stringify(specifierFor(file, v.to, v.as))};`);
    }
    if (added.length) {
      const at = importsAt(file, text);
      edits.push({ start: at, end: at, text: (at ? "\n" : "") + added.join("\n") + (at ? "" : "\n") });
    }
    if (!edits.length) continue;
    if (!mirrored.has(file)) outside.set(file, text);
    fs.writeFileSync(file, applyEdits(text, edits));
  }
  return outside;
}

/**
 * Whether a file's code (not its imports) uses a name.
 */
export function mentions(sf: ReturnType<typeof ts.parse>, name: string): boolean {
  let found = false;
  const visit = (n: Parameters<typeof ts.isIdentifier>[0]) => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) found = true;
    else n.forEachChild(visit);
  };
  for (const st of sf.statements) if (!ts.isImportDeclaration(st)) visit(st);
  return found;
}

/**
 * The files under a mirrored directory that aren't code (Markdown, CSS, images): files of the codebase.
 */
export function assetFiles(dir: string, exclude: Set<string>): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (exclude.has(path.resolve(p)) || e.name.startsWith(".")) return [];
    if (e.isDirectory()) return ["node_modules", "dist", "build"].includes(e.name) ? [] : assetFiles(p, exclude);
    return isAsset(e.name) ? [p] : [];
  });
}

/**
 * A file's name in a mirror's codebase: its directory's namespace (as for code), and its own name.
 */
export function assetName(root: string, into: string, file: string): string {
  const dirs = path.relative(root, path.dirname(file)).split(path.sep).filter((d) => d && d !== "src").map(dirSegment);
  return joinName(into, ...dirs, fileLeaf(file));
}

/**
 * Formats a mirror keeps as files of the codebase: all but the project's configuration (JSON, YAML, TOML).
 */
export const isAsset = (file: string): boolean => {
  const format = fileFormat(file);
  return !!format && !["json", "yaml", "yml", "toml"].includes(format);
}
