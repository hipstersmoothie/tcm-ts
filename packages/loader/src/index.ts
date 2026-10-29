import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ensureExternals, npmAlias } from "./packages.ts";
import { inlineSourceMap, lineSourceMap, type LineMapping } from "./sourcemap.ts";
import { exportId, extRefString, isConflicted, SERVER_API_MODULE, statementStarts, type DefRecord, type ExtRef } from "@tcm/core";

export interface Layout {
  root: string;
  tcmDir: string;
  cacheDir: string;
  shimDir: string;
  dbFile: string;
}

export function layout(root: string): Layout {
  const tcmDir = path.join(root, ".tcm");
  return { root, tcmDir, cacheDir: path.join(tcmDir, "cache"), shimDir: path.join(tcmDir, "codebase"), dbFile: path.join(tcmDir, "codebase.sqlite") };
}

/** Where definitions come from: the store, possibly overlaid with not-yet-added scratch definitions. */
export interface DefSource {
  get(hash: string): DefRecord | undefined;
  members(componentHash: string): DefRecord[];
  /** current full name on the branch, if any */
  nameOf(hash: string): string | undefined;
  /**
   * Where a definition reads as you'd look at it: a file and the (0-based) line its declaration starts on there.
   * Generated modules carry a source map to it, so stack traces and debuggers show that file.
   */
  viewOf?(hash: string): { file: string; line: number; inserts?: number[] } | undefined;
}

/**
 * - `cache`: a component module in `.tcm/cache`, imports by hash, exported as `h_<hash>`
 * - `internal`: like cache but without exports; used to re-typecheck definitions after an update
 * - `scratch`: editable source for the project root, imports through `#codebase/...`
 */
export type Style = "cache" | "internal" | "scratch";

export interface RenderOptions {
  style: Style;
  /** rewrite references (used by update propagation) */
  remap?: (hash: string) => string;
  /** re-pin packages: the module each `npm:` import should use instead (`npm:react@18` → `npm:react@19`) */
  remapPackage?: (module: string) => string;
  /** leave out import lines (for showing a definition's body, e.g. in diffs) */
  omitImports?: boolean;
  /** names to render with instead of the current branch's (a diff shows each side with its own names) */
  nameOf?: (hash: string) => string | undefined;
  /** scratch style: a comment line to put above a member, given the identifier it is declared as */
  annotate?: (hash: string, declaredAs: string) => string | undefined;
  /** put `export` on each member's declaration (for type/value pair modules) */
  exportDeclarations?: boolean;
  /** put documentation above members (scratch style always does; `tcm pack` wants it in declarations) */
  docs?: boolean;
  /** keep every identifier as it is written in the stored source (migration re-derives text-identical code) */
  preserveText?: boolean;
}

export interface Rendered {
  text: string;
  /** member hash → the identifier it is declared as */
  memberNames: Map<string, string>;
  /** where each reference to a codebase definition is in `text` (offsets of the name), for editors */
  refs: { start: number; end: number; hash: string; from: string }[];
  /** where each member's declaration starts in `text` */
  starts: Map<string, number>;
  /** where `export ` was inserted in each member's body (offsets in the body, as stored) */
  inserts: Map<string, number[]>;
}

