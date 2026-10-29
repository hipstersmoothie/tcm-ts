import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Definitions that refer to each other are hashed as one, so they're edited and updated together.

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

test("a cycle is edited and updated whole: no member is left using an old one", () => {
  ok("init");
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nexport function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }\nexport function isOdd(n: number): boolean { const unused = 1; return n === 0 ? false : isEven(n - 1); }\n`);
  assert.match(ok("add"), /'unused' is declared but never used/);

  // replacing one member alone is refused: the other would go on using the old one
  fs.writeFileSync(path.join(dir, "partial.ts"), `// tcm: namespace lib\nimport { isOdd } from "#codebase/lib";\nexport function isEven(n: number): boolean { console.log("even", n); return n === 0 ? true : isOdd(n - 1); }\n`);
  const partial = tcm("update", "partial.ts");
  assert.notEqual(partial.status, 0);
  assert.match(partial.out, /lib\.isEven refers to lib\.isOdd and back .* `tcm edit lib\.isEven` writes them all/);

  // edit brings the whole cycle, so both are updated together (scratch.ts holds only what's saved, so edit can
  // write over it; partial.ts holds work, so it can't)
  assert.match(tcm("edit", "--file", "partial.ts", "lib.isEven").out, /partial\.ts is not empty/);
  assert.match(ok("edit", "lib.isEven"), /with lib\.isOdd: it refers to it and back/);
  const scratch = path.join(dir, "scratch.ts");
  assert.match(fs.readFileSync(scratch, "utf8"), /function isOdd/);
  fs.writeFileSync(scratch, fs.readFileSync(scratch, "utf8").replace("return n === 0 ? true : isOdd(n - 1);", `console.log("even", n);\n  return n === 0 ? true : isOdd(n - 1);`));
  // only what changed is linted: isOdd is re-hashed with isEven, but its code is as it was
  assert.doesNotMatch(ok("check"), /unused/);
  const updated = ok("update");
  assert.match(updated, /~ update +lib\.isEven/);
  assert.match(updated, /~ update +lib\.isOdd/);
  assert.doesNotMatch(updated, /unused/);
  assert.equal(ok("run", "lib.isOdd", "3"), "even 2\neven 0\ntrue\n", "isOdd runs the new isEven");
});
