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

/** Record that `into` mirrors `dir`: each file's namespace, content and definitions as they are now. */
export function linkMirror(cb: Codebase, dir: string, into: string, tests: boolean, exclude: string[]) {
  const root = path.resolve(dir);
  const files: Record<string, MirrorFile> = {};
  for (const f of sourceFiles(root, new Set(exclude.map((e) => path.resolve(root, e))), tests)) {
    const ns = joinName(into, namespaceForFile(root, f));
    const text = fs.readFileSync(f, "utf8");
    // what the file declares (the codebase may have more, made while write-back waited: written at the next sync)
    const inCodebase = namesIn(cb, ns);
    const names: Record<string, string> = {};
    for (const leaf of declarations(f, text).keys()) if (inCodebase[leaf]) names[leaf] = inCodebase[leaf];
    files[path.relative(root, f)] = { ns, sha: sha(text), names };
  }
  saveMirror(cb, { dir: root, into, tests, exclude, log: cb.store.logHead(), files });
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

function declarations(file: string, text: string): Map<string, Decl> {
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
  /** a module (codebase file or package entry) → the namespace prefix it's reached through, `ts.` */
  private prefix = new Map<string, string>();
  readonly imports: string[] = [];
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
    if (known) return known;
    if (s.hash) {
      const t = this.fileOf(s.hash);
      if (!t) throw new Error(`refers to #${s.hash.slice(0, 8)}, which isn't in the mirror`);
      if (t.ns === this.ns) return this.remember(key, t.leaf);
      const pre = this.prefix.get(t.file);
      if (pre) return this.remember(key, pre + t.leaf);
      const local = this.local(t.leaf);
      const rel = path.relative(path.dirname(this.file), t.file).split(path.sep).join("/");
      const kind = this.cb.store.getDef(s.hash)?.kind === "type" ? "type " : "";
      this.imports.push(`import ${kind}{ ${local === t.leaf ? local : `${t.leaf} as ${local}`} } from "${rel.startsWith(".") ? rel : `./${rel}`}";`);
      return this.remember(key, local);
    }
    const ext = s.ext!;
    const pre = this.prefix.get(`${ext.module}|${ext.subpath}`);
    if (pre && ext.export !== "default" && ext.export !== "*") return this.remember(key, pre + ext.export);
    const wanted = /^[A-Za-z_$][\w$]*$/.test(written) ? written : ext.export === "default" || ext.export === "*" ? "imported" : ext.export;
    const local = this.local(wanted);
    const type = s.pos === "type" ? "type " : "";
    const spec = JSON.stringify(specifierOf(ext));
    this.imports.push(
      ext.export === "default" ? `import ${type}${local} from ${spec};`
      : ext.export === "*" ? `import ${type}* as ${local} from ${spec};`
      : `import ${type}{ ${local === ext.export ? local : `${ext.export} as ${local}`} } from ${spec};`,
    );
    return this.remember(key, local);
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
  for (const e of cb.store.history(Number.MAX_SAFE_INTEGER, log)) {
    if (e.op === "update" && e.newHash && (e.command.endsWith("(propagated)") || e.command.startsWith("upgrade "))) out.add(e.newHash);
  }
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
    console.log(yellow(`mirror: ${handEdited.map(([rel]) => rel).slice(0, 3).join(", ")}${handEdited.length > 3 ? ", …" : ""} changed since tcm last saw ${handEdited.length > 1 ? "them" : "it"}; import ${path.relative(process.cwd(), m.dir) || "."} with \`tcm import ${path.relative(process.cwd(), m.dir) || "."} --into ${m.into} --update\` to write the codebase's changes back`));
    return false;
  }
  const untouched = untextual(cb, m.log);
  const byNs = new Map(Object.entries(m.files).map(([rel, f]) => [f.ns, rel]));
  const now = new Map<string, Record<string, string>>();
  for (const f of Object.values(m.files)) now.set(f.ns, namesIn(cb, f.ns));
  // where each definition of the mirror lives now, for references to it
  const home = new Map<string, { file: string; ns: string; leaf: string }>();
  for (const [ns, names] of now) for (const [leaf, h] of Object.entries(names)) home.set(h, { file: abs(byNs.get(ns)!), ns, leaf });
  const before = new Map(Object.entries(m.files).map(([rel, f]) => [rel, fs.readFileSync(abs(rel), "utf8")]));
  const renames: { rel: string; from: string; to: string }[] = [];
  const problems: string[] = [];

  for (const [rel, f] of Object.entries(m.files)) {
    const text = before.get(rel)!;
    const cur = now.get(f.ns)!;
    const decls = declarations(abs(rel), text);
    const curByHash = new Map(Object.entries(cur).map(([l, h]) => [h, l]));
    const edits: Edit[] = [];
    const existing = Object.values(f.names).map((h) => cb.store.getDef(h)).filter((d): d is DefRecord => !!d);
    const spelling = new Spelling(cb, abs(rel), f.ns, existing, (h) => home.get(h), [...decls.keys(), ...Object.keys(cur), ...importedNames(abs(rel), text)]);
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
      try {
        const code = codeFor(rec, leaf, spelling, true);
        added += `\n${rec.doc ? docComment(rec.doc) : ""}${terminated(code, /^(export )?(const|let|var|type) /.test(code))}\n`;
      } catch (e) {
        problems.push(`${joinName(f.ns, leaf)}: ${(e as Error).message}`);
      }
    }
    if (added) edits.push({ start: text.length, end: text.length, text: (text.endsWith("\n") ? "" : "\n") + added });
    if (spelling.imports.length) {
      const at = importsAt(abs(rel), text);
      edits.push({ start: at, end: at, text: (at ? "\n" : "") + spelling.imports.join("\n") + (at ? "" : "\n") });
    }
    if (edits.length) fs.writeFileSync(abs(rel), applyEdits(text, edits));
  }
  // definitions in a namespace no file is for yet
  for (const n of cb.store.names()) {
    if (!n.path.startsWith(m.into ? `${m.into}.` : "")) continue;
    const ns = n.path.slice(0, n.path.lastIndexOf("."));
    if (!byNs.has(ns) && ![...byNs.keys()].some((k) => k.startsWith(`${ns}.`))) problems.push(`${n.path} is in ${ns}, which no file in the mirror is for; create its file, then \`tcm import --update\``);
  }

  if (renames.length && !problems.length) {
    try {
      renameEverywhere(cb, m, renames);
    } catch (e) {
      problems.push(`renaming: ${(e as Error).message}`);
    }
  }

  const restore = () => {
    for (const [rel, text] of before) fs.writeFileSync(abs(rel), text);
  };
  if (!problems.length) {
    // the files must hash to what the codebase holds; a renamed function or class doesn't until the codebase takes
    // the renamed code
    const mismatch = checkMirror(cb, m);
    if (mismatch.length && renames.length && cb.adoptMirror) {
      console.log(dim(`mirror: ${renames.map((r) => `${r.from} → ${r.to}`).join(", ")} renamed in the code too; importing it`));
      if (cb.adoptMirror(m) && !checkMirror(cb, loadMirror(cb) ?? m).length) return true;
      problems.push("importing the renamed code didn't bring the files and the codebase together");
    } else if (mismatch.length) problems.push(...mismatch);
  }
  if (problems.length) {
    restore();
    console.log(red(`mirror: couldn't write the codebase's changes to ${path.relative(process.cwd(), m.dir) || "."}; the files are as they were`));
    for (const p of problems.slice(0, 10)) console.log(red(`  ${p}`));
    return false;
  }
  const changed = [...before].filter(([rel, text]) => fs.readFileSync(abs(rel), "utf8") !== text).map(([rel]) => rel);
  if (changed.length) console.log(dim(`mirror: wrote ${changed.join(", ")}`));
  for (const [rel, f] of Object.entries(m.files)) m.files[rel] = { ...f, sha: sha(fs.readFileSync(abs(rel), "utf8")), names: now.get(f.ns)! };
  m.log = cb.store.logHead();
  saveMirror(cb, m);
  return true;
}

