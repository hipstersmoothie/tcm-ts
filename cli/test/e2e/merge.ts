// Three-way merges of branches: one-sided changes combine, real conflicts stay conflicts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { okIn, tcmIn, tempDir } from "./harness.ts";

/** Three-way merge: one-sided changes combine, real conflicts stay conflicts, code follows the other side. */
export const testThreeWayMerge = () => {
  const dir = tempDir("merge");
  const run = (...args: string[]) => tcmIn(dir, ...args);
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
  const hashesAt = (name: string) => [...tcm("ls", name).matchAll(new RegExp(`^${name.replace(".", "\\.")}\\s+#([a-z2-7]+)`, "gm"))].map((m) => m[1]);
  tcm("init");
  tcm("add");
  scratch(`// tcm: namespace lib
import { square } from "#codebase";
export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 0);
export const report = (xs: number[]) => \`sum: \${sumSquares(xs)}\`;
`);
  tcm("add");
  tcm("branch", "feature");

  tcm("switch", "feature");
  scratch(`export const square = (x: number): number => x * x * 10;\n`);
  tcm("update"); // also re-hashes sumSquares and report on feature, without editing them
  scratch(`// tcm: namespace lib\nimport { sumSquares } from "#codebase/lib";\nexport const fromFeature = 1;\nexport const report = (xs: number[]) => \`feature: \${sumSquares(xs)}\`;\n`);
  tcm("update");

  tcm("switch", "main");
  scratch(`// tcm: namespace lib
import { square } from "#codebase";
export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 100);
export const report = (xs: number[]) => \`main: \${sumSquares(xs)}\`;
export const fromMain = 2;
`);
  tcm("update");

  const merged = run("merge", "feature");
  assert.equal(merged.status, 1, "a conflict makes merge exit non-zero");
  assert.match(merged.out, /conflict lib\.report/);
  assert.doesNotMatch(merged.out, /conflict lib\.sumSquares/, "feature only re-hashed sumSquares; main's edit wins");
  assert.match(merged.out, /\+ lib\.fromFeature/);
  assert.equal(hashesAt("lib.report").length, 2, "propagation must not silently resolve the conflict");
  assert.equal(hashesAt("lib.sumSquares").length, 1);

  // main's sumSquares (+100) now runs against feature's square (*10): (1 + 4) * 10 + 100
  scratch(`// tcm: namespace lib\nimport { sumSquares } from "#codebase/lib";\nexport const probe = () => sumSquares([1, 2]);\n`);
  tcm("add");
  assert.equal(tcm("run", "lib.probe").trim(), "150");

  tcm("resolve", "lib.report", `#${hashesAt("lib.report")[0]}`);
  assert.match(tcm("todo"), /nothing to do/);

  // the merge base moved: merging again brings nothing, and later feature changes come in alone
  assert.match(tcm("merge", "feature"), /no changes/);
  tcm("switch", "feature");
  scratch(`// tcm: namespace lib\nexport const later = 3;\n`);
  tcm("add");
  tcm("switch", "main");
  const again = tcm("merge", "feature");
  assert.match(again, /added\s+\+ lib\.later/);
  assert.doesNotMatch(again, /conflict/);
};
