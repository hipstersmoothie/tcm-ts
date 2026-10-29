import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Definitions that refer to each other are hashed as one, so they're updated together: changing some saves the
// rest with them.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm cycles ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const tcm = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
};
const ok = (...args: string[]) => {
  const r = tcm(...args);
  assert.equal(r.status, 0, r.out);
  return r.out;
};

test("a cycle is updated whole: changing one member saves the rest with it, so none uses an old one", () => {
  ok("init");
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nexport function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }\nexport function isOdd(n: number): boolean { const unused = 1; return n === 0 ? false : isEven(n - 1); }\n`);
  assert.match(ok("add"), /'unused' is declared but never used/);

  // a file changing one member, using the other from the codebase: the other is saved with it, as it is
  fs.writeFileSync(path.join(dir, "partial.ts"), `// tcm: namespace lib\nimport { isOdd } from "#codebase/lib";\nexport function isEven(n: number): boolean { console.log("even", n); return n === 0 ? true : isOdd(n - 1); }\n`);
  const partial = ok("update", "partial.ts");
  assert.match(partial, /with lib\.isOdd: in a cycle with what changed, so saved with it, as it is/);
  assert.match(partial, /~ update +lib\.isEven[\s\S]*~ update +lib\.isOdd/);
  // (only what changed is linted: isOdd is re-hashed with isEven, but its code is as it was)
  assert.doesNotMatch(partial, /unused/);
  assert.equal(ok("run", "lib.isOdd", "3"), "even 2\neven 0\ntrue\n", "isOdd runs the new isEven");

  // edit writes only what's asked for, and says what it's in a cycle with (scratch.ts holds the versions just
  // replaced, which aren't saved as they are, so it takes --force)
  assert.match(tcm("edit", "lib.isEven").out, /scratch\.ts is not empty/);
  assert.match(ok("edit", "--force", "lib.isEven"), /in a cycle with lib\.isOdd: saving it saves that too, as it is/);
  const scratch = path.join(dir, "scratch.ts");
  assert.doesNotMatch(fs.readFileSync(scratch, "utf8"), /function isOdd/);
  fs.writeFileSync(scratch, fs.readFileSync(scratch, "utf8").replace(`console.log("even", n);`, `console.log("even:", n);`));
  assert.match(ok("check"), /with lib\.isOdd: in a cycle with what changed[\s\S]*~ update +lib\.isOdd/);
  assert.match(ok("update"), /~ update +lib\.isEven[\s\S]*~ update +lib\.isOdd/);
  assert.equal(ok("run", "lib.isOdd", "1"), "even: 0\ntrue\n");
});
