// Tests run with Vitest, with nothing to set up.
//
// A test is still one definition (named test…), and its result is still cached by hash. What runs it is Vitest:
// each test definition is one Vitest test, so `expect`, `vi` (mocks, fake timers), snapshots and its failure
// messages all work, imported from `vitest`, which tcm provides like any package.
//
// Where a test runs is inferred like everything else: a test that needs the browser (it, or something it uses or
// renders, needs the DOM or keeps component state) runs in Vitest's browser mode, in Chrome; the rest in Node.
// Both go through Vite, with tcm's plugin for browser tests, so server functions they call are reached by hash,
// as in an app.
//
// `runTestsWithVitest` (synchronous, like the rest of tcm's checks) writes a request and runs a child tcm process
// (`tcm internal-vitest <request>`), which runs Vitest and writes back the results.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { exportId, type DefRecord } from "@tcm/core";
import { materialize, moduleFile, type DefSource, type TestRun } from "@tcm/loader";
import { Codebase } from "./codebase.ts";
import { testPlugins } from "./web.ts";
import { provideTool, toolRange } from "./lint.ts";
import { Placement } from "./placement.ts";

const TEST_TIMEOUT_MS = 10_000;

interface TestEntry {
  hash: string;
  /** the module, relative to the cache */
  module: string;
  export: string;
}

interface Request {
  root: string;
  vitest: string;
  browser?: { provider: string };
  node: TestEntry[];
  browserTests: TestEntry[];
  /** definitions the tests use that aren't stored yet (a scratch file's) */
  unsaved: DefRecord[];
  results: string;
}

/** The key test results are cached under: the runtime and the test framework that produced them. */
export function testRunKey(cb: Codebase): string {
  const range = toolRange(cb, "vitest");
  const vitest = range && cb.store.lockedVersion("vitest", range);
  return `${process.version}${vitest ? ` vitest@${vitest}` : ""}`;
}

/**
 * Prepare a Vitest run of these tests: the request a child tcm process runs (`tcm internal-vitest <file>`), and
 * where its results will be. The debugger runs it too, under its own control.
 */
export function prepareTestRun(cb: Codebase, tests: { hash: string; componentHash: string }[], src: DefSource): { requestFile: string; results: string } {
  materialize(tests.map((t) => t.hash), src, cb.lay);
  const vitest = provideTool(cb, "vitest");
  // what's not in the store yet (an unsaved scratch file's definitions), so the child sees it too
  const unsaved = new Map<string, DefRecord>();
  const stack = tests.map((t) => t.hash);
  while (stack.length) {
    const h = stack.pop()!;
    if (unsaved.has(h) || cb.store.hasDef(h)) continue;
    const rec = src.get(h);
    if (!rec) continue;
    unsaved.set(h, rec);
    for (const m of src.members(rec.componentHash)) for (const s of m.spans) if (s.hash) stack.push(s.hash);
  }
  const placement = new Placement(cb, (h) => src.get(h));
  const entry = (t: { hash: string; componentHash: string }): TestEntry => ({ hash: t.hash, module: moduleFile(t.componentHash, src), export: exportId(t.hash) });
  const inBrowser = tests.filter((t) => placement.testNeedsBrowser(t.hash));
  const inNode = tests.filter((t) => !inBrowser.includes(t));
  const provider = inBrowser.length ? provideTool(cb, "@vitest/browser-playwright") : undefined;
  if (provider) provideTool(cb, "playwright");
  const dir = path.join(cb.lay.tcmDir, "test");
  fs.mkdirSync(dir, { recursive: true });
  const request: Request = {
    root: cb.lay.root,
    vitest: vitest.dir,
    ...(provider ? { browser: { provider: provider.dir } } : {}),
    node: inNode.map(entry),
    browserTests: inBrowser.map(entry),
    unsaved: [...unsaved.values()],
    results: path.join(dir, `results-${process.pid}.json`),
  };
  const requestFile = path.join(dir, `request-${process.pid}.json`);
  fs.writeFileSync(requestFile, JSON.stringify(request));
  fs.rmSync(request.results, { force: true });
  return { requestFile, results: request.results };
}

