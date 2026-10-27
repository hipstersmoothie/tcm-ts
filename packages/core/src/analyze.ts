import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { hashFromExportId, hashIR, serializeIR, type IR } from "./hash.ts";
import { extract, UcmError, type DefSite, type ExtractMode, type Piece } from "./extract.ts";
import { canonicalizeSite, type CanonContext, type Resolved, type SiteResult } from "./canonicalize.ts";
import { createProgram, fileDiagnostics, type Diagnostic } from "./program.ts";
import { depRef, type DefRecord, type Dep, type Span } from "./types.ts";

export interface AnalyzeHost {
  /** absolute path of `.ucm/cache`; relative imports into it address definitions by hash */
  cacheDir: string;
  /**
   * Resolve a dotted codebase name (from `#codebase/...` imports) to a definition hash; throw if unknown.
   * `meaning` picks between a type and a value sharing the name.
   */
  resolveName(name: string, meaning: "type" | "value"): string;
  ignoreDiagnostics?: number[];
  oldProgram?: ts.Program;
  /** the project's compiler options (see projectCompilerOptions); ucm's defaults otherwise */
  compilerOptions?: ts.CompilerOptions;
  /**
   * Lineage salt for a term or class declared as `name` in `file`. JavaScript gives every declaration its own
   * identity (`new Map()` twice is two maps; two identical classes fail each other's `instanceof`), so without
   * a salt identical code at two places would wrongly become one definition. Return undefined for none.
   */
  saltFor?(file: string, name: string, targetPath?: string): string | undefined;
}

export interface WatchRecord extends DefRecord {
  line: number;
  expression: string;
}

export interface Analysis {
  program: ts.Program;
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
  defs: DefRecord[];
  watches: WatchRecord[];
  /** from a `// ucm: namespace a.b` pragma */
  namespace?: string;
}

export interface ProjectDef extends DefRecord {
  /** absolute path of the file declaring it */
  file: string;
}

export interface ProjectAnalysis {
  program: ts.Program;
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
  defs: ProjectDef[];
  watches: (WatchRecord & { file: string })[];
}

const NAMESPACE_PRAGMA = /^\s*\/\/\s*ucm:\s*namespace\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/m;

/** Analyze one scratch file: bare expressions are watch expressions. */
export function analyzeFile(file: string, host: AnalyzeHost): Analysis {
  const a = analyzeProject([file], host, "scratch");
  return { ...a, namespace: scratchNamespace(a.program.getSourceFile(file)!.text) };
}

/** The target namespace of a scratch file, from a `// ucm: namespace a.b` pragma in its first lines. */
export function scratchNamespace(text: string): string | undefined {
  return NAMESPACE_PRAGMA.exec(text.split("\n").slice(0, 5).join("\n"))?.[1];
}

/** The lineage salt recorded in a stored definition's IR, if any. */
export function saltOf(ir: string): string | undefined {
  const head = (JSON.parse(ir) as IR[])[2];
  return Array.isArray(head) && head[0] === "Salt" ? (head[1] as string) : undefined;
}

/**
 * Analyze files together, as one dependency graph: references between them (including through re-export
 * barrels and workspace packages) become hash references, and import cycles become hash cycles.
 */
export function analyzeProject(files: string[], host: AnalyzeHost, mode: ExtractMode = "import"): ProjectAnalysis {
  const program = createProgram(files, host.oldProgram, host.compilerOptions);
  const sfs = files.map((f) => {
    const sf = program.getSourceFile(f);
    if (!sf) throw new Error(`cannot read ${f}`);
    return sf;
  });
  const base = { program, defs: [], watches: [], warnings: [] as string[] };

  const diagnostics = sfs.flatMap((sf, i) => fileDiagnostics(program, sf, host.ignoreDiagnostics, i === 0));
  const errors: string[] = [];
  if (diagnostics.length) {
    // structural problems (enums, top-level let, ...) explain themselves better than the type errors they cause
    for (const sf of sfs) {
      try {
        extract(sf, mode);
      } catch (e) {
        if (!(e instanceof UcmError)) throw e;
        errors.push(e.message);
      }
    }
    return { ...base, diagnostics, errors };
  }
  const result = analyzeSources(sfs, program.getTypeChecker(), host, mode);
  if (result.errors.length) return { ...base, diagnostics: [], errors: result.errors, warnings: result.warnings };
  return { ...result, program, diagnostics: [] };
}

