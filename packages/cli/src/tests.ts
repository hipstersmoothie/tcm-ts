import type { DefRecord, WatchRecord } from "@ucm/core";
import type { TestResult } from "@ucm/store";
import { evaluateWatches, runTests, type DefSource, type WatchResult } from "@ucm/loader";
import type { Codebase } from "./codebase.ts";
import { bold, dim, green, red } from "./style.ts";

/** Tests are definitions named `test…` (`lib.testSortIsStable`, `test_sort`) or living under a `tests` namespace. */
export function isTestPath(p: string): boolean {
  const last = p.slice(p.lastIndexOf(".") + 1);
  return p.split(".").includes("tests") || /^test([A-Z0-9_$]|$)/.test(last);
}

export interface TestOutcome {
  path: string;
  result: TestResult;
  cached: boolean;
}

/**
 * Run tests, reusing cached results. A test's hash covers its code and, through its dependencies, everything
 * it calls (pinned npm versions included), so a cached result is only stale if the test depends on something
 * outside the codebase, like the filesystem, the clock, or the network. `fresh` ignores the cache.
 */
export function runCached(cb: Codebase, items: { path: string; rec: DefRecord }[], src: DefSource, fresh: boolean): TestOutcome[] {
  const node = process.version;
  const cached = new Map<string, TestResult>();
  if (!fresh) for (const { rec } of items) {
    const r = cb.store.testResult(rec.hash, node);
    if (r) cached.set(rec.hash, r);
  }
  const toRun = [...new Map(items.filter(({ rec }) => !cached.has(rec.hash)).map(({ rec }) => [rec.hash, rec])).values()];
  const ran = new Map(runTests(toRun, src, cb.lay).map((r) => [r.hash, r]));
  for (const r of ran.values()) if (!r.infrastructure) cb.store.putTestResult(r, node);
  return items.map(({ path, rec }) => ({ path, result: (cached.get(rec.hash) ?? ran.get(rec.hash))!, cached: cached.has(rec.hash) }));
}

export function printOutcomes(outcomes: TestOutcome[], indent = "  ") {
  for (const o of outcomes) {
    const { ok, message, output, ms } = o.result;
    const meta = dim(o.cached ? "(cached)" : `${ms}ms`);
    console.log(`${indent}${ok ? green("✓") : red("✗")} ${ok ? o.path : bold(o.path)}  ${meta}`);
    if (!ok) for (const line of message.split("\n")) console.log(`${indent}    ${red(line)}`);
    if (!ok && output) for (const line of output.split("\n")) console.log(`${indent}    ${dim("│ " + line)}`);
  }
}

export function summary(outcomes: TestOutcome[]): string {
  const failed = outcomes.filter((o) => !o.result.ok).length;
  const cached = outcomes.filter((o) => o.cached).length;
  const text = `${outcomes.length - failed} passed, ${failed} failed${cached ? dim(` (${cached} cached)`) : ""}`;
  return failed ? red(text) : green(text);
}

/**
 * Watch expression values, reused by hash. Like a test's, a watch expression's hash covers everything it
 * evaluates, so a value is only stale if it depends on the outside world (files, the clock): `fresh` re-runs.
 */
export function evaluateCached(cb: Codebase, watches: WatchRecord[], src: DefSource, fresh: boolean): Map<number, WatchResult & { cached: boolean }> {
  const node = process.version;
  const cached = new Map<string, { ok: boolean; value: string }>();
  if (!fresh) for (const w of watches) {
    const r = cb.store.watchResult(w.hash, node);
    if (r) cached.set(w.hash, r);
  }
  const ran = evaluateWatches(watches.filter((w) => !cached.has(w.hash)), src, cb.lay);
  const out = new Map<number, WatchResult & { cached: boolean }>();
  for (const w of watches) {
    const c = cached.get(w.hash);
    if (c) {
      out.set(w.line, { line: w.line, ...c, cached: true });
      continue;
    }
    const r = ran.find((x) => x.line === w.line);
    if (!r) continue;
    out.set(w.line, { ...r, cached: false });
    if (!r.infrastructure) cb.store.putWatchResult(w.hash, node, r);
  }
  return out;
}