/** Run test definitions with Vitest: in Node, or in a browser for tests that need one. */
export function runTestsWithVitest(cb: Codebase, tests: { hash: string; componentHash: string }[], src: DefSource): TestRun[] {
  if (!tests.length) return [];
  const { requestFile, results } = prepareTestRun(cb, tests, src);
  const r = spawnSync(process.execPath, [process.argv[1]!, "internal-vitest", requestFile], {
    cwd: cb.lay.root,
    encoding: "utf8",
    timeout: 10 * 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  // TCM_KEEP_TEST_RUN=1 leaves the request in .tcm/test, to run the child by hand (`tcm internal-vitest <it>`)
  if (!process.env.TCM_KEEP_TEST_RUN) fs.rmSync(requestFile, { force: true });
  let done: TestRun[] = [];
  try {
    done = JSON.parse(fs.readFileSync(results, "utf8")) as TestRun[];
  } catch {
    // no results: the runner itself failed
  }
  fs.rmSync(results, { force: true });
  const why = (r.stderr || r.stdout || "").trim().split("\n").slice(-8).join("\n");
  return tests.map(
    (t) =>
      done.find((d) => d.hash === t.hash) ?? {
        hash: t.hash,
        ok: false,
        message: `no result: the test runner failed${why ? `\n${why}` : ""}`,
        output: "",
        ms: 0,
        infrastructure: true,
      },
  );
}

/** One generated Vitest file: each test definition as a `test()`, named by its hash. */
function testFile(dir: string, cacheDir: string, vitestImport: string, tests: TestEntry[]): string {
  const rel = path.relative(dir, cacheDir).split(path.sep).join("/");
  const lines = [`import { test } from ${JSON.stringify(vitestImport)};`];
  tests.forEach((t, i) => lines.push(`import { ${t.export} as t${i} } from ${JSON.stringify(`${rel}/${t.module}`)};`));
  tests.forEach((t, i) =>
    lines.push(
      `test(${JSON.stringify(t.hash)}, async () => {`,
      `  if (typeof t${i} !== "function") throw new Error("a test must be a function");`,
      `  if ((await t${i}()) === false) throw new Error("returned false");`,
      `}, ${TEST_TIMEOUT_MS});`,
    ),
  );
  return lines.join("\n") + "\n";
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The test root's node_modules: everything in the cache (the pinned aliases generated modules import), plus the
 * test tools under their own names, which Vitest's browser mode looks them up by.
 */
function linkModules(dir: string, cache: string, plain: Record<string, string>) {
  const link = (target: string, at: string) => {
    if (fs.lstatSync(at, { throwIfNoEntry: false })) {
      if (fs.lstatSync(at).isSymbolicLink() && fs.readlinkSync(at) === target) return;
      fs.rmSync(at, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "dir");
  };
  // from before it was a directory of links
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.existsSync(cache) ? fs.readdirSync(cache) : []) if (name !== ".bin") link(path.join(cache, name), path.join(dir, name));
  for (const [name, target] of Object.entries(plain)) link(fs.realpathSync(target), path.join(dir, name));
}

/** The child side: run the request's tests with Vitest, write their results. */
export async function vitestChild(requestFile: string): Promise<void> {
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as Request;
  const cb = Codebase.find(request.root);
  const run = fs.mkdtempSync(path.join(cb.lay.tcmDir, "test", "run-"));
  linkModules(path.join(cb.lay.tcmDir, "test", "node_modules"), path.join(cb.lay.cacheDir, "node_modules"), {
    vitest: request.vitest,
    ...(request.browser ? { "@vitest/browser-playwright": request.browser.provider } : {}),
  });
  const vitestImport = path.basename(request.vitest);
  const projects: Record<string, unknown>[] = [];
  if (request.node.length) {
    fs.writeFileSync(path.join(run, "node.test.ts"), testFile(run, cb.lay.cacheDir, vitestImport, request.node));
    projects.push({ test: { name: "node", include: ["node.test.ts"], environment: "node" } });
  }
  if (request.browserTests.length && request.browser) {
    fs.writeFileSync(path.join(run, "browser.test.ts"), testFile(run, cb.lay.cacheDir, vitestImport, request.browserTests));
    const { playwright } = (await import(pathToFileURL(path.join(request.browser.provider, "dist", "index.js")).href)) as { playwright: (o: unknown) => unknown };
    const unsaved = new Map(request.unsaved.map((r) => [r.hash, r]));
    projects.push({
      plugins: testPlugins(
        cb,
        request.browserTests.map((t) => t.hash),
        (h) => unsaved.get(h) ?? cb.store.getDef(h),
        (c) => {
          const stored = cb.store.componentMembers(c);
          return stored.length ? stored : request.unsaved.filter((r) => r.componentHash === c).sort((a, b) => a.componentIndex - b.componentIndex);
        },
      ),
      server: { fs: { allow: [cb.lay.tcmDir] } },
      test: {
        name: "browser",
        include: ["browser.test.ts"],
        // the Chrome that's installed: nothing to download
        browser: { enabled: true, headless: true, provider: playwright({ launchOptions: { channel: "chrome" } }), instances: [{ browser: "chromium" }] },
      },
    });
  }
  const { startVitest } = (await import(pathToFileURL(path.join(request.vitest, "dist", "node.js")).href)) as {
    startVitest: (filters: string[], options: Record<string, unknown>, vite: Record<string, unknown>) => Promise<VitestLike>;
  };
  const results: TestRun[] = [];
  let vitest: VitestLike | undefined;
  try {
    vitest = await startVitest([], { root: run, watch: false, reporters: [{ onUserConsoleLog() {} }], projects }, { configFile: false, logLevel: process.env.TCM_KEEP_TEST_RUN ? "info" : "silent" });
    if (process.env.TCM_KEEP_TEST_RUN) console.error(JSON.stringify(vitest.state.getFiles().map((f) => ({ tasks: f.tasks.length, errors: f.result?.errors })), null, 1));
    const ran = new Set<string>();
    for (const file of vitest.state.getFiles()) {
      for (const task of file.tasks) ran.add(task.name);
      // a file that couldn't load (a missing module, a syntax error) fails the tests it holds, with why
      const fileErrors = (file.result?.errors ?? []).map((e) => strip(e.message ?? String(e))).join("\n");
      if (fileErrors && !file.tasks.length) {
        for (const t of [...request.node, ...request.browserTests]) if (file.filepath?.includes(request.node.includes(t) ? "node.test" : "browser.test")) results.push({ hash: t.hash, ok: false, message: fileErrors, output: "", ms: 0 });
      }
      for (const task of file.tasks) {
        const errors = task.result?.errors ?? [];
        results.push({
          hash: task.name,
          ok: task.result?.state === "pass",
          // with the expected/actual diff, when there is one
          message: errors.map((e) => strip(`${e.message ?? String(e)}${e.diff ? `\n${e.diff}` : ""}`)).join("\n") || (task.result?.state === "pass" ? "" : `didn't run (${task.result?.state ?? "skipped"})`),
          output: (task.logs ?? []).map((l) => l.content.replace(/\n$/, "")).join("\n"),
          ms: Math.round(task.result?.duration ?? 0),
        });
      }
    }
  } finally {
    fs.writeFileSync(request.results, JSON.stringify(results));
    await vitest?.close();
    fs.rmSync(run, { recursive: true, force: true });
  }
}

interface VitestLike {
  state: {
    getUnhandledErrors?(): unknown[];
    getFiles(): {
      filepath?: string;
      tasks: { name: string; result?: { state?: string; duration?: number; errors?: { message?: string; diff?: string }[] }; logs?: { content: string }[] }[];
      result?: { errors?: { message?: string }[] };
    }[];
  };
  close(): Promise<void>;
}
