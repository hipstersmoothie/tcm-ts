import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm watch "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0 && args[0] !== "check") throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const scratch = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const waitFor = async (cond: () => boolean, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (cond()) return;
  throw new Error("timed out waiting");
};

test("watch results are cached by hash; --fresh re-runs; a changed dependency re-evaluates", () => {
  ucm("init");
  scratch("scratch.ts", `export const double = (x: number) => x * 2;\n\ndouble(21);\nMath.random();\n`);
  const first = ucm("check");
  assert.match(first, /double\(21\)\n\s+⧩ 42/);
  const random = /Math\.random\(\)\n\s+⧩ (\S+)/.exec(first)![1];

  const again = ucm("check");
  assert.match(again, /double\(21\)  \(cached\)\n\s+⧩ 42/);
  assert.equal(/Math\.random\(\)  \(cached\)\n\s+⧩ (\S+)/.exec(again)?.[1], random, "same hash, same value");

  assert.notEqual(/Math\.random\(\)\n\s+⧩ (\S+)/.exec(ucm("check", "--fresh"))?.[1], random, "--fresh evaluates again");

  // the watch's hash covers what it calls: change double and it's evaluated again
  scratch("scratch.ts", `export const double = (x: number) => x * 3;\n\ndouble(21);\n`);
  assert.match(ucm("check"), /double\(21\)\n\s+⧩ 63/);
});

test("the watcher re-checks incrementally and sees codebase changes made elsewhere", async () => {
  scratch("scratch.ts", `// ucm: namespace lib\nexport const greet = (name: string): string => "hi " + name;\n`);
  ucm("add");
  fs.rmSync(path.join(dir, "scratch.ts"));
  scratch("app.ts", `import { greet } from "#codebase/lib";\n\ngreet("ada");\n`);

  const child = spawn(process.execPath, [BIN, "watch"], { cwd: dir, env });
  children.push(child);
  let out = "";
  const plain = (d: string) => (out += d.replace(/\x1b\[[0-9;]*m/g, ""));
  child.stdout.setEncoding("utf8").on("data", plain);
  child.stderr.setEncoding("utf8").on("data", plain);
  await waitFor(() => /⧩ 'hi ada'/.test(out));

  // a type error, then its fix, in quick succession
  out = "";
  scratch("app.ts", `import { greet } from "#codebase/lib";\n\ngreet(42);\n`);
  await waitFor(() => /Argument of type 'number' is not assignable/.test(out));
  out = "";
  scratch("app.ts", `import { greet } from "#codebase/lib";\n\ngreet("grace");\n`);
  await waitFor(() => /⧩ 'hi grace'/.test(out));

  // another process updates greet (its cache module and the shim change on disk): the watcher sees the new code
  scratch("lib.ts", `// ucm: namespace lib\nexport const greet = (name: string, loud = false): string => (loud ? "HI " : "hi ") + name;\n`);
  ucm("update", "lib.ts");
  fs.rmSync(path.join(dir, "lib.ts"));
  await new Promise((r) => setTimeout(r, 300)); // let the watcher settle on lib.ts's own change and removal
  out = "";
  scratch("app.ts", `import { greet } from "#codebase/lib";\n\ngreet("linus", true);\n`);
  await waitFor(() => /⧩ 'HI linus'/.test(out));
  assert.doesNotMatch(out, /Expected 1 arguments/);
});
