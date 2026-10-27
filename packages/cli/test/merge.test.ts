import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm merge "));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
}
function ucm(...args: string[]): string {
  const r = run(...args);
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
}
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
const hashesAt = (name: string) => [...ucm("ls", name).matchAll(new RegExp(`^${name.replace(".", "\\.")}\\s+#([a-z2-7]+)`, "gm"))].map((m) => m[1]);

test("three-way merge: one-sided changes combine, real conflicts stay conflicts, code follows the other side", () => {
  ucm("init");
  ucm("add");
  scratch(`// ucm: namespace lib
import { square } from "#codebase";
export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 0);
export const report = (xs: number[]) => \`sum: \${sumSquares(xs)}\`;
`);
  ucm("add");
  ucm("branch", "feature");

  ucm("switch", "feature");
  scratch(`export const square = (x: number): number => x * x * 10;\n`);
  ucm("update"); // also re-hashes sumSquares and report on feature, without editing them
  scratch(`// ucm: namespace lib\nimport { sumSquares } from "#codebase/lib";\nexport const fromFeature = 1;\nexport const report = (xs: number[]) => \`feature: \${sumSquares(xs)}\`;\n`);
  ucm("update");

  ucm("switch", "main");
  scratch(`// ucm: namespace lib
import { square } from "#codebase";
export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 100);
export const report = (xs: number[]) => \`main: \${sumSquares(xs)}\`;
export const fromMain = 2;
`);
  ucm("update");

  const merged = run("merge", "feature");
  assert.equal(merged.status, 1, "a conflict makes merge exit non-zero");
  assert.match(merged.out, /conflict lib\.report/);
  assert.doesNotMatch(merged.out, /conflict lib\.sumSquares/, "feature only re-hashed sumSquares; main's edit wins");
  assert.match(merged.out, /\+ lib\.fromFeature/);
  assert.equal(hashesAt("lib.report").length, 2, "propagation must not silently resolve the conflict");
  assert.equal(hashesAt("lib.sumSquares").length, 1);

  // main's sumSquares (+100) now runs against feature's square (*10): (1 + 4) * 10 + 100
  scratch(`// ucm: namespace lib\nimport { sumSquares } from "#codebase/lib";\nexport const probe = () => sumSquares([1, 2]);\n`);
  ucm("add");
  assert.equal(ucm("run", "lib.probe").trim(), "150");

  ucm("resolve", "lib.report", `#${hashesAt("lib.report")[0]}`);
  assert.match(ucm("todo"), /nothing to do/);

  // the merge base moved: merging again brings nothing, and later feature changes come in alone
  assert.match(ucm("merge", "feature"), /no changes/);
  ucm("switch", "feature");
  scratch(`// ucm: namespace lib\nexport const later = 3;\n`);
  ucm("add");
  ucm("switch", "main");
  const again = ucm("merge", "feature");
  assert.match(again, /added\s+\+ lib\.later/);
  assert.doesNotMatch(again, /conflict/);
});
