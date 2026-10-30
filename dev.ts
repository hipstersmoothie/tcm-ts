import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { TS_VERSION } from "./core/src/program.ts";
import { analyzeProject } from "./core/src/analyze.ts";
import { STYLE } from "./site.tsx";
import { staticPage, renderPage, SOURCES, highlighter, pageList } from "./site.tsx";

/**
 * tcm's repository: up from here, the directory with its workspace. (Files kept outside the codebase, while some are.)
 */
export function repository(): string {
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    if (path.dirname(d) === d) throw new Error(`${process.cwd()} isn't in tcm's repository`);
  }
}

/**
 * Run a program to the end: whether it passed, and what it printed.
 */
export function sh(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string } {
  const r = spawnSync(program, args, { cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env }, encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

/**
 * tcm's own codebase, in the repository (where its tcm commands run).
 */
export const codebaseDir = (): string => path.join(repository(), "codebase");

/**
 * Everything a change to tcm must pass, run from its codebase (`pnpm verify`, which is `pnpm tcm run
 * tcmts.dev.verify`), with the codebase's own tcm:
 *
 * 1. nothing needs fixing (`tcm todo`), and every definition renders and re-hashes to itself (`tcm verify`);
 * 2. while the codebase is mirrored to the repository, the files hash to what it holds (`tcm mirror --check`, the
 *    fixed point: this tcm reads its own source as the codebase it is) and typecheck;
 * 3. its tests pass (`tcm test`: the test definitions, and the end-to-end tests, each run against this tcm),
 *    run again only where code they ran changed;
 * 4. its docs (tcmts.docs) build into the site, every link and anchor resolving;
 * 5. the tcm-ts package packed from it installs, works far from the repository, and passes the end-to-end
 *    tests too (`tcm test --bin`), likewise run again only where code changed.
 *
 * When all of that passes, the package is the known-good tcm that `pnpm tcm` runs (dist/known-good).
 */
export async function verify(): Promise<void> {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const codebase = codebaseDir();
  const repo = repository();
  const started = Date.now();
  let failed = false;
  const step = (name: string, show: RegExp, run: () => { ok: boolean; out: string }) => {
    const t0 = Date.now();
    const r = run();
    console.log(`${name}: ${r.ok ? "ok" : "FAILED"} (${Math.round((Date.now() - t0) / 1000)}s)`);
    const lines = r.out.split("\n");
    for (const l of lines.filter((l) => show.test(l))) console.log(`  ${l.trim()}`);
    if (!r.ok) for (const l of lines.filter((l) => /^\s*✗ /.test(l) || /error|failed/i.test(l)).slice(0, 30)) console.log(`  ${l.trim()}`);
    failed ||= !r.ok;
    return r.ok;
  };
  const run = (...args: string[]) => sh(process.execPath, [tcm, ...args], codebase);

  step("codebase", /nothing to do|verified/, () => {
    const todo = run("todo");
    const identity = run("verify");
    return { ok: todo.ok && /nothing to do/.test(todo.out) && identity.ok, out: `${todo.out}\n${identity.out}` };
  });
  step("files", /the files hash|difference/, () => {
    const mirror = run("mirror", "--check");
    const typecheck = sh(path.join(repo, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], repo);
    return { ok: mirror.ok && typecheck.ok, out: `${mirror.out}\n${typecheck.out}` };
  });
  step("tests", /^(\d+ passed|suites:)/, () => run("test", "tcmts"));
  const docs = await buildSite(fs.mkdtempSync(path.join(os.tmpdir(), "tcm site ")));
  const docsOut = docs.problems.length ? docs.problems.join("\n") : `${docs.pages} pages, every link and anchor resolving`;
  step("docs", /pages|link/, () => ({ ok: !docs.problems.length, out: docsOut }));

  const dist = path.join(repo, "dist");
  const candidate = path.join(dist, "candidate");
  const bin = path.join(candidate, "node_modules", "tcm-ts", "bin", "tcm.js");
  const packed = step("package", /^(installed|far away|\d+ passed|suites:)/, () => {
    const out = path.join(dist, "package");
    fs.rmSync(candidate, { recursive: true, force: true });
    fs.mkdirSync(candidate, { recursive: true });
    const steps = [
      () => run("pack", "tcm-ts", "--out", out),
      () => sh("npm", ["pack", "--silent", "--pack-destination", candidate], out),
      () => sh("npm", ["init", "-y"], candidate),
      () => sh("npm", ["install", ...fs.readdirSync(candidate).filter((f) => f.endsWith(".tgz")).map((f) => `./${f}`), "--no-audit", "--no-fund", "--loglevel=error"], candidate),
    ];
    let log = "";
    for (const s of steps) {
      const r = s();
      log += r.out;
      if (!r.ok) return { ok: false, out: log };
    }
    log += `installed tcm-ts, packed from the codebase, in ${path.relative(repo, candidate)}\n`;
    // far from the repository: nothing it needs is found by walking up to its node_modules
    const far = fs.mkdtempSync(path.join(os.tmpdir(), "tcm far "));
    const init = sh(process.execPath, [bin, "init"], far);
    fs.writeFileSync(path.join(far, "scratch.ts"), "export const platform = () => process.platform;\n");
    const add = sh(process.execPath, [bin, "add"], far);
    if (!init.ok || !add.ok) return { ok: false, out: `${log}${init.out}${add.out}` };
    log += `far away: the packed tcm makes a codebase in ${far} and checks code against @types/node there\n`;
    const tests = run("test", "tcmts", "--bin", `tcm=${bin}`);
    return { ok: tests.ok, out: `${log}${tests.out}` };
  });

  // the tcm that runs on tcm's codebase from now on: what was just verified
  if (!failed && packed) {
    const git = (...args: string[]) => sh("git", ["-C", repo, ...args], repo);
    const commit = git("rev-parse", "--short", "HEAD").out.trim();
    const changed = !git("diff", "--quiet", "HEAD").ok;
    fs.writeFileSync(path.join(candidate, "VERIFIED"), `${commit}${changed ? " with changes" : ""}, verified ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`);
    const good = path.join(dist, "known-good");
    fs.rmSync(good, { recursive: true, force: true });
    fs.renameSync(candidate, good);
    console.log(`known-good tcm: ${fs.readFileSync(path.join(good, "VERIFIED"), "utf8").trim()}; pnpm tcm and the MCP server run it`);
  }
  console.log(`${failed ? "FAILED" : "all passed"} in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = failed ? 1 : 0;
}

/**
 * Build the docs site into `out`: the site's pages ({@link SOURCES}: tcm's docs and the examples page, as the
 * codebase has them), as plain, text-file-looking HTML, the same markup the app renders. Pages are ordered by the
 * index's tables, numbered like sections of a text file, with a numbered menu down the side. Every relative link
 * and anchor must resolve: what doesn't is a problem, so the docs can't quietly rot.
 */
export async function buildSite(out: string): Promise<{ pages: number; problems: string[] }> {
  const repo = repository();
  const pages = pageList(SOURCES["docs/README.md"]!);
  const hl = await highlighter();
  const problems: string[] = [];
  const anchors = new Map<string, Set<string>>();
  const links: { from: string; file: string; anchor?: string; text: string }[] = [];
  const version = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "style.css"), STYLE);
  for (const page of pages) {
    const md = SOURCES[page.src];
    if (md === undefined) {
      problems.push(`${page.src}: the index lists it, and it isn't one of the site's pages (tcmts.site.SOURCES)`);
      continue;
    }
    const r = renderPage(page, pages, md, hl, (src) => fs.existsSync(path.join(repo, src)), false);
    anchors.set(page.file, new Set(r.ids));
    problems.push(...r.problems.map((p) => `${page.src}: ${p}`));
    links.push(...r.links.map((l) => ({ from: page.src, ...l })));
    fs.writeFileSync(path.join(out, page.file), staticPage(page, pages, r, version));
  }
  for (const l of links) {
    if (l.anchor && !anchors.get(l.file)?.has(l.anchor)) problems.push(`${l.from}: link to ${l.text}: no heading #${l.anchor} there`);
  }
  return { pages: pages.length, problems };
}

/**
 * Build the docs site (`pnpm docs:site`, which is `pnpm tcm run tcmts.dev.site`) into `out`, dist/site by default.
 */
export async function site(out?: string): Promise<void> {
  const to = path.resolve(out ?? path.join(repository(), "dist", "site"));
  const r = await buildSite(to);
  for (const p of r.problems) console.error(`docs site: ${p}`);
  if (!r.problems.length) console.log(`docs site: ${r.pages} pages in ${path.relative(process.cwd(), to) || to}`);
  process.exitCode = r.problems.length ? 1 : 0;
}

/**
 * Hashes don't depend on the compiler (`pnpm compare-compilers`): tcm's source hashed with TypeScript 7 and with
 * tsrs (TypeScript 7 in Rust, installed into a temporary directory) must be the same, and the golden hashes must
 * pass with tsrs too.
 */
export function compareCompilers(): void {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcm tsrs "));
  fs.writeFileSync(path.join(tmp, "package.json"), '{"private":true}\n');
  const installed = sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "tsrs"], tmp);
  if (!installed.ok) throw new Error(`installing tsrs: ${installed.out}`);
  const tsrs = sh(process.execPath, ["--input-type=module", "-e", 'import("./node_modules/tsrs/lib/getExePath.js").then((m) => console.log(m.default()))'], tmp).out.trim();
  const hashes = (env: NodeJS.ProcessEnv) => {
    const r = sh(process.execPath, [tcm, "run", "tcmts.dev.hashProject", repository()], codebaseDir(), env);
    if (!r.ok) throw new Error(r.out);
    return r.out.split("\n").filter((l) => /^\S+:\S+ [a-z2-7]+$/.test(l));
  };
  const ours = hashes({});
  const theirs = hashes({ TCM_TYPESCRIPT: tsrs });
  const differ = ours.filter((l, i) => l !== theirs[i]);
  if (differ.length || ours.length !== theirs.length) {
    console.log(`hashes differ: ${differ.slice(0, 10).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`identical hashes (${ours.length} definitions)`);
  const golden = sh(process.execPath, [tcm, "test", "tcmts.core.test", "--definitions", "--fresh"], codebaseDir(), { TCM_TYPESCRIPT: tsrs });
  console.log(`golden hashes with tsrs: ${golden.out.trim().split("\n").at(-1)}`);
  process.exitCode = golden.ok ? 0 : 1;
}

/**
 * Print `<file>:<name> <hash>` for every definition of the project in `dir` (tcm's repository by default), as this
 * process's compiler hashes it: with TCM_TYPESCRIPT, another one (`compareCompilers`).
 */
export function hashProject(dir?: string): void {
  const root = path.resolve(dir ?? repository());
  // (not tests, directories of files kept as written (examples), builds, or codebases)
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return ["node_modules", "test", "dist"].includes(e.name) || e.name.startsWith(".") || fs.existsSync(path.join(p, ".tcm-files")) || fs.existsSync(path.join(p, ".tcm")) ? [] : walk(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
    });
  const a = analyzeProject(walk(root), { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "tcm-hash-")), resolveName: () => "" });
  if (a.errors.length || a.diagnostics.length) {
    console.error([...a.errors, ...a.diagnostics.map((d) => d.formatted)].join("\n"));
    process.exitCode = 1;
    return;
  }
  console.error(`typescript ${TS_VERSION}: ${a.defs.length} definitions`);
  for (const d of a.defs.map((d) => `${path.relative(root, d.file)}:${d.nameHint} ${d.hash}`).sort()) console.log(d);
}

/**
 * Deploy tcm's server: `tcm serve` of tcm's codebase, and the docs site, on Railway (`server/`). What's uploaded is
 * the server's files, the known-good tcm's package (the build the last passing `pnpm verify` tested) and the docs
 * site built from the codebase, to the `tcm-server` service of the Railway project the repository is linked to
 * (`railway link`). `pnpm server:deploy`.
 */
export async function deployServer(): Promise<void> {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const repo = repository();
  const good = path.join(repo, "dist", "known-good");
  const tgz = fs.existsSync(good) ? fs.readdirSync(good).find((f) => f.endsWith(".tgz")) : undefined;
  if (!tgz) throw new Error("no known-good tcm to deploy: `pnpm verify` makes one");
  // the project and environment the repository is linked to (uploading from elsewhere, railway needs them said)
  const status = sh("railway", ["status", "--json"], repo);
  if (!status.ok) throw new Error(`railway status: ${status.out.trim()} (link the repository with \`railway link\`)`);
  const linked = JSON.parse(status.out.slice(status.out.indexOf("{"))) as { id: string; environments: { edges: { node: { id: string; name: string } }[] } };
  const environment = linked.environments.edges.find((e) => e.node.name === "production")?.node.id;
  if (!environment) throw new Error("the linked Railway project has no production environment");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-server-"));
  const files = sh(process.execPath, [tcm, "export", "tcmts.server", stage], codebaseDir());
  if (!files.ok) throw new Error(`tcm export tcmts.server: ${files.out.trim()}`);
  fs.copyFileSync(path.join(good, tgz), path.join(stage, "tcm-ts.tgz"));
  const site = await buildSite(path.join(stage, "site"));
  if (site.problems.length) throw new Error(`docs site:\n${site.problems.join("\n")}`);
  const up = sh("railway", ["up", "--project", linked.id, "--environment", environment, "--service", "tcm-server", "--detach", "--yes"], stage);
  console.log(up.out.trim());
  if (up.ok) console.log(`deploying the known-good tcm: ${fs.readFileSync(path.join(good, "VERIFIED"), "utf8").trim()}`);
  process.exitCode = up.ok ? 0 : 1;
}

/**
 * Bring the repository up to tcm's server, for GitHub (a mirror of it): pull from `origin` (the mirror writes what
 * changed into the files, as edits), then commit them, with a message listing the history entries since the last
 * such commit (which its `tcm-causal:` trailer names). Pushing to GitHub is by hand. Refuses while the repository has
 * changes git doesn't have yet, so a commit only ever holds what came from the server. `pnpm mirror:commit`.
 */
export function mirrorCommit(): void {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const repo = repository();
  const git = (...args: string[]) => sh("git", ["-C", repo, ...args], repo);
  if (git("status", "--porcelain").out.trim()) throw new Error("the repository has changes git doesn't have yet: commit or stash them first");
  const tcmIn = (...args: string[]) => sh(process.execPath, [tcm, ...args], codebaseDir());
  const pulled = tcmIn("pull", "origin");
  if (!pulled.ok) throw new Error(`tcm pull origin: ${pulled.out.trim()}`);
  console.log(pulled.out.trim());
  if (!git("status", "--porcelain").out.trim()) {
    console.log("the repository is up to date with tcm's server");
    return;
  }
  // the entries since the last commit made from the server: `#hash  n  date  command`, then what each changed
  const since = /tcm-causal: #?(\w+)/.exec(git("log", "-1", "--format=%B", "--grep=^tcm-causal:").out)?.[1];
  const entries: { hash: string; command: string; changes: string[] }[] = [];
  for (const line of tcmIn("history", "200").out.split("\n")) {
    const head = /^#(\w+)\s+\d+\s+\S+ \S+\s+(.*)$/.exec(line);
    if (head) {
      if (since && head[1] === since) break;
      entries.push({ hash: head[1]!, command: head[2]!, changes: [] });
    } else if (line.startsWith("    ") && entries.length) entries.at(-1)!.changes.push(line.trim());
  }
  const subject = entries.length === 1 ? entries[0]!.command : `${entries.length} changes from tcm's server`;
  const body = entries.map((e) => [`${e.command}`, ...e.changes.slice(0, 20).map((c) => `  ${c}`), ...(e.changes.length > 20 ? [`  and ${e.changes.length - 20} more`] : [])].join("\n")).join("\n\n");
  git("add", "-A");
  const committed = git("commit", "-q", "-m", `${subject}\n\n${body}\n\ntcm-causal: #${entries[0]?.hash ?? since}`);
  if (!committed.ok) throw new Error(`git commit: ${committed.out.trim()}`);
  console.log(`committed ${git("log", "-1", "--format=%h %s").out.trim()}; push it to GitHub by hand`);
}
