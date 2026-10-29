import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import type { TestResult } from "@tcm/store";
import type { DefRecord } from "@tcm/core";
import { writeRunner } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { withoutCyclePositions } from "./main.ts";
import type { TestOutcome } from "./testing.ts";
import { resultKey } from "./vitest.ts";
import { absolute, packagesIn } from "./manifests.ts";
import { nodeArgs } from "@tcm/loader";
import { isTestPath } from "./testing.ts";

/**
 * A suite's test: a test definition that runs a package's command (its `bin`) as a program, as the people using it
 * would. The package's manifest declares them (`suites`: command → namespaces), and the test finds the command in
 * the environment variable named for it (`binVariable`).
 */
export interface Suite {
  /** the package it's of, and the command it runs (and the definition that is) */
  pkg: string;
  bin: string;
  main: string;
  /** the test definition */
  path: string;
  hash: string;
}

/**
 * A suite's test's last run, kept to reuse its result.
 */
export interface SuiteRun {
  /** the test's hash */
  of: string;
  /** the runtime's (`resultKey`) */
  key: string;
  /** the definitions it executed: name → their own code (`ownCode`) */
  ran: Record<string, string>;
  result: TestResult;
}

/**
 * The environment variable a suite finds a command in: `TCM_BIN` for `tcm`, `MY_TOOL_BIN` for `my-tool`.
 */
export const binVariable = (bin: string) => `${bin.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;

/**
 * Whether loading a definition runs code: a value computed at load, rather than a function (or a const holding one).
 */
export function evaluatedOnLoad(rec: DefRecord): boolean {
  if (rec.initKind !== "strict") return false;
  const decl = (JSON.parse(rec.ir) as unknown[])[3];
  const init = Array.isArray(decl) ? (decl.find((s) => Array.isArray(s) && s[0] === "initializer") as unknown[] | undefined) : undefined;
  const kind = Array.isArray(init?.[1]) ? (init[1] as unknown[])[0] : undefined;
  return kind !== "ArrowFunction" && kind !== "FunctionExpression";
}

/**
 * The codebase's definitions a run executed, from the V8 coverage its processes wrote to `dir`: each one's own
 * code, by name. A component's module counts as executed if a function in it ran, or if loading it computes a
 * value.
 */
export function executed(cb: Codebase, dir: string): Record<string, string> {
  const loaded = new Map<string, boolean>();
  for (const f of fs.readdirSync(dir)) {
    let scripts: { url: string; functions: { functionName: string; ranges: { startOffset: number; count: number }[] }[] }[];
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).result;
    } catch {
      continue;
    }
    for (const s of scripts) {
      // a component's module, as the codebase runs it (.tcm/cache) or a package packed from it has it (modules/)
      const component = /\/([a-z2-7]{52})\.(?:tsx?|js)$/.exec(s.url)?.[1];
      if (!component || !cb.store.componentMembers(component).length) continue;
      // (the first function is the module's own top level)
      const ran = s.functions.some((fn) => !(fn.functionName === "" && fn.ranges[0]!.startOffset === 0) && fn.ranges[0]!.count > 0);
      loaded.set(component, (loaded.get(component) ?? false) || ran);
    }
  }
  const out: Record<string, string> = {};
  for (const [component, ran] of loaded) {
    for (const m of cb.store.componentMembers(component)) {
      if (m.kind === "type" || !(ran || evaluatedOnLoad(m))) continue;
      const name = cb.store.pathsOf(m.hash)[0];
      if (name) out[name] = ownCode(cb, m);
    }
  }
  return out;
}

/**
 * A definition's own code, as a suite's result depends on it: its IR, referring to other definitions by name
 * rather than hash. A definition the suite didn't run changing re-hashes the ones using it, but leaves what the
 * suite did as it was.
 */
export function ownCode(cb: Codebase, rec: DefRecord): string {
  const ir = withoutCyclePositions(rec.ir).replace(/\["Ref","([a-z2-7]+)"\]/g, (_, h: string) => JSON.stringify(["Ref", cb.store.pathsOf(h)[0] ?? h]));
  return crypto.createHash("sha256").update(ir).digest("hex").slice(0, 32);
}

/**
 * Run a suite's test as a program of its own (passing if it returns), its command being `entry`: its result, and what it executed.
 */
export function runSuite(cb: Codebase, s: Suite, entry: string): Promise<{ result: TestResult; ran: Record<string, string> }> {
  const coverage = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-suite-"));
  const started = Date.now();
  // (run from a test, node:test's own setting would make this run report to that test's runner)
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawn(process.execPath, [...nodeArgs(cb.lay), writeRunner(s.hash, cb.source(), cb.lay)], {
    cwd: cb.lay.root,
    env: { ...env, [binVariable(s.bin)]: entry, NODE_V8_COVERAGE: coverage, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      const ok = code === 0;
      // what it threw: the error's first lines
      const thrown = ok ? undefined : /^(\w*Error\b.*(?:\n(?! {4}at ).*){0,12})/m.exec(out)?.[1];
      const message = ok ? "" : (thrown?.trim() ?? `exited ${code}`);
      const output = ok ? "" : out.trim().split("\n").slice(0, 80).join("\n");
      const ran = executed(cb, coverage);
      fs.rmSync(coverage, { recursive: true, force: true });
      resolve({ result: { hash: s.hash, ok, message, output, ms: Date.now() - started }, ran });
    });
  });
}

/**
 * Run suites against the codebase's own build of their commands, reusing results. A test's result holds until it
 * changes, or the code of a definition it executed does: one it didn't run can't change what it does without one
 * it ran changing too. A test that executed nothing of the codebase always runs. `fresh` runs them all.
 */
export async function runSuites(cb: Codebase, suites: Suite[], fresh: boolean, onOutcome?: (o: TestOutcome) => void, builds = new Map<string, string>()): Promise<TestOutcome[]> {
  // against another build of a command, results are its own: kept apart, and keyed by what's in it
  const builtAs = new Map([...builds].map(([cmd, file]) => [cmd, buildOf(file)]));
  const keyOf = (s: Suite) => `${resultKey(cb)}${builtAs.has(s.bin) ? ` ${s.bin}=${builtAs.get(s.bin)}` : ""}`;
  const runs = JSON.parse(cb.store.getSetting("suites") ?? "{}") as Record<string, SuiteRun>;
  const slot = (s: Suite) => `${s.path}${builds.has(s.bin) ? ` (${s.bin} built)` : ""}`;
  const holds = (s: Suite, r: SuiteRun, of: string) =>
    r.of === of &&
    r.key === keyOf(s) &&
    Object.keys(r.ran).length > 0 &&
    Object.entries(r.ran).every(([name, own]) => {
      const hs = cb.store.hashesAt(name).filter((h) => cb.store.getDef(h)?.kind !== "type");
      return hs.length === 1 && ownCode(cb, cb.store.getDef(hs[0]!)!) === own;
    });
  const entries = new Map<string, string>();
  const entry = (s: Suite) => {
    const built = builds.get(s.bin);
    if (built) return built;
    const main = s.main;
    if (!entries.has(main)) {
      const h = cb.store.hashesAt(main).find((x) => cb.store.getDef(x)?.kind !== "type");
      if (!h) throw new Error(`${main}, a command suites run, isn't in the codebase`);
      entries.set(main, writeRunner(h, cb.source(), cb.lay));
    }
    return entries.get(main)!;
  };
  const out = new Map<Suite, TestOutcome>();
  const todo: { s: Suite; of: string }[] = [];
  for (const s of suites) {
    const of = s.hash;
    const r = runs[slot(s)];
    if (!fresh && r && holds(s, r, of)) {
      out.set(s, { path: s.path, result: r.result, cached: true });
      onOutcome?.(out.get(s)!);
    }
    else todo.push({ s, of });
  }
  // side by side
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { s, of } = todo[next++]!;
      const { result, ran } = await runSuite(cb, s, entry(s));
      out.set(s, { path: s.path, result, cached: false });
      onOutcome?.(out.get(s)!);
      if (Object.keys(ran).length) runs[slot(s)] = { of, key: keyOf(s), ran, result };
      else delete runs[slot(s)];
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, os.availableParallelism() - 1), todo.length) }, worker));
  cb.store.setSetting("suites", JSON.stringify(runs));
  return suites.map((s) => out.get(s)!);
}