const lastSegment = (name: string) => name.slice(name.lastIndexOf(".") + 1);
const sanitize = (s: string) => (s.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1") || "x");
/** Valid binding names that would parse as something else where an imported name is spliced into a type. */
const TYPE_KEYWORDS = new Set(["infer", "keyof", "typeof", "unique", "readonly", "asserts", "is", "satisfies", "extends"]);

/**
 * A component's module: `.tsx` when it uses JSX (TypeScript only parses JSX there), `.ts` otherwise. Its first
 * JSX member's runtime is named in a pragma, so every compiler (tcm's module hook, Vite, the type checker)
 * compiles the elements to the pinned version.
 */
export function moduleFile(componentHash: string, src: Pick<DefSource, "members">): string {
  return `${componentHash}${src.members(componentHash).some((m) => m.jsx) ? ".tsx" : ".ts"}`;
}

function realPackage(module: string): string {
  return /^npm:(.+)@[^@]+$/.exec(module)![1]!;
}

function importLine(local: string, exported: string, from: string, typeOnly: boolean): string {
  const t = typeOnly ? "type " : "";
  if (exported === "default") return `import ${t}${local} from ${JSON.stringify(from)};`;
  if (exported === "*") return `import ${t}* as ${local} from ${JSON.stringify(from)};`;
  return `import ${t}{ ${exported === local ? local : `${exported} as ${local}`} } from ${JSON.stringify(from)};`;
}

/** Order component members so module-init-time references are already initialized. */
function initOrder(members: DefRecord[]): DefRecord[] {
  // an uninitialized `let` first: TypeScript reports reads in functions declared above it as unassigned
  const isLet = (m: DefRecord) => /^(?:\/\/[^\n]*\n)*let /.test(m.sourceText);
  const hoisted = members.filter((m) => m.initKind === "hoisted").sort((a, b) => Number(isLet(b)) - Number(isLet(a)));
  const strict = members.filter((m) => m.initKind === "strict");
  const out: DefRecord[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const byHash = new Map(strict.map((m) => [m.hash, m]));
  const visit = (m: DefRecord) => {
    if (done.has(m.hash) || visiting.has(m.hash)) return; // a strict cycle fails at runtime, exactly as in plain TS
    visiting.add(m.hash);
    for (const d of m.deps) {
      const dep = d.strict && d.ref.startsWith("#") ? byHash.get(d.ref.slice(1)) : undefined;
      if (dep) visit(dep);
    }
    visiting.delete(m.hash);
    done.add(m.hash);
    out.push(m);
  };
  strict.forEach(visit);
  return [...hoisted, ...out];
}

export function render(members: DefRecord[], src: DefSource, lay: Layout, opts: RenderOptions): Rendered {
  const remap = opts.remap ?? ((h: string) => h);
  const pin = opts.remapPackage ?? ((m: string) => m);
  const memberSet = new Set(members.map((m) => m.hash));
  const used = new Set<string>(members.flatMap((m) => m.reservedNames));
  const uniq = (base: string) => {
    let name = sanitize(base);
    for (let i = 1; used.has(name); i++) name = `${sanitize(base)}_${i}`;
    used.add(name);
    return name;
  };
  const nameOf = opts.nameOf ?? src.nameOf;
  const displayName = (hash: string) => {
    const n = nameOf(hash);
    return n ? lastSegment(n) : (src.get(hash)?.nameHint ?? "h");
  };

  const memberNames = new Map<string, string>();
  // Functions and classes keep the name they were hashed with, so `.name` agrees with the hash. That original name
  // is safe for the definition itself (its own locals coexisted with it in the original code); it only can't
  // shadow a global some member uses, or be captured by another member's local where that member refers to it.
  const allGlobals = new Set(members.flatMap((m) => m.globalNames ?? m.reservedNames));
  const taken = new Set<string>();
  for (const m of members) {
    const original = m.nominal || opts.preserveText;
    const name = sanitize(m.nameHint);
    // A reference written as exactly `name` in the original code can't be captured by a local of that name (it
    // wouldn't have resolved to this definition then); one written differently (an alias, a rename) could be.
    const captured = members.some(
      (a) =>
        a !== m &&
        a.reservedNames.includes(name) &&
        !(a.globalNames ?? a.reservedNames).includes(name) &&
        a.spans.some((s) => s.hash === m.hash && a.sourceText.slice(s.start, s.end) !== name),
    );
    if (original && m.globalNames && !allGlobals.has(name) && !taken.has(name) && !captured) {
      memberNames.set(m.hash, name);
      taken.add(name);
      used.add(name);
      continue;
    }
    const chosen = uniq(original ? m.nameHint : displayName(m.hash));
    memberNames.set(m.hash, chosen);
    taken.add(chosen);
  }

  interface Imp {
    local: string;
    hash?: string;
    ext?: ExtRef;
    value: boolean;
  }
  const imports = new Map<string, Imp>();
  const localFor = (m: DefRecord, span: DefRecord["spans"][number]): string => {
    if (span.hash && memberSet.has(span.hash)) return memberNames.get(span.hash)!;
    const target = span.hash ? remap(span.hash) : undefined;
    const key = target ? `#${target}` : extRefString(span.ext!);
    let imp = imports.get(key);
    if (!imp) {
      // codebase refs take their current name; externals keep the local name they were imported as
      const written = m.sourceText.slice(span.start, span.end);
      const base = target && !opts.preserveText ? displayName(target) : written;
      imp = { local: uniq(TYPE_KEYWORDS.has(base) ? `${base}_` : base), hash: target, ext: span.ext, value: false };
      imports.set(key, imp);
    }
    if (span.pos === "value") imp.value = true;
    return imp.local;
  };

  const bodies = new Map<string, string>();
  /** per member: each codebase reference's name, at its offset in the member's spliced body */
  const bodyRefs = new Map<string, { start: number; end: number; hash: string }[]>();
  for (const m of members) {
    let text = m.sourceText;
    const placed: { start: number; end: number; nameAt: number; local: string; hash?: string; growth: number }[] = [];
    for (const span of [...m.spans].sort((a, b) => b.start - a.start)) {
      if (span.literal && span.ext) {
        // `import("pkg")`: point at the pinned version (the real package name in editable scratch files)
        const e = span.ext;
        const spec =
          e.module === SERVER_API_MODULE
            ? opts.style === "scratch" ? "#tcm/server" : "./tcm-server.js"
            : e.module.startsWith("npm:") ? (opts.style === "scratch" ? realPackage(e.module) : npmAlias(pin(e.module))) + (e.subpath ? `/${e.subpath}` : "") : e.module;
        text = text.slice(0, span.start) + JSON.stringify(spec) + text.slice(span.end);
        continue;
      }
      const local = localFor(m, span);
      const replacement = span.shorthand && span.shorthand !== local ? `${span.shorthand}: ${local}` : local;
      text = text.slice(0, span.start) + replacement + text.slice(span.end);
      const hash = span.hash ? remap(span.hash) : undefined;
      placed.push({ start: span.start, end: span.end, nameAt: replacement.length - local.length, local, hash, growth: replacement.length - (span.end - span.start) });
    }
    bodies.set(m.hash, text);
    // spliced from the end, so a span moved by the growth of every span before it
    let shift = 0;
    const refs: { start: number; end: number; hash: string }[] = [];
    for (const p of placed.reverse()) {
      if (p.hash) refs.push({ start: p.start + shift + p.nameAt, end: p.start + shift + p.nameAt + p.local.length, hash: p.hash });
      shift += p.growth;
    }
    bodyRefs.set(m.hash, refs);
  }

  const lines: string[] = [];
  // the first line tells tcm's module hook to compile this module (Node's type stripping can't run it)
  const jsx = members.find((m) => m.jsx)?.jsx;
  if (opts.style === "cache" && members.some((m) => m.transform || m.jsx)) lines.push(TRANSFORM_MARK);
  if (opts.style === "cache") lines.push(`// generated by tcm — do not edit. component ${members[0]!.componentHash}`);
  if (jsx && opts.style !== "scratch" && jsx.startsWith("npm:")) lines.push(`/** @jsxImportSource ${npmAlias(pin(jsx))} */`);
  for (const imp of [...imports.values()].sort((a, b) => a.local.localeCompare(b.local))) {
    if (imp.hash) {
      const rec = src.get(imp.hash);
      if (!rec) throw new Error(`missing definition #${imp.hash}`);
      const typeOnly = rec.kind === "type" || !imp.value;
      const name = nameOf(imp.hash);
      if (opts.style === "scratch" && name) {
        const ns = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
        lines.push(importLine(imp.local, lastSegment(name), ns ? `#codebase/${ns.replaceAll(".", "/")}` : "#codebase", typeOnly));
      } else {
        const mod = moduleFile(rec.componentHash, src);
        const file = opts.style === "scratch" ? `./${path.relative(lay.root, lay.cacheDir).split(path.sep).join("/")}/${mod}` : `./${mod}`;
        lines.push(importLine(imp.local, exportId(imp.hash), file, typeOnly));
      }
    } else {
      const e = imp.ext!;
      let from = e.module;
      if (e.module.startsWith("npm:")) from = (opts.style === "scratch" ? realPackage(e.module) : npmAlias(pin(e.module))) + (e.subpath ? `/${e.subpath}` : "");
      // tcm's server API: generated into the cache, so every module in a process shares one instance
      if (e.module === SERVER_API_MODULE) from = opts.style === "scratch" ? "#tcm/server" : "./tcm-server.js";
      lines.push(importLine(imp.local, e.export, from, !imp.value));
    }
  }
  // the header comments stay: the module hook and JSX compilers read them
  if (opts.omitImports) lines.length = opts.style === "cache" ? lines.filter((l) => l.startsWith("//") || l.startsWith("/**")).length : 0;
  if (lines.length) lines.push("");

  const ordered = opts.style === "scratch" ? members : initOrder(members);
  const bodyAt = new Map<string, { line: number; inserts: number[] }>();
  // the bindings of one destructuring statement share its source: emit the statement once
  const emitted = new Set<string>();
  for (const m of ordered) {
    if (emitted.has(m.sourceText)) continue;
    emitted.add(m.sourceText);
    if ((opts.style === "scratch" || opts.docs) && m.doc) lines.push(`/**\n${m.doc.split("\n").map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */`);
    const note = opts.style === "scratch" ? opts.annotate?.(m.hash, memberNames.get(m.hash)!) : undefined;
    if (note) lines.push(note);
    // `export` before each statement (every overload of a function needs one), after any comments above it, so
    // `// @ts-expect-error` lines stay directly above the declaration
    const body = bodies.get(m.hash)!;
    const inserts = opts.exportDeclarations ? statementStarts(body) : [];
    let exported = body;
    for (const at of [...inserts].reverse()) exported = exported.slice(0, at) + "export " + exported.slice(at);
    bodyAt.set(m.hash, { line: lines.length, inserts });
    lines.push(exported, "");
  }
  // a definition with no imports must still be a module, or its names would be globals shared with other files
  if (opts.style === "internal") lines.push("export {};");
  if (opts.style === "cache") {
    for (const m of members) {
      lines.push(`export ${m.kind === "type" ? "type " : ""}{ ${memberNames.get(m.hash)} as ${exportId(m.hash)} };`);
    }
    // functions carry their hash at runtime, so code can name them durably (e.g. a background job records which
    // exact function version to run)
    for (const m of members) {
      if (m.kind === "type") continue;
      const local = memberNames.get(m.hash)!;
      // and so do React contexts and lazy components, which a server component's tree can send to the browser
      lines.push(
        `if (typeof ${local} === "function" || [Symbol.for("react.context"), Symbol.for("react.lazy")].includes((${local} as any)?.$$typeof)) Object.defineProperty(${local}, Symbol.for("tcm.hash"), { value: ${JSON.stringify(m.hash)} });`,
      );
      // a table learns its row type's schema here (the type itself is erased)
      if (m.table) lines.push(`Object.defineProperty(${local}, Symbol.for("tcm.schema"), { value: ${JSON.stringify(m.table)} });`);
    }
  }
  // offsets in the joined text, for editors: each member's declaration and the references in it
  const lineStart: number[] = [];
  lines.reduce((at, l, i) => ((lineStart[i] = at), at + l.length + 1), 0);
  const refs: Rendered["refs"] = [];
  const starts = new Map<string, number>();
  for (const [hash, b] of bodyAt) {
    const base = lineStart[b.line]!;
    const at = (o: number) => base + o + 7 * b.inserts.filter((i) => i <= o).length;
    starts.set(hash, base);
    for (const r of bodyRefs.get(hash) ?? []) refs.push({ start: at(r.start), end: at(r.end), hash: r.hash, from: hash });
  }
  let text = lines.join("\n").trimEnd() + "\n";
  // a module maps each member's lines to where the member reads as written: its view, or its scratch file
  if (opts.style === "cache" && src.viewOf) {
    const mappings: LineMapping[] = [];
    for (const [hash, b] of bodyAt) {
      const view = src.viewOf(hash);
      if (!view) continue;
      const first = text.slice(0, lineStart[b.line]).split("\n").length - 1;
      const body = bodies.get(hash)!;
      const source = path.relative(lay.cacheDir, view.file).split(path.sep).join("/");
      // where the view puts `export ` in front of a statement: a line's columns shift past it
      const inserts = (view.inserts ?? []).map((o) => {
        const before = body.slice(0, o).split("\n");
        return { line: before.length - 1, col: before.at(-1)!.length };
      });
      body.split("\n").forEach((lineText, i) => {
        const columns: [number, number][] = [[0, 0]];
        for (const t of lineText.matchAll(/\S+/g)) if (t.index) columns.push([t.index, t.index]);
        for (const c of columns) c[1] += 7 * inserts.filter((x) => x.line === i && x.col <= c[0]).length;
        mappings.push({ line: first + i, source, sourceLine: view.line + i, columns });
      });
    }
    if (mappings.length) text += inlineSourceMap(lineSourceMap(moduleFile(members[0]!.componentHash, src), mappings)) + "\n";
  }
  return { text, memberNames, refs, starts, inserts: new Map([...bodyAt].map(([h, b]) => [h, b.inserts])) };
}

function writeIfChanged(file: string, text: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/** The packages definitions import, the JSX runtime their elements compile to included. */
export function externalsOf(members: DefRecord[]): ExtRef[] {
  return members.flatMap((m) => [...m.spans.flatMap((s) => (s.ext ? [s.ext] : [])), ...(m.jsx ? [{ module: m.jsx, subpath: "jsx-runtime", export: "*" }] : [])]);
}

/** Write cache modules for the transitive closure of `hashes`, and install the npm packages they use. */
export function materialize(hashes: Iterable<string>, src: DefSource, lay: Layout): void {
  const seen = new Set<string>();
  const exts = new Map<string, ExtRef>();
  const queue = [...hashes];
  while (queue.length) {
    const h = queue.pop()!;
    const rec = src.get(h);
    if (!rec) throw new Error(`missing definition #${h}`);
    if (seen.has(rec.componentHash)) continue;
    seen.add(rec.componentHash);
    const members = src.members(rec.componentHash);
    for (const m of members) {
      for (const s of m.spans) {
        if (s.hash) queue.push(s.hash);
        else if (s.ext) exts.set(extRefString(s.ext), s.ext);
      }
      if (m.jsx) exts.set(m.jsx, { module: m.jsx, subpath: "jsx-runtime", export: "*" });
    }
    writeIfChanged(path.join(lay.cacheDir, moduleFile(rec.componentHash, src)), render(members, src, lay, { style: "cache" }).text);
  }
  ensureExternals(lay, exts.values());
}

export interface ShimName {
  path: string;
  hash: string;
}

/** Regenerate `.tcm/codebase/**` so scratch files can `import { x } from "#codebase/ns"`. */
export function writeShim(names: ShimName[], src: DefSource, lay: Layout): void {
  const byPath = new Map<string, string[]>();
  for (const n of names) byPath.set(n.path, [...(byPath.get(n.path) ?? []), n.hash]);
  const files = new Map<string, string[]>();
  const hashes: string[] = [];
  for (const [name, hs] of byPath) {
    const ns = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
    const file = path.join(lay.shimDir, ns ? `${ns.replaceAll(".", "/")}.ts` : "index.ts");
    const lines = files.get(file) ?? [];
    files.set(file, lines);
    const relTo = (f: string) => {
      const rel = path.relative(path.dirname(file), path.join(lay.cacheDir, f)).split(path.sep).join("/");
      return rel.startsWith(".") ? rel : "./" + rel;
    };
    const recs = hs.map((h) => src.get(h)!);
    if (isConflicted(recs.map((r) => r.kind))) {
      lines.push(`// ${lastSegment(name)}: conflicted (${hs.length} definitions) — see \`tcm todo\``);
      continue;
    }
    hashes.push(...hs);
    if (recs.length === 2) {
      lines.push(`export { ${lastSegment(name)} } from "${relTo(writePairModule(lastSegment(name), recs, src, lay))}";`);
      continue;
    }
    const rec = recs[0]!;
    lines.push(`export ${rec.kind === "type" ? "type " : ""}{ ${exportId(rec.hash)} as ${lastSegment(name)} } from "${relTo(moduleFile(rec.componentHash, src))}";`);
  }
  materialize(hashes, src, lay);
  files.set(path.join(lay.shimDir, "index.ts"), files.get(path.join(lay.shimDir, "index.ts")) ?? []);
  for (const [file, lines] of files) writeIfChanged(file, `// generated by tcm — do not edit\n${lines.sort().join("\n")}\nexport {};\n`);
  const walk = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
  for (const f of walk(lay.shimDir)) if (!files.has(f)) fs.rmSync(f);
}

/**
 * One module exporting a type and a value under one name. TypeScript won't merge two re-exports, but it
 * merges a local declaration with a re-export, so the type is rendered here (under this name, with its type
 * parameters intact) and the value is re-exported beside it. Returns the file name within the cache.
 */
function writePairModule(name: string, recs: DefRecord[], src: DefSource, lay: Layout): string {
  const type = recs.find((r) => r.kind === "type")!;
  const value = recs.find((r) => r.kind !== "type")!;
  const file = `pair_${type.hash}_${value.hash}.ts`;
  const body = render([type], src, lay, {
    style: "internal",
    exportDeclarations: true,
    nameOf: (h) => (h === type.hash ? name : src.nameOf(h)),
  }).text;
  writeIfChanged(
    path.join(lay.cacheDir, file),
    `// generated by tcm — do not edit. ${name}: type ${type.hash} and value ${value.hash}\n${body}\nexport { ${exportId(value.hash)} as ${name} } from "./${moduleFile(value.componentHash, src)}";\n`,
  );
  return file;
}

export const TRANSFORM_MARK = "// tcm: transform";

/** Where test and watch runners' stdout goes: ours, unless that's a protocol channel (`tcm lsp`). */
let runnerStdout: "inherit" | number = "inherit";
export function sendRunnerOutputToStderr() {
  runnerStdout = 2;
}

/** Node flags for processes tcm spawns; the transform hook, when the cache has one, compiles marked modules. */
export function nodeArgs(lay: Layout): string[] {
  const hook = path.join(lay.cacheDir, "tcm-transform.js");
  // source maps: stack traces point at definitions (.tcm/src) and scratch files, not generated modules
  return ["--disable-warning=ExperimentalWarning", "--enable-source-maps", ...(fs.existsSync(hook) ? ["--import", pathToFileURLString(hook)] : [])];
}

function pathToFileURLString(p: string): string {
  return "file://" + p.split(path.sep).map(encodeURIComponent).join("/");
}

/** The module that runs a definition (calls it with the process's arguments, prints the result): `tcm run`'s. */
export function writeRunner(hash: string, src: DefSource, lay: Layout): string {
  materialize([hash], src, lay);
  const rec = src.get(hash)!;
  const runner = path.join(lay.cacheDir, `run_${hash}.ts`);
  writeIfChanged(
    runner,
    `import { ${exportId(hash)} as main } from "./${moduleFile(rec.componentHash, src)}";
const value: unknown = main;
const result = typeof value === "function" ? await value(...process.argv.slice(2)) : value;
if (result !== undefined) console.log(result);
`,
  );
  return runner;
}

/** Run a definition: call it with `args` if it's a function, await the result, print it if not undefined. */
export function run(hash: string, args: string[], src: DefSource, lay: Layout): number {
  const r = spawnSync(process.execPath, [...nodeArgs(lay), writeRunner(hash, src, lay), ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

/** Like `run`, but hands output to a callback as it arrives (for running on behalf of a remote client). */
export function runStreaming(
  hash: string,
  args: string[],
  src: DefSource,
  lay: Layout,
  onOutput: (stream: "stdout" | "stderr", data: string) => void,
): Promise<number> {
  const child = spawn(process.execPath, [...nodeArgs(lay), writeRunner(hash, src, lay), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8").on("data", (d: string) => onOutput("stdout", d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => onOutput("stderr", d));
  return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
}

export interface TestRun {
  hash: string;
  ok: boolean;
  message: string;
  output: string;
  ms: number;
  /** the test never reported a result (the runner crashed or exited); never cache this */
  infrastructure?: boolean;
}

const TEST_TIMEOUT_MS = 10_000;

/**
 * Run tests (functions that pass by returning without throwing, and fail on `false`) in one child process,
 * capturing each one's console output.
 */
export function runTests(tests: { hash: string; componentHash: string }[], src: DefSource, lay: Layout): TestRun[] {
  if (!tests.length) return [];
  materialize(tests.map((t) => t.hash), src, lay);
  const runner = path.join(lay.cacheDir, "test_runner.ts");
  const out = path.join(lay.cacheDir, "test_results.json");
  fs.rmSync(out, { force: true });
  const list = tests.map((t) => [t.hash, `./${moduleFile(t.componentHash, src)}`, exportId(t.hash)]);
  writeIfChanged(
    runner,
    `import { inspect } from "node:util";
import { writeFileSync } from "node:fs";
const tests: [string, string, string][] = ${JSON.stringify(list)};
const results: { hash: string; ok: boolean; message: string; output: string; ms: number }[] = [];
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const save = () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(results));
for (const [hash, file, id] of tests) {
  const output: string[] = [];
  for (const k of Object.keys(original)) {
    (console as unknown as Record<string, unknown>)[k] = (...args: unknown[]) => output.push(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
  }
  const start = performance.now();
  let ok = true;
  let message = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    const test = (await import(file))[id];
    if (typeof test !== "function") throw new Error("a test must be a function");
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timed out after ${TEST_TIMEOUT_MS / 1000}s")), ${TEST_TIMEOUT_MS})));
    if ((await Promise.race([test(), timeout])) === false) throw new Error("returned false");
  } catch (e) {
    ok = false;
    message = e instanceof Error ? e.message : inspect(e);
  } finally {
    clearTimeout(timer);
    Object.assign(console, original);
  }
  results.push({ hash, ok, message, output: output.join("\\n"), ms: Math.round(performance.now() - start) });
  save();
}
save();
`,
  );
  spawnSync(process.execPath, [...nodeArgs(lay), runner], { stdio: ["ignore", runnerStdout, "inherit"], timeout: 5 * 60_000 });
  const done: TestRun[] = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as TestRun[]) : [];
  // a test that crashed the runner (e.g. process.exit) is the first one without a result
  return tests.map(
    (t) =>
      done.find((d) => d.hash === t.hash) ?? {
        hash: t.hash,
        ok: false,
        message: "no result: the test runner crashed or exited before this test finished",
        output: "",
        ms: 0,
        infrastructure: true,
      },
  );
}

export interface WatchResult {
  line: number;
  ok: boolean;
  value: string;
  /** the evaluation itself failed (timeout, crash): says nothing about the expression, so isn't cached */
  infrastructure?: boolean;
}

/** Evaluate watch expressions (already materialized as definitions) in a child process. */
export function evaluateWatches(watches: { hash: string; componentHash: string; line: number }[], src: DefSource, lay: Layout): WatchResult[] {
  if (!watches.length) return [];
  materialize(watches.map((w) => w.hash), src, lay);
  const runner = path.join(lay.cacheDir, "watch_runner.ts");
  const out = path.join(lay.cacheDir, "watch_results.json");
  fs.rmSync(out, { force: true });
  const list = watches.map((w) => [w.line, `./${moduleFile(w.componentHash, src)}`, exportId(w.hash)]);
  writeIfChanged(
    runner,
    `import { inspect } from "node:util";
import { writeFileSync } from "node:fs";
const watches: [number, string, string][] = ${JSON.stringify(list)};
const results: { line: number; ok: boolean; value: string }[] = [];
const colors = !process.env.NO_COLOR;
for (const [line, file, id] of watches) {
  try {
    let value = (await import(file))[id];
    if (value && typeof value.then === "function") value = await value;
    results.push({ line, ok: true, value: inspect(value, { colors, depth: 4 }) });
  } catch (e) {
    results.push({ line, ok: false, value: inspect(e, { colors }) });
  }
}
writeFileSync(${JSON.stringify(out)}, JSON.stringify(results));
`,
  );
  spawnSync(process.execPath, [...nodeArgs(lay), runner], { stdio: ["inherit", runnerStdout, "inherit"], timeout: 10_000 });
  if (!fs.existsSync(out)) return watches.map((w) => ({ line: w.line, ok: false, value: "evaluation did not finish (timeout or crash)", infrastructure: true }));
  return JSON.parse(fs.readFileSync(out, "utf8")) as WatchResult[];
}

export { writeIfChanged };
export { ensureExternals, installedPeers, lockAtLeast, newestVersion, npmAlias, packageManager, parseModule, usePackageLock, versionsIn, type PackageLock } from "./packages.ts";
