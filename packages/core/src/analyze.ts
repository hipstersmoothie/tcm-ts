import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { hashFromExportId, hashIR, serializeIR, type IR } from "./hash.ts";
import { extract, TcmError, type DefSite, type ExtractMode, type Piece } from "./extract.ts";
import { canonicalizeSite, type CanonContext, type Resolved, type SiteResult } from "./canonicalize.ts";
import { compareVersions, compatRange } from "./semver.ts";
import { checkProfile, compilerOptions, createProgram, fileDiagnostics, type Compile, type Diagnostic } from "./program.ts";
import { depRef, SERVER_API_MODULE, type DefRecord, type Dep, type DocRef, type ExtRef, type Span } from "./types.ts";
import { paramsSchema, typeSchema, type ParamsSchema, type TableSchema } from "./schema.ts";
import { createHash } from "node:crypto";
import { cacheRefOf, shapeBuilder, type TypeShape } from "./shape.ts";
import { docExamples, docTags, exampleNames } from "./docs.ts";

export interface AnalyzeHost {
  /** absolute path of `.tcm/cache`; relative imports into it address definitions by hash */
  cacheDir: string;
  /**
   * Resolve a dotted codebase name (from `#codebase/...` imports) to a definition hash; throw if unknown.
   * `meaning` picks between a type and a value sharing the name.
   */
  resolveName(name: string, meaning: "type" | "value"): string;
  ignoreDiagnostics?: number[];
  oldProgram?: ts.Program;
  /** builds the program instead of a fresh `createProgram` (the watcher's incremental compiler) */
  compile?: Compile;
  /** the project's compiler options (see projectCompilerOptions); tcm's defaults otherwise */
  compilerOptions?: ts.CompilerOptions;
  /**
   * Lineage salt for a term or class declared as `name` in `file`. JavaScript gives every declaration its own
   * identity (`new Map()` twice is two maps; two identical classes fail each other's `instanceof`), so without
   * a salt identical code at two places would wrongly become one definition. Return undefined for none.
   */
  saltFor?(file: string, name: string, targetPath?: string): string | undefined;
  /** diagnostics that don't count (beyond `ignoreDiagnostics`' codes) */
  skipDiagnostic?(d: ts.Diagnostic): boolean;
  /** where package `name` is for imports in `file`, when tcm provides it (see PackageResolver) */
  packageDir?(name: string, file: string): string | undefined;
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
  defs: ProjectDef[];
  watches: WatchRecord[];
  /** from a `// tcm: namespace a.b` pragma */
  namespace?: string;
  /** see ProjectAnalysis.packages */
  packages: Record<string, string>;
}

export interface ProjectDef extends DefRecord {
  /** absolute path of the file declaring it */
  file: string;
  /** where it is in that file (offsets): the whole declaration, and its name (for editors; not stored) */
  range: { start: number; end: number; nameStart?: number; nameEnd?: number };
}

export interface ProjectAnalysis {
  program: ts.Program;
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
  defs: ProjectDef[];
  watches: (WatchRecord & { file: string })[];
  /**
   * The exact version each pinned package range was checked against (`npm:ms@2` → `2.1.3`): definitions record
   * the range, the codebase's lock records versions.
   */
  packages: Record<string, string>;
}

// `// ucm:` is the spelling from before the rename to tcm
const NAMESPACE_PRAGMA = /^\s*\/\/\s*[tu]cm:\s*namespace\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/m;

/** Analyze one scratch file: bare expressions are watch expressions. */
export function analyzeFile(file: string, host: AnalyzeHost): Analysis {
  const a = analyzeProject([file], host, "scratch");
  return { ...a, namespace: scratchNamespace(a.program.getSourceFile(file)!.text) };
}

/** The target namespace of a scratch file, from a `// tcm: namespace a.b` pragma in its first lines. */
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
  observed = new Map();
  try {
    return { ...analyzeWith(files, host, mode), packages: Object.fromEntries(observed) };
  } finally {
    observed = undefined;
  }
}

