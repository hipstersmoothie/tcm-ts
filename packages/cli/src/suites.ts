import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
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
 * A suite: a test file that runs a package's command (its `bin`) as a program, as the people using it would. The
 * package's manifest declares it (`suites`: command → files, relative to the codebase root), and the suite finds
 * the command in the environment variable named for it (`binVariable`).
 */
export interface Suite {
  /** the package it's of, and the command it runs (and the definition that is) */
  pkg: string;
  bin: string;
  main: string;
  /** a test definition, run as a program of its own */
  test?: { path: string; hash: string };
  /** or a test file (while tests are kept in files) */
  file?: string;
}

/**
 * A suite's last run, kept to reuse its result.
 */
export interface SuiteRun {
  /** what it was: the test's hash, or its files' content (the file and what it imports from beside it) */
  of: string;
  /** the runtime's (`resultKey`) */
  key: string;
  /** the definitions it executed: name → their own code (`ownCode`) */
  ran: Record<string, string>;
  tests: number;
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
  const cache = `${pathToFileURL(cb.lay.cacheDir).href}/`;
  const loaded = new Map<string, boolean>();
  for (const f of fs.readdirSync(dir)) {
    let scripts: { url: string; functions: { functionName: string; ranges: { startOffset: number; count: number }[] }[] }[];
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).result;
    } catch {
      continue;
    }
    for (const s of scripts) {
      const component = s.url.startsWith(cache) ? /^([a-z2-7]+)\.tsx?$/.exec(s.url.slice(cache.length))?.[1] : undefined;
      if (!component) continue;
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
 * Run a suite, its command being `entry`: a test definition as a program of its own (passing if it returns), a
 * file with `node --test`. Its result, how many tests it has, and what it executed.
 */
export function runSuite(cb: Codebase, s: Suite, entry: string): Promise<{ result: TestResult; tests: number; ran: Record<string, string> }> {
  const coverage = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-suite-"));
  const started = Date.now();
  // (run from a test, node:test's own setting would make this run report to that test's runner)
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const argv = s.test ? [...nodeArgs(cb.lay), writeRunner(s.test.hash, cb.source(), cb.lay)] : ["--test", "--test-reporter=spec", "--disable-warning=ExperimentalWarning", s.file!];
  const child = spawn(process.execPath, argv, {
    cwd: s.test ? cb.lay.root : path.dirname(s.file!),
    env: { ...env, [binVariable(s.bin)]: entry, NODE_V8_COVERAGE: coverage, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      const ok = code === 0;
      let tests = 1;
      let message = ok ? "" : `exited ${code}`;
      let output = ok ? "" : out.trim().split("\n").slice(0, 80).join("\n");
      if (s.file) {
        const count = (what: string) => Number(new RegExp(`^ℹ ${what} (\\d+)$`, "m").exec(out)?.[1] ?? 0);
        const at = out.indexOf("✖ failing tests");
        const failing = at < 0 ? [] : [...new Set(out.slice(at).match(/^✖ .+$/gm) ?? [])].filter((l) => !l.startsWith("✖ failing tests"));
        tests = count("tests");
        if (!ok && failing.length) message = failing.map((l) => l.slice(2)).join("\n");
        if (!ok) output = (at < 0 ? out : out.slice(at)).trim().split("\n").slice(0, 80).join("\n");
      } else if (!ok) {
        // what it threw: the error's first lines
        const thrown = /^(\w*Error\b.*(?:\n(?! {4}at ).*){0,12})/m.exec(out)?.[1];
        if (thrown) message = thrown.trim();
      }
      const ran = executed(cb, coverage);
      fs.rmSync(coverage, { recursive: true, force: true });
      resolve({ result: { hash: s.test?.hash ?? s.file!, ok, message, output, ms: Date.now() - started }, tests, ran });
    });
  });
}

/**
 * Run suites against the codebase's own build of their commands, reusing results. A suite's result holds until
 * its files change, or the code of a definition it executed does: one it didn't run can't change what it does
 * without one it ran changing too. A suite that executed nothing of the codebase always runs. `fresh` runs them all.
 */