/**
 * The suites the packages declare (`suites`: command → namespaces of test definitions that run it, relative to the
 * package), those in `ns`.
 */
export function suitesIn(cb: Codebase, ns: string): Suite[] {
  const within = (p: string, under: string) => !under || p === under || p.startsWith(`${under}.`);
  const names = cb.store.names();
  const out: Suite[] = [];
  for (const pkg of packagesIn(cb, names)) {
    for (const [bin, entries] of Object.entries(pkg.manifest.suites)) {
      const main = absolute(pkg.namespace, pkg.manifest.bin[bin]!);
      for (const entry of entries) {
        const under = absolute(pkg.namespace, entry);
        for (const n of names) if (n.kind !== "type" && isTestPath(n.path) && within(n.path, under) && within(n.path, ns)) out.push({ pkg: pkg.namespace, bin, main, path: n.path, hash: n.hash });
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * What a build of a command is: a fingerprint of the code in the package it's in (its scripts and manifests), so
 * results against it are kept until that changes. Not its docs, its installed packages, nor its modules: a packed
 * module is named by its component's hash, and whether one a test ran changed is judged by the code it ran, as
 * in the codebase.
 */
export function buildOf(file: string): string {
  let root = path.dirname(file);
  while (!fs.existsSync(path.join(root, "package.json")) && path.dirname(root) !== root) root = path.dirname(root);
  const h = crypto.createHash("sha256");
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !(e.name === "modules" && dir === root)) walk(p);
      } else if (/\.(m|c)?js$|\.json$/.test(e.name)) h.update(`${path.relative(root, p)}\0`).update(fs.readFileSync(p)).update("\0");
    }
  };
  walk(root);
  return h.digest("hex").slice(0, 16);
}

/**
 * The codebase's commands (its packages' `bin`s), as the environment variables suites find them in: name → its runner.
 */
export function commandsIn(cb: Codebase): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pkg of packagesIn(cb, cb.store.names())) {
    for (const [cmd, target] of Object.entries(pkg.manifest.bin)) {
      const h = cb.store.hashesAt(absolute(pkg.namespace, target)).find((x) => cb.store.getDef(x)?.kind !== "type");
      if (h) out[binVariable(cmd)] = writeRunner(h, cb.source(), cb.lay);
    }
  }
  return out;
}