function findPackage(name: string, fromDir: string): { name: string; version: string } | undefined {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const pj = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(pj)) {
      const json = JSON.parse(fs.readFileSync(pj, "utf8")) as { name: string; version: string };
      return { name: json.name, version: json.version };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

function importClassifier(file: string, host: AnalyzeHost) {
  const cache = new Map<string, Resolved>();
  const ids = new Map<ts.Node, number>();
  return (d: ts.ImportSpecifier | ts.ImportClause | ts.NamespaceImport, meaning: "type" | "value"): Resolved => {
    if (!ids.has(d)) ids.set(d, ids.size);
    const key = `${ids.get(d)} ${meaning}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const decl = ts.isImportSpecifier(d) ? d.parent.parent.parent : ts.isImportClause(d) ? d.parent : d.parent.parent;
    const spec = (decl.moduleSpecifier as ts.StringLiteral).text;
    const exportName = ts.isImportSpecifier(d) ? (d.propertyName ?? d.name).text : ts.isImportClause(d) ? "default" : "*";
    let r: Resolved;
    if (spec === "#codebase" || spec.startsWith("#codebase/")) {
      if (exportName === "*" || exportName === "default") {
        throw new UcmError('import codebase definitions by name: `import { sort } from "#codebase/lib"`', d);
      }
      const ns = spec.slice("#codebase".length).replace(/^\//, "").replaceAll("/", ".");
      try {
        r = { kind: "hash", hash: host.resolveName(ns ? `${ns}.${exportName}` : exportName, meaning) };
      } catch (e) {
        throw new UcmError((e as Error).message, d);
      }
    } else if (spec.startsWith(".") || spec.startsWith("/")) {
      const abs = path.resolve(path.dirname(file), spec);
      const hash = hashFromExportId(exportName);
      if (path.dirname(abs) !== host.cacheDir || !hash) {
        throw new UcmError(`cannot import local file '${spec}': add it to the codebase and import it from '#codebase/...'`, d);
      }
      r = { kind: "hash", hash };
    } else if (isBuiltin(spec)) {
      r = { kind: "ext", ext: { module: spec.startsWith("node:") ? spec : `node:${spec}`, subpath: "", export: exportName } };
    } else {
      const parts = spec.split("/");
      const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      const subpath = parts.slice(pkgName.split("/").length).join("/");
      const pkg = findPackage(pkgName, path.dirname(file));
      if (!pkg) throw new UcmError(`cannot find package '${pkgName}' in node_modules`, d);
      r = { kind: "ext", ext: { module: `npm:${pkg.name}@${pkg.version}`, subpath, export: exportName } };
    }
    cache.set(key, r);
    return r;
  };
}

/** Tarjan's SCC. Components come out dependencies-first. */
function tarjan(n: number, succ: (v: number) => Iterable<number>): number[][] {
  let counter = 0;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const out: number[][] = [];
  const strong = (v: number) => {
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const w of succ(v)) {
      if (index[w] === -1) {
        strong(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
    }
    if (low[v] === index[v]) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort((a, b) => a - b));
    }
  };
  for (let v = 0; v < n; v++) if (index[v] === -1) strong(v);
  return out;
}

function substDefs(ir: IR, f: (def: number) => IR): IR {
  if (typeof ir === "string") return ir;
  if (ir[0] === "@def" && ir.length === 2) return f(Number(ir[1]));
  return ir.map((c) => substDefs(c, f));
}

function defRefsInOrder(ir: IR, out: number[] = []): number[] {
  if (typeof ir === "string") return out;
  if (ir[0] === "@def" && ir.length === 2) out.push(Number(ir[1]));
  else for (const c of ir) defRefsInOrder(c, out);
  return out;
}

function buildSource(pieces: Piece[], sf: ts.SourceFile) {
  let text = "";
  const ranges: { fileStart: number; fileEnd: number; outStart: number }[] = [];
  for (const p of pieces) {
    if ("text" in p) text += p.text;
    else {
      ranges.push({ fileStart: p.start, fileEnd: p.end, outStart: text.length });
      text += sf.text.slice(p.start, p.end);
    }
  }
  const map = (pos: number) => {
    for (const r of ranges) if (pos >= r.fileStart && pos <= r.fileEnd) return r.outStart + pos - r.fileStart;
    throw new Error(`position ${pos} outside definition source`);
  };
  return { text, map };
}

function signatureOf(site: DefSite, checker: ts.TypeChecker): string {
  if (site.kind === "type") return site.tag === "Interface" ? "interface" : "type";
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  if (site.isWatch) return checker.typeToString(checker.getTypeAtLocation(site.nodes[0]!), undefined, flags);
  const sym = checker.getSymbolAtLocation(site.nameNode!);
  if (!sym) return "?";
  return checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, site.nameNode!), undefined, flags);
}

function analyzeSources(sfs: ts.SourceFile[], checker: ts.TypeChecker, host: AnalyzeHost, mode: ExtractMode) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sites: DefSite[] = [];
  const watchSites: DefSite[] = [];
  for (const sf of sfs) {
    try {
      const x = extract(sf, mode, sites.length);
      sites.push(...x.defs);
      watchSites.push(...x.watches);
      warnings.push(...x.warnings);
    } catch (e) {
      if (!(e instanceof UcmError)) throw e;
      errors.push(e.message);
    }
  }
  const declToDef = new Map<ts.Node, number>();
  for (const s of sites) for (const d of s.declarations) declToDef.set(d, s.id);
  for (const s of sites) if (s.kind !== "type") s.salt = host.saltFor?.(s.sf.fileName, s.name, s.targetPath);
  const classifiers = new Map(sfs.map((sf) => [sf, importClassifier(sf.fileName, host)]));
  const ctx: CanonContext = {
    checker,
    declToDef,
    projectFiles: new Set(sfs),
    classifyImport: (d, meaning) => classifiers.get(d.getSourceFile())!(d, meaning),
    kindOf: (def) => sites[def]!.kind,
    warn: (message, node) => warnings.push(new UcmError(message, node).message),
  };

  // collect every problem in one pass, so importing a project reports all of them at once
  const results = sites.map((s) => {
    try {
      return canonicalizeSite(s, ctx);
    } catch (e) {
      if (!(e instanceof UcmError)) throw e;
      errors.push(e.message);
      return undefined;
    }
  });
  if (errors.length) return { defs: [], watches: [], warnings, errors };
  const ok = results as SiteResult[];
  // bindings of one destructuring statement must share a component (the statement runs once)
  const groups = new Map<string, DefSite[]>();
  for (const s of sites) if (s.group !== undefined) groups.set(`${s.sf.fileName} ${s.group}`, [...(groups.get(`${s.sf.fileName} ${s.group}`) ?? []), s]);
  for (const members of groups.values()) for (const a of members) for (const b of members) if (a !== b) ok[a.id]!.edges.set(b.id, true);
  const sccs = tarjan(sites.length, (v) => ok[v]!.edges.keys());

  const hashOf = new Map<number, string>();
  const placed = new Map<number, { componentHash: string; index: number; size: number; ir: IR }>();
  for (const comp of sccs) {
    const inComp = new Set(comp);
    const subst = (ir: IR, cyc: (d: number) => IR) => substDefs(ir, (d) => (inComp.has(d) ? cyc(d) : ["Ref", hashOf.get(d)!]));
    let order = comp;
    if (comp.length > 1) {
      // Unison-style cycle hashing: order members by a hash that ignores intra-cycle references,
      // refine ties by what they reference, and fall back to source order for truly symmetric cycles.
      const pre = new Map(comp.map((id) => [id, hashIR(subst(ok[id]!.ir, () => ["Cyc", "?"]))]));
      const refined = new Map(
        comp.map((id) => [id, hashIR([pre.get(id)!, ...defRefsInOrder(ok[id]!.ir).filter((d) => inComp.has(d)).map((d) => pre.get(d)!)])]),
      );
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      order = [...comp].sort((a, b) => cmp(pre.get(a)!, pre.get(b)!) || cmp(refined.get(a)!, refined.get(b)!) || a - b);
    }
    const index = new Map(order.map((id, i) => [id, i]));
    const irs = order.map((id) => subst(ok[id]!.ir, (d) => ["Cyc", String(index.get(d))]));
    const componentHash = hashIR(["Component", ...irs]);
    order.forEach((id, i) => {
      hashOf.set(id, order.length === 1 ? componentHash : hashIR(["Elem", componentHash, String(i)]));
      placed.set(id, { componentHash, index: i, size: order.length, ir: irs[i]! });
    });
  }

  const toRecord = (site: DefSite, r: SiteResult, hash: string, p: { componentHash: string; index: number; size: number; ir: IR }): ProjectDef => {
    const src = buildSource(site.pieces, site.sf);
    const spans: Span[] = r.spans.map((s) => {
      const span: Span = { start: src.map(s.start), end: src.map(s.end), pos: s.pos };
      if ("def" in s.target) span.hash = hashOf.get(s.target.def)!;
      else if ("hash" in s.target) span.hash = s.target.hash;
      else span.ext = s.target.ext;
      if (s.shorthand) span.shorthand = s.shorthand;
      return span;
    });
    const deps = new Map<string, Dep>();
    r.spans.forEach((raw, i) => {
      const span = spans[i]!;
      if (span.hash === hash) return;
      const ref = depRef(span);
      const key = `${ref} ${span.pos}`;
      const prev = deps.get(key);
      deps.set(key, { ref, pos: span.pos, strict: (prev?.strict ?? false) || raw.strict });
    });
    return {
      hash,
      kind: site.kind,
      componentHash: p.componentHash,
      componentIndex: p.index,
      componentSize: p.size,
      ir: serializeIR(p.ir),
      sourceText: src.text,
      spans,
      reservedNames: [...r.reserved].sort(),
      initKind: site.initKind,
      nameHint: site.name,
      nominal: site.nominal,
      targetPath: site.targetPath,
      deps: [...deps.values()],
      signature: signatureOf(site, checker),
      doc: site.doc,
      file: site.sf.fileName,
    };
  };

  const defs = sites.map((s) => toRecord(s, ok[s.id]!, hashOf.get(s.id)!, placed.get(s.id)!));

  const watches = watchSites.map((s) => {
    const r = canonicalizeSite(s, ctx);
    const ir = substDefs(r.ir, (d) => ["Ref", hashOf.get(d)!]);
    const componentHash = hashIR(["Component", ir]);
    const rec = toRecord(s, r, componentHash, { componentHash, index: 0, size: 1, ir });
    const expr = s.nodes[0]!;
    return { ...rec, line: s.sf.getLineAndCharacterOfPosition(expr.getStart(s.sf)).line + 1, expression: expr.getText(s.sf) };
  });

  return { defs, watches, warnings, errors };
}