/** Rename definitions at every reference in the mirror's files, as an editor's rename would. */
function renameEverywhere(cb: Codebase, m: Mirror, renames: { rel: string; from: string; to: string }[]) {
  const files = Object.keys(m.files).map((rel) => path.join(m.dir, rel));
  const { program, service } = createProgram(files, cb.compilerOptions(m.dir, "import"));
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
  for (const [file, list] of edits) fs.writeFileSync(file, applyEdits(fs.readFileSync(file, "utf8"), list));
}

function findDeclarationName(sf: ts.SourceFile, name: string): ts.Identifier | undefined {
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name?.text === name) return st.name;
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.name;
  }
  return undefined;
}

/** What doesn't match between the mirror's files and the codebase, re-analyzing the files as `import` does. */
export function checkMirror(cb: Codebase, m: Mirror): string[] {
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
  for (const f of Object.values(m.files)) for (const leaf of Object.keys(namesIn(cb, f.ns))) {
    if (!seen.has(joinName(f.ns, leaf))) out.push(`${joinName(f.ns, leaf)} is in the codebase but not in the files`);
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
 * Make a mirror's recorded releases again, in a codebase that doesn't have them: for each, in order, its commit's
 * files are imported (`importAt`) and the release is put at the history entry that makes. The files are taken
 * from git into a directory inside the repository, so packages resolve as they did, and workspace packages
 * (`@tcm/core`, say) are linked to their copies there rather than to today's.
 */
export function replayReleases(cb: Codebase, dir: string, importAt: (root: string) => boolean, namespaceOf: (pkg: string) => string | undefined): number {
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
      for (const pkgJson of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name, "package.json"))) {
        if (!fs.existsSync(pkgJson)) continue;
        const name = (JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { name?: string }).name;
        if (!name) continue;
        const link = path.join(at, "node_modules", name);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.dirname(pkgJson), link, "dir");
      }
      console.log(dim(`making ${r.package}@${r.version} again from git (${r.commit.slice(0, 8)})…`));
      if (!importAt(root)) throw new Error(`${r.package}@${r.version}'s files (commit ${r.commit.slice(0, 8)}) didn't import`);
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
