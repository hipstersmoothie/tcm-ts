import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";

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
 * Everything a change to tcm must pass, run from its codebase (`pnpm verify`, which is `pnpm tcm run
 * tcmts.dev.verify`), with the codebase's own tcm:
 *
 * 1. nothing needs fixing (`tcm todo`), and every definition renders and re-hashes to itself (`tcm verify`);
 * 2. while the codebase is mirrored to packages/, the files hash to what it holds (`tcm mirror --check`, the
 *    fixed point: this tcm reads its own source as the codebase it is) and typecheck;
 * 3. its tests pass (`tcm test`: the test definitions, and the end-to-end tests, each run against this tcm),
 *    run again only where code they ran changed;
 * 4. the tcm-ts package packed from it installs, works far from the repository, and passes the end-to-end
 *    tests too (`tcm test --bin`), likewise run again only where code changed.
 *
 * When all of that passes, the package is the known-good tcm that `pnpm tcm` runs (dist/known-good).
 */
export function verify(): void {
  const tcm = process.env.TCM_BIN;
  if (!tcm) throw new Error("run this with `tcm run`, which gives it the codebase's own tcm (TCM_BIN)");
  const codebase = process.cwd();
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
    const changed = !git("diff", "--quiet", "HEAD", "--", "packages").ok;
    fs.writeFileSync(path.join(candidate, "VERIFIED"), `${commit}${changed ? " with changes" : ""}, verified ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`);
    const good = path.join(dist, "known-good");
    fs.rmSync(good, { recursive: true, force: true });
    fs.renameSync(candidate, good);
    console.log(`known-good tcm: ${fs.readFileSync(path.join(good, "VERIFIED"), "utf8").trim()}; pnpm tcm and the MCP server run it`);
  }
  console.log(`${failed ? "FAILED" : "all passed"} in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = failed ? 1 : 0;
}