/** The exact versions packages resolve to during the analysis running now, by pinned module. */
let observed: Map<string, string> | undefined;

function analyzeWith(files: string[], host: AnalyzeHost, mode: ExtractMode): Omit<ProjectAnalysis, "packages"> {
  const program = host.compile ? host.compile(files, host.compilerOptions ?? compilerOptions()) : createProgram(files, host.oldProgram, host.compilerOptions);
  const sfs = files.map((f) => {
    const sf = program.getSourceFile(f);
    if (!sf) throw new Error(`cannot read ${f}`);
    return sf;
  });
  const base = { program, defs: [], watches: [], warnings: [] as string[] };

  const diagnostics = sfs.flatMap((sf, i) => fileDiagnostics(program, sf, host.ignoreDiagnostics, i === 0, host.skipDiagnostic));
  const errors: string[] = [];
  if (diagnostics.length) {
    // structural problems (enums, top-level let, ...) explain themselves better than the type errors they cause
    for (const sf of sfs) {
      try {
        extract(sf, mode);
      } catch (e) {
        if (!(e instanceof TcmError)) throw e;
        errors.push(e.message);
      }
    }
    return { ...base, diagnostics, errors };
  }
  const result = analyzeSources(sfs, program.getTypeChecker(), host, mode, program.getCompilerOptions());
  if (result.errors.length) return { ...base, diagnostics: [], errors: result.errors, warnings: result.warnings };
  // each definition remembers the options it typechecked under, so later re-checks use the same ones
  const checked = checkProfile(program.getCompilerOptions());
  for (const d of [...result.defs, ...result.watches]) d.checked = checked;
  return { ...result, program, diagnostics: [] };
}

function readPackage(dir: string): { name: string; version: string } | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name: string; version: string };
    return { name: json.name, version: json.version };
  } catch {
    return undefined;
  }
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
    if (spec === SERVER_API || isServerApiFile(spec, file, host)) {
      r = { kind: "ext", ext: { module: SERVER_API_MODULE, subpath: "", export: exportName } };
    } else if (spec === "#codebase" || spec.startsWith("#codebase/")) {
      if (exportName === "*" || exportName === "default") {
        throw new TcmError('import codebase definitions by name: `import { sort } from "#codebase/lib"`', d);
      }
      const ns = spec.slice("#codebase".length).replace(/^\//, "").replaceAll("/", ".");
      try {
        r = { kind: "hash", hash: host.resolveName(ns ? `${ns}.${exportName}` : exportName, meaning) };
      } catch (e) {
        throw new TcmError((e as Error).message, d);
      }
    } else if (spec.startsWith(".") || spec.startsWith("/")) {
      const abs = path.resolve(path.dirname(file), spec);
      const hash = hashFromExportId(exportName);
      if (path.dirname(abs) !== host.cacheDir || !hash) {
        throw new TcmError(`cannot import local file '${spec}': add it to the codebase and import it from '#codebase/...'`, d);
      }
      r = { kind: "hash", hash };
    } else {
      r = { kind: "ext", ext: externalModule(spec, file, d, exportName, host) };
    }
    cache.set(key, r);
    return r;
  };
}

/** tcm's own server API (request context, cookies, sessions): unversioned, like a Node builtin. */
const SERVER_API = "#tcm/server";

/** The generated runtime of `#tcm/server`, as cache modules and re-analyzed definitions import it. */
function isServerApiFile(spec: string, file: string, host: AnalyzeHost): boolean {
  return /^\.\.?\//.test(spec) && path.resolve(path.dirname(file), spec) === path.join(host.cacheDir, "tcm-server.js");
}

