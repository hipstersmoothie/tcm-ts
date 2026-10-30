// Watch expressions in scratch files: results cached by hash, and `tcm watch` re-checking as files change.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { plainEnv, strip, tcmBin, tcmIn, tempDir, withChildren } from "./harness.ts";

/** A new codebase, and a way to run tcm in it (failing the test if it fails, except for check). */
function setUp() {
  const dir = tempDir("watch");
  const tcm = (...args: string[]): string => {
    const r = tcmIn(dir, ...args);
    if (r.status !== 0 && args[0] !== "check") throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
    return r.out;
  };
  const scratch = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  tcm("init");
  return { dir, tcm, scratch };
}
const waitFor = async (cond: () => boolean, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (cond()) return;
  throw new Error("timed out waiting");
};

/** Watch results are cached by hash; --fresh re-runs; a changed dependency re-evaluates. */
export const testWatchResultsCachedByHash = () => {
  const { tcm, scratch } = setUp();
  scratch("scratch.ts", `export const double = (x: number) => x * 2;\n\ndouble(21);\nMath.random();\n`);
  const first = tcm("check");
  assert.match(first, /double\(21\)\n\s+⧩ 42/);
  const random = /Math\.random\(\)\n\s+⧩ (\S+)/.exec(first)![1];

  const again = tcm("check");
  assert.match(again, /double\(21\)  \(cached\)\n\s+⧩ 42/);
  assert.equal(/Math\.random\(\)  \(cached\)\n\s+⧩ (\S+)/.exec(again)?.[1], random, "same hash, same value");

  assert.notEqual(/Math\.random\(\)\n\s+⧩ (\S+)/.exec(tcm("check", "--fresh"))?.[1], random, "--fresh evaluates again");

  // the watch's hash covers what it calls: change double and it's evaluated again
  scratch("scratch.ts", `export const double = (x: number) => x * 3;\n\ndouble(21);\n`);
  assert.match(tcm("check"), /double\(21\)\n\s+⧩ 63/);
};

/** The watcher re-checks incrementally and sees codebase changes made elsewhere. */
export const testWatcherSeesChangesMadeElsewhere = () =>
  withChildren(async (keep) => {
    const { dir, tcm, scratch } = setUp();
    scratch("scratch.ts", `// tcm: namespace lib\nexport const greet = (name: string): string => "hi " + name;\n`);
    tcm("add");
    fs.rmSync(path.join(dir, "scratch.ts"));
    scratch("app.ts", `import { greet } from "#codebase/lib";\n\ngreet("ada");\n`);

    const child = keep(spawn(process.execPath, [tcmBin(), "watch"], { cwd: dir, env: plainEnv() }));
    let out = "";
    const plain = (d: string) => (out += strip(d));
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
    scratch("lib.ts", `// tcm: namespace lib\nexport const greet = (name: string, loud = false): string => (loud ? "HI " : "hi ") + name;\n`);
    tcm("update", "lib.ts");
    fs.rmSync(path.join(dir, "lib.ts"));
    await new Promise((r) => setTimeout(r, 300)); // let the watcher settle on lib.ts's own change and removal
    out = "";
    scratch("app.ts", `import { greet } from "#codebase/lib";\n\ngreet("linus", true);\n`);
    await waitFor(() => /⧩ 'HI linus'/.test(out));
    assert.doesNotMatch(out, /Expected 1 arguments/);
  });
