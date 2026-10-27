import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { exportId, extRefString, type DefRecord, type ExtRef } from "@ucm/core";

export interface Layout {
  root: string;
  ucmDir: string;
  cacheDir: string;
  shimDir: string;
  dbFile: string;
}

export function layout(root: string): Layout {
  const ucmDir = path.join(root, ".ucm");
  return { root, ucmDir, cacheDir: path.join(ucmDir, "cache"), shimDir: path.join(ucmDir, "codebase"), dbFile: path.join(ucmDir, "codebase.sqlite") };
}

/** Where definitions come from: the store, possibly overlaid with not-yet-added scratch definitions. */
export interface DefSource {
  get(hash: string): DefRecord | undefined;
  members(componentHash: string): DefRecord[];
  /** current full name on the branch, if any */
  nameOf(hash: string): string | undefined;
}

/**
 * - `cache`: a component module in `.ucm/cache`, imports by hash, exported as `h_<hash>`
 * - `internal`: like cache but without exports; used to re-typecheck definitions after an update
 * - `scratch`: editable source for the project root, imports through `#codebase/...`
 */
export type Style = "cache" | "internal" | "scratch";

export interface RenderOptions {
  style: Style;
  /** rewrite references (used by update propagation) */
  remap?: (hash: string) => string;
  /** leave out import lines (for showing a definition's body, e.g. in diffs) */
  omitImports?: boolean;
  /** names to render with instead of the current branch's (a diff shows each side with its own names) */
  nameOf?: (hash: string) => string | undefined;
  /** scratch style: a comment line to put above a member, given the identifier it is declared as */
  annotate?: (hash: string, declaredAs: string) => string | undefined;
}

export interface Rendered {
  text: string;
  /** member hash → the identifier it is declared as */
  memberNames: Map<string, string>;
}

const lastSegment = (name: string) => name.slice(name.lastIndexOf(".") + 1);
const sanitize = (s: string) => (s.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1") || "x");

export function npmAlias(module: string): string {
  // npm:@scope/name@1.2.3 → npm__scope__name__1.2.3
  const m = /^npm:(.+)@([^@]+)$/.exec(module)!;
  return `npm__${m[1]!.replace(/^@/, "").replace("/", "__").toLowerCase()}__${m[2]}`;
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
  const hoisted = members.filter((m) => m.initKind === "hoisted");
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
  // functions and classes keep the name they were hashed with, so `.name` agrees with the hash
  for (const m of members) memberNames.set(m.hash, uniq(m.nominal ? m.nameHint : displayName(m.hash)));

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
      const base = target ? displayName(target) : m.sourceText.slice(span.start, span.end);
      imp = { local: uniq(base), hash: target, ext: span.ext, value: false };
      imports.set(key, imp);
    }
    if (span.pos === "value") imp.value = true;
    return imp.local;
  };

  const bodies = new Map<string, string>();
  for (const m of members) {
    let text = m.sourceText;
    for (const span of [...m.spans].sort((a, b) => b.start - a.start)) {
      const local = localFor(m, span);
      const replacement = span.shorthand && span.shorthand !== local ? `${span.shorthand}: ${local}` : local;
      text = text.slice(0, span.start) + replacement + text.slice(span.end);
    }
    bodies.set(m.hash, text);
  }

  const lines: string[] = [];
  if (opts.style === "cache") lines.push(`// generated by ucm — do not edit. component ${members[0]!.componentHash}`);
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
        const file = opts.style === "scratch" ? `./${path.relative(lay.root, lay.cacheDir).split(path.sep).join("/")}/${rec.componentHash}.ts` : `./${rec.componentHash}.ts`;
        lines.push(importLine(imp.local, exportId(imp.hash), file, typeOnly));
      }
    } else {
      const e = imp.ext!;
      let from = e.module;
      if (e.module.startsWith("npm:")) from = (opts.style === "scratch" ? realPackage(e.module) : npmAlias(e.module)) + (e.subpath ? `/${e.subpath}` : "");
      lines.push(importLine(imp.local, e.export, from, !imp.value));
    }
  }
  if (opts.omitImports) lines.length = opts.style === "cache" ? 1 : 0;
  if (lines.length) lines.push("");

  const ordered = opts.style === "scratch" ? members : initOrder(members);
  for (const m of ordered) {
    if (opts.style === "scratch" && m.doc) lines.push(`/**\n${m.doc.split("\n").map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */`);
    const note = opts.style === "scratch" ? opts.annotate?.(m.hash, memberNames.get(m.hash)!) : undefined;
    if (note) lines.push(note);
    lines.push(bodies.get(m.hash)!, "");
  }
  if (opts.style === "cache") {
    for (const m of members) {
      lines.push(`export ${m.kind === "type" ? "type " : ""}{ ${memberNames.get(m.hash)} as ${exportId(m.hash)} };`);
    }
  }
  return { text: lines.join("\n").trimEnd() + "\n", memberNames };
}

function writeIfChanged(file: string, text: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
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
    }
    writeIfChanged(path.join(lay.cacheDir, `${rec.componentHash}.ts`), render(members, src, lay, { style: "cache" }).text);
  }
  ensureExternals(lay, exts.values());
}

