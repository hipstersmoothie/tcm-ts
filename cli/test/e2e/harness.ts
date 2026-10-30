// Helpers for tcm's end-to-end tests: test definitions that run tcm as people do, as a program. In a codebase
// `tcm test` runs each as a program of its own against the codebase's own tcm (TCM_BIN), cached by the code it
// ran.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";

/** The tcm under test: `tcm test` sets TCM_BIN to the codebase's own build. */
export function tcmBin(): string {
  const bin = process.env.TCM_BIN;
  if (!bin) throw new Error("TCM_BIN isn't set: it names the tcm these tests run");
  return path.resolve(bin);
}

/** The environment tcm runs in here: no colours, so its output reads as text. */
export const plainEnv = (): NodeJS.ProcessEnv => ({ ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" });

/** Text without terminal escapes. */
export const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** A new empty directory, resolved through symlinks; the space in its name catches quoting bugs. */
export const tempDir = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tcm ${name} `)));

/** Run tcm in `dir`: its exit status, and what it printed on both streams. */
export function tcmIn(dir: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [tcmBin(), ...args], { cwd: dir, encoding: "utf8", env: plainEnv() });
  return { status: r.status, out: strip(r.stdout + r.stderr) };
}

/** Run tcm in `dir`, failing the test if it fails: what it printed. */
export function okIn(dir: string, ...args: string[]): string {
  const r = tcmIn(dir, ...args);
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
}

/** Run `fn` with a way to keep the processes it starts (servers, watchers), and kill them when it's done. */
export async function withChildren<T>(fn: (keep: <C extends ChildProcess>(c: C) => C) => Promise<T> | T): Promise<T> {
  const kept: ChildProcess[] = [];
  try {
    return await fn((c) => (kept.push(c), c));
  } finally {
    for (const c of kept) c.kill();
  }
}

/**
 * A path in tcm's repository (`examples/notes`, `vscode`): TCM_REPO if set, or the nearest directory up from here
 * that has it (`tcm test` runs these in tcm's codebase, inside the repository).
 */
export function repoPath(rel: string): string {
  if (process.env.TCM_REPO) return path.join(process.env.TCM_REPO, rel);
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, rel))) return path.join(d, rel);
    if (path.dirname(d) === d) throw new Error(`no ${rel} in a directory above ${process.cwd()}`);
  }
}