export async function runSuites(cb: Codebase, suites: Suite[], fresh: boolean, onOutcome?: (o: TestOutcome) => void): Promise<TestOutcome[]> {
  const key = resultKey(cb);
  const runs = JSON.parse(cb.store.getSetting("suites") ?? "{}") as Record<string, SuiteRun>;
  const rel = (s: Suite) => s.test?.path ?? path.relative(cb.lay.root, s.file!);
  const label = (s: Suite, tests: number) => (s.test ? s.test.path : `${rel(s)} (${tests} test${tests === 1 ? "" : "s"})`);
  const holds = (r: SuiteRun, of: string) =>
    r.of === of &&
    r.key === key &&
    Object.keys(r.ran).length > 0 &&
    Object.entries(r.ran).every(([name, own]) => {
      const hs = cb.store.hashesAt(name).filter((h) => cb.store.getDef(h)?.kind !== "type");
      return hs.length === 1 && ownCode(cb, cb.store.getDef(hs[0]!)!) === own;
    });
  const entries = new Map<string, string>();
  const entry = (main: string) => {
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
    const of = s.test?.hash ?? suiteFiles(s.file!);
    const r = runs[rel(s)];
    if (!fresh && r && holds(r, of)) {
      out.set(s, { path: label(s, r.tests), result: r.result, cached: true });
      onOutcome?.(out.get(s)!);
    }
    else todo.push({ s, of });
  }
  // side by side, as `node --test` runs files
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { s, of } = todo[next++]!;
      const { result, tests, ran } = await runSuite(cb, s, entry(s.main));
      out.set(s, { path: label(s, tests), result, cached: false });
      onOutcome?.(out.get(s)!);
      // (a run with no tests in it went wrong before they ran: nothing to keep)
      if (Object.keys(ran).length && tests) runs[rel(s)] = { of, key, ran, tests, result };
      else delete runs[rel(s)];
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, os.availableParallelism() - 1), todo.length) }, worker));
  cb.store.setSetting("suites", JSON.stringify(runs));
  return suites.map((s) => out.get(s)!);
}

/**
 * A suite's files' content: it and what it imports from beside it (helpers), which it runs too.
 */
export function suiteFiles(file: string): string {
  const h = crypto.createHash("sha256");
  const seen = new Set<string>();
  const add = (f: string) => {
    if (seen.has(f) || !fs.existsSync(f)) return;
    seen.add(f);
    const text = fs.readFileSync(f, "utf8");
    h.update(`${f}\0${text}\0`);
    for (const m of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) add(path.resolve(path.dirname(f), m[1]!));
  };
  add(file);
  return h.digest("hex");
}

/**
 * The suites the packages declare (`suites`: command → namespaces of test definitions that run it, relative to the
 * package), those in `ns`. While tests are kept in files, an entry with a `/` or `*` is a glob of test files
 * (relative to the codebase root) instead, run when `ns` holds the package; a `<name>.test.ts` beside a
 * `<name>.ts` runs that file's test definitions, which `tcm test` runs as definitions, so it isn't one.
 */
export function suitesIn(cb: Codebase, ns: string): Suite[] {
  const within = (p: string, under: string) => !under || p === under || p.startsWith(`${under}.`);
  const names = cb.store.names();
  const out: Suite[] = [];
  for (const pkg of packagesIn(cb, names)) {
    for (const [bin, entries] of Object.entries(pkg.manifest.suites)) {
      const main = absolute(pkg.namespace, pkg.manifest.bin[bin]!);
      for (const entry of entries) {
        if (!/[/*]/.test(entry)) {
          const under = absolute(pkg.namespace, entry);
          for (const n of names) if (n.kind !== "type" && isTestPath(n.path) && within(n.path, under) && within(n.path, ns)) out.push({ pkg: pkg.namespace, bin, main, test: { path: n.path, hash: n.hash } });
          continue;
        }
        if (!within(pkg.namespace, ns)) continue;
        for (const f of fs.globSync(entry, { cwd: cb.lay.root })) {
          const file = path.resolve(cb.lay.root, f);
          if (!fs.existsSync(file.replace(/\.test\.(m|c)?tsx?$/, ".ts"))) out.push({ pkg: pkg.namespace, bin, main, file });
        }
      }
    }
  }
  const key = (s: Suite) => s.test?.path ?? s.file!;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}