/**
 * `.ucm/cache/package.json` installs every pinned npm version under an alias
 * (`npm__lodash-es__4.17.21`), so definitions pinned to different versions coexist.
 */
export function ensureExternals(lay: Layout, exts: Iterable<ExtRef>): void {
  const file = path.join(lay.cacheDir, "package.json");
  const pkg = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as { dependencies?: Record<string, string> })
    : {};
  const deps = { ...(pkg.dependencies ?? {}) };
  const missing: string[] = [];
  for (const e of exts) {
    if (!e.module.startsWith("npm:")) continue;
    const alias = npmAlias(e.module);
    deps[alias] = `npm:${e.module.slice(4)}`;
    if (!fs.existsSync(path.join(lay.cacheDir, "node_modules", alias, "package.json"))) missing.push(alias);
  }
  writeIfChanged(file, JSON.stringify({ name: "ucm-cache", private: true, type: "module", dependencies: deps }, null, 2) + "\n");
  if (missing.length) {
    process.stderr.write(`installing ${missing.join(", ")}\n`);
    const r = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: lay.cacheDir, stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error("npm install failed in .ucm/cache");
  }
}

export interface ShimName {
  path: string;
  hash: string;
}

/** Regenerate `.ucm/codebase/**` so scratch files can `import { x } from "#codebase/ns"`. */
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
    if (hs.length > 1) {
      lines.push(`// ${lastSegment(name)}: conflicted (${hs.length} definitions) — see \`ucm todo\``);
      continue;
    }
    const rec = src.get(hs[0]!)!;
    hashes.push(rec.hash);
    const rel = path.relative(path.dirname(file), path.join(lay.cacheDir, `${rec.componentHash}.ts`)).split(path.sep).join("/");
    lines.push(`export ${rec.kind === "type" ? "type " : ""}{ ${exportId(rec.hash)} as ${lastSegment(name)} } from "${rel.startsWith(".") ? rel : "./" + rel}";`);
  }
  materialize(hashes, src, lay);
  files.set(path.join(lay.shimDir, "index.ts"), files.get(path.join(lay.shimDir, "index.ts")) ?? []);
  for (const [file, lines] of files) writeIfChanged(file, `// generated by ucm — do not edit\n${lines.sort().join("\n")}\nexport {};\n`);
  const walk = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
  for (const f of walk(lay.shimDir)) if (!files.has(f)) fs.rmSync(f);
}

const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

function writeRunner(hash: string, src: DefSource, lay: Layout): string {
  materialize([hash], src, lay);
  const rec = src.get(hash)!;
  const runner = path.join(lay.cacheDir, `run_${hash}.ts`);
  writeIfChanged(
    runner,
    `import { ${exportId(hash)} as main } from "./${rec.componentHash}.ts";
const value: unknown = main;
const result = typeof value === "function" ? await value(...process.argv.slice(2)) : value;
if (result !== undefined) console.log(result);
`,
  );
  return runner;
}

/** Run a definition: call it with `args` if it's a function, await the result, print it if not undefined. */
export function run(hash: string, args: string[], src: DefSource, lay: Layout): number {
  const r = spawnSync(process.execPath, [...NODE_ARGS, writeRunner(hash, src, lay), ...args], { stdio: "inherit" });
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
  const child = spawn(process.execPath, [...NODE_ARGS, writeRunner(hash, src, lay), ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
  const list = tests.map((t) => [t.hash, `./${t.componentHash}.ts`, exportId(t.hash)]);
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
  spawnSync(process.execPath, [...NODE_ARGS, runner], { stdio: ["ignore", "inherit", "inherit"], timeout: 5 * 60_000 });
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
}

/** Evaluate watch expressions (already materialized as definitions) in a child process. */
export function evaluateWatches(watches: { hash: string; componentHash: string; line: number }[], src: DefSource, lay: Layout): WatchResult[] {
  if (!watches.length) return [];
  materialize(watches.map((w) => w.hash), src, lay);
  const runner = path.join(lay.cacheDir, "watch_runner.ts");
  const out = path.join(lay.cacheDir, "watch_results.json");
  fs.rmSync(out, { force: true });
  const list = watches.map((w) => [w.line, `./${w.componentHash}.ts`, exportId(w.hash)]);
  writeIfChanged(
    runner,
    `import { inspect } from "node:util";
import { writeFileSync } from "node:fs";
const watches: [number, string, string][] = ${JSON.stringify(list)};
const results: { line: number; ok: boolean; value: string }[] = [];
for (const [line, file, id] of watches) {
  try {
    let value = (await import(file))[id];
    if (value && typeof value.then === "function") value = await value;
    results.push({ line, ok: true, value: inspect(value, { colors: true, depth: 4 }) });
  } catch (e) {
    results.push({ line, ok: false, value: inspect(e, { colors: true }) });
  }
}
writeFileSync(${JSON.stringify(out)}, JSON.stringify(results));
`,
  );
  spawnSync(process.execPath, [...NODE_ARGS, runner], { stdio: "inherit", timeout: 10_000 });
  if (!fs.existsSync(out)) return watches.map((w) => ({ line: w.line, ok: false, value: "evaluation did not finish (timeout or crash)" }));
  return JSON.parse(fs.readFileSync(out, "utf8")) as WatchResult[];
}

export { writeIfChanged };