/** A Node builtin or an npm package (version pinned from node_modules), as imported from `file`. */
function externalModule(spec: string, file: string, at: ts.Node, exportName: string, host?: AnalyzeHost): ExtRef {
  if (spec === SERVER_API) return { module: SERVER_API_MODULE, subpath: "", export: exportName };
  if (isBuiltin(spec)) return { module: spec.startsWith("node:") ? spec : `node:${spec}`, subpath: "", export: exportName };
  const parts = spec.split("/");
  const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const subpath = parts.slice(pkgName.split("/").length).join("/");
  // a package tcm provides (not installed in the project) is where the file's imports resolved it
  const provided = host?.packageDir?.(pkgName, file);
  const pkg = provided ? readPackage(provided) : findPackage(pkgName, path.dirname(file));
  if (!pkg) throw new TcmError(`cannot find package '${pkgName}' in node_modules`, at);
  // the hash records the range semver calls compatible; the codebase's lock picks the version within it
  const module = `npm:${pkg.name}@${compatRange(pkg.version)}`;
  const seen = observed?.get(module);
  if (!seen || compareVersions(pkg.version, seen) > 0) observed?.set(module, pkg.version);
  return { module, subpath, export: exportName };
}

/** `import("pkg")` loads a package lazily; it's as content-addressable as a static import of the same package. */
function dynamicImportClassifier(file: string, host?: AnalyzeHost) {
  return (spec: string, at: ts.Node): ExtRef => {
    if (spec === "#codebase" || spec.startsWith("#codebase/") || spec.startsWith(".") || spec.startsWith("/")) {
      throw new TcmError("dynamic `import()` of codebase or local modules isn't supported; import definitions statically", at);
    }
    return externalModule(spec, file, at, "*", host);
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

function paramsOf(site: DefSite, checker: ts.TypeChecker): ParamsSchema | undefined {
  if (site.kind !== "term" || site.isWatch || !site.nameNode) return undefined;
  const sym = checker.getSymbolAtLocation(site.nameNode);
  return sym ? paramsSchema(checker, checker.getTypeOfSymbolAtLocation(sym, site.nameNode)) : undefined;
}

/**
 * `const users = table<User>("users")` with `table` from #tcm/server: the row type is erased at runtime, but it's
 * known here, so its schema (and that schema's hash) travel with the definition.
 */
function tableOf(site: DefSite, checker: ts.TypeChecker): TableSchema | undefined {
  if (site.tag !== "Const") return undefined;
  let init = (site.nodes[0] as ts.VariableDeclaration).initializer;
  while (init && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
  if (!init || !ts.isCallExpression(init) || !init.typeArguments?.length || !ts.isIdentifier(init.expression)) return undefined;
  const d = checker.getSymbolAtLocation(init.expression)?.declarations?.[0];
  if (!d || !ts.isImportSpecifier(d) || (d.propertyName ?? d.name).text !== "table") return undefined;
  const spec = (d.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text;
  if (spec !== "#tcm/server" && !spec.endsWith("/tcm-server.js")) return undefined;
  const { s, defs } = typeSchema(checker, checker.getTypeFromTypeNode(init.typeArguments[0]!));
  const arg = init.arguments[0];
  const hash = createHash("sha256").update(JSON.stringify({ s, defs })).digest("hex").slice(0, 32);
  return { ...(arg && ts.isStringLiteralLike(arg) ? { name: arg.text } : {}), ...(init.arguments.length > 1 ? { hasOptions: true } : {}), hash, s, defs, ...tableOptions(init.arguments[1], checker) };
}

/** What a table's options literal says about migration steps, constraints and renames. */
function tableOptions(opts: ts.Expression | undefined, checker: ts.TypeChecker): Partial<TableSchema> {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return {};
  const out: Partial<TableSchema> = {};
  const strings = (e: ts.Expression) => (ts.isArrayLiteralExpression(e) ? e.elements.filter(ts.isStringLiteralLike).map((x) => x.text) : []);
  for (const p of opts.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
    const v = p.initializer;
    if (p.name.text === "migrate") {
      // each step's parameter type: what a row must look like for that step to take it
      const fns = ts.isArrayLiteralExpression(v) ? [...v.elements] : [v];
      out.steps = fns.map((f) => {
        const param = checker.getTypeAtLocation(f).getCallSignatures()[0]?.parameters[0];
        return param ? typeSchema(checker, checker.getTypeOfSymbolAtLocation(param, f)) : { s: { t: "any" }, defs: [] };
      });
    } else if (p.name.text === "unique" || p.name.text === "index") out[p.name.text] = strings(v);
    else if (p.name.text === "renamedFrom" && ts.isStringLiteralLike(v)) out.renamedFrom = v.text;
  }
  return out;
}

function signatureOf(site: DefSite, checker: ts.TypeChecker): string {
  if (site.kind === "type") return site.tag === "Interface" ? "interface" : "type";
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  if (site.isWatch) return checker.typeToString(checker.getTypeAtLocation(site.nodes[0]!), undefined, flags);
  const sym = checker.getSymbolAtLocation(site.nameNode!);
  if (!sym) return "?";
  return checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, site.nameNode!), undefined, flags);
}

function analyzeSources(sfs: ts.SourceFile[], checker: ts.TypeChecker, host: AnalyzeHost, mode: ExtractMode, options: ts.CompilerOptions) {
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
      if (!(e instanceof TcmError)) throw e;
      errors.push(e.message);
    }
  }
  const declToDef = new Map<ts.Node, number>();
  for (const s of sites) for (const d of s.declarations) declToDef.set(d, s.id);
  // an ambient `declare const x: unique symbol` is a type-only definition, but each one is a distinct symbol
  for (const s of sites) if (s.kind !== "type" || s.tag === "Declare") s.salt = host.saltFor?.(s.sf.fileName, s.name, s.targetPath);
  const classifiers = new Map(sfs.map((sf) => [sf, importClassifier(sf.fileName, host)]));
  const ctx: CanonContext = {
    checker,
    declToDef,
    projectFiles: new Set(sfs),
    allowTransformed: mode === "import",
    classifyImport: (d, meaning) => classifiers.get(d.getSourceFile())!(d, meaning),
    classifyDynamicImport: (spec, at) => dynamicImportClassifier(at.getSourceFile().fileName, host)(spec, at),
    jsxRuntime: (at) => {
      const sf = at.getSourceFile();
      // generated modules name their (aliased) runtime in a pragma; scratch files use the project's setting
      const source = /@jsxImportSource\s+(\S+)/.exec(sf.text.slice(0, 2000))?.[1] ?? options.jsxImportSource ?? "react";
      return externalModule(`${source}/jsx-runtime`, sf.fileName, at, "*", host);
    },
    kindOf: (def) => sites[def]!.kind,
    isLet: (def) => sites[def]!.tag === "Let",
    warn: (message, node) => warnings.push(new TcmError(message, node).message),
  };

  // collect every problem in one pass, so importing a project reports all of them at once
  const results = sites.map((s) => {
    try {
      return canonicalizeSite(s, ctx);
    } catch (e) {
      if (!(e instanceof TcmError)) throw e;
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
  // a top-level `let` and everything assigning to it are one module (one component)
  for (const s of sites) for (const l of ok[s.id]!.writes) if (!ok[l]!.edges.has(s.id)) ok[l]!.edges.set(s.id, false);
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
      if (s.literal) span.literal = true;
      if (s.element) span.element = true;
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
    // JSX compiles to calls into its runtime: a dependency on that package, as an import of it would be
    if (r.jsx) deps.set(`${r.jsx}/jsx-runtime#*`, { ref: `${r.jsx}/jsx-runtime#*`, pos: "value", strict: false });
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
      globalNames: [...r.globals].sort(),
      initKind: site.initKind,
      nameHint: site.name,
      nominal: site.nominal,
      targetPath: site.targetPath,
      deps: [...deps.values()],
      signature: signatureOf(site, checker),
      params: paramsOf(site, checker),
      table: tableOf(site, checker),
      ...(r.transform ? { transform: true } : {}),
      ...(r.jsx ? { jsx: r.jsx } : {}),
      doc: site.doc,
      file: site.sf.fileName,
      range: {
        start: site.nodes[0]!.getStart(site.sf),
        end: site.nodes.at(-1)!.end,
        ...(site.nameNode ? { nameStart: site.nameNode.getStart(site.sf), nameEnd: site.nameNode.end } : {}),
      },
    };
  };

  // a type a definition mentions is a codebase type if it's one of these definitions, or a stored one
  const cacheRef = cacheRefOf(checker);
  const shapes = shapeBuilder(checker, (sym) => {
    const d = sym.declarations?.[0];
    const id = d && declToDef.get(d);
    return id !== undefined ? hashOf.get(id) : cacheRef(sym);
  });
  const shapeOf = (site: DefSite): TypeShape | undefined => {
    if (site.kind !== "term" || site.isWatch || !site.nameNode) return undefined;
    const sym = checker.getSymbolAtLocation(site.nameNode);
    return sym ? shapes.typeShape(checker.getTypeOfSymbolAtLocation(sym, site.nameNode)) : undefined;
  };
  // a doc's links, embeds and examples name definitions: resolve them now, by hash, so the doc follows renames
  // and updates instead of going stale (Unison's docs are code for the same reason)
  const symbolHash = (sym: ts.Symbol): string | undefined => {
    const s = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const d = s.declarations?.[0];
    const id = d && declToDef.get(d);
    return id !== undefined ? hashOf.get(id) : cacheRef(s);
  };
  const docRefsOf = (site: DefSite): DocRef[] | undefined => {
    if (!site.doc || site.isWatch) return undefined;
    const tags = docTags(site.doc);
    const examples = docExamples(site.doc);
    if (!tags.length && !examples.length) return undefined;
    const scope = new Map<string, ts.Symbol>();
    const flags = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias | ts.SymbolFlags.Namespace;
    for (const s of checker.getSymbolsInScope(site.nodes[0]!, flags)) if (!scope.has(s.name)) scope.set(s.name, s);
    const resolve = (name: string, type: boolean): string | undefined => {
      const sym = name.includes(".") ? undefined : scope.get(name);
      const h = sym && symbolHash(sym);
      if (h) return h;
      for (const meaning of type ? (["type", "value"] as const) : (["value", "type"] as const)) {
        try {
          return host.resolveName(name, meaning);
        } catch {
          // not a codebase path either
        }
      }
      // `lib.square` for a definition being added alongside, which has no codebase path yet
      const last = name.slice(name.lastIndexOf(".") + 1);
      const sibling = name.includes(".") ? scope.get(last) : undefined;
      return sibling ? symbolHash(sibling) : undefined;
    };
    const refs: DocRef[] = [];
    for (const t of tags) {
      const h = resolve(t.name, false);
      if (h) refs.push({ start: t.nameStart, end: t.nameEnd, hash: h });
      else warnings.push(`the doc of ${site.name} refers to '${t.name}', which isn't in scope or in the codebase (${site.sf.fileName})`);
    }
    for (const ex of examples) {
      for (const n of exampleNames(ex.code)) {
        // names an example uses that are definitions, or imports from outside the codebase; globals (Math,
        // console) and the like stay as written
        const sym = scope.get(n.name);
        const h = sym ? symbolHash(sym) : undefined;
        const at = { start: ex.start + n.start, end: ex.start + n.end };
        if (h) refs.push({ ...at, hash: h });
        else {
          const decl = sym?.flags && sym.flags & ts.SymbolFlags.Alias ? sym.declarations?.[0] : undefined;
          if (decl && (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl))) {
            const r = ctx.classifyImport(decl, n.type ? "type" : "value");
            if (r.kind === "ext") refs.push({ ...at, ext: r.ext });
          }
        }
      }
    }
    return refs.sort((a, b) => a.start - b.start);
  };
  const defs = sites.map((s) => ({ ...toRecord(s, ok[s.id]!, hashOf.get(s.id)!, placed.get(s.id)!), shape: shapeOf(s), docRefs: docRefsOf(s) }));

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
