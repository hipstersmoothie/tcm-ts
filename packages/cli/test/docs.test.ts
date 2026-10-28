import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm docs "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);

test("docs are code: links, embeds and examples follow renames and updates, and broken examples are reported", () => {
  ucm("init");
  scratch(`// ucm: namespace lib
/** Square a number. */
export const square = (x: number): number => x * x;

/**
 * The sum of the {@link square}s of some numbers ({@link lib.square | squares}, that is).
 *
 * {@signature square}
 *
 * \`\`\`ts
 * sumSquares([1, 2, 3])
 * \`\`\`
 */
export const sumSquares = (xs: number[]): number => xs.map(square).reduce((a, b) => a + b, 0);

/**
 * Shows a square.
 *
 * \`\`\`ts
 * square(3)
 * show(4)
 * \`\`\`
 */
export const show = (n: number): string => \`\${n}² = \${square(n)}\\n(a square)\`;

/** Broken on purpose: links to {@link nowhere}. */
export const lonely = 1;
`);
  assert.match(ucm("add"), /warning: the doc of lonely refers to 'nowhere', which isn't in scope or in the codebase/);
  // examples can use the file's imports from outside the codebase too; JSDoc block tags render as markdown
  scratch(`// ucm: namespace lib
import { deepStrictEqual } from "node:assert";
import { square } from "#codebase/lib";
/**
 * Squares of a list.
 *
 * @param xs the numbers
 * @returns their squares, in order
 * @throws never
 *
 * \`\`\`ts
 * deepStrictEqual(squares([1, 2]), [1, 4])
 * squares([3])
 * \`\`\`
 */
export const squares = (xs: number[]): number[] => xs.map(square);

/**
 * A log. An example runs top to bottom, so a statement that matters only for its effect still runs:
 *
 * \`\`\`ts
 * const first = journal.push("a");
 * journal.length
 * \`\`\`
 */
export const journal: string[] = [];
`);
  const added = ucm("add");
  assert.doesNotMatch(added, /!/, "the examples typecheck");
  const squares = ucm("docs", "lib.squares");
  assert.match(squares, /\*\*Parameters\*\*\n\n- `xs` — the numbers\n/);
  assert.match(squares, /\*\*Returns\*\* their squares, in order/);
  assert.match(squares, /```text\n⧩ undefined\n```\n\n```text\n⧩ \[ 9 \]\n```/, "the assertion passed; the second value shown");
  assert.match(ucm("docs", "lib.journal"), /```text\n⧩ 1\n```/, "the push ran before the length was read");

  // links and embeds show names; examples are evaluated; a string result is shown as its text
  let doc = ucm("docs", "lib.sumSquares");
  assert.match(doc, /The sum of the `square`s of some numbers \(squares, that is\)\./);
  assert.match(doc, /`square : \(x: number\) => number`/);
  assert.match(doc, /```text\n⧩ 14\n```/);
  assert.match(ucm("docs", "lib.show"), /```text\n⧩ 9\n```\n\n```text\n4² = 16\n\(a square\)\n```/);

  // a rename: the doc says the new name, in prose, embeds and examples
  ucm("mv", "lib.square", "lib.sq");
  doc = ucm("docs", "lib.sumSquares");
  assert.match(doc, /The sum of the `sq`s/);
  assert.match(doc, /`sq : \(x: number\) => number`/);
  assert.match(ucm("docs", "lib.show"), /```ts\nsq\(3\)\nshow\(4\)\n```/);

  // an update: docs follow it (sumSquares is re-derived and keeps its doc), and examples run the new code
  scratch(`// ucm: namespace lib\nexport const sq = (x: number): number => x * x * 10;\n`);
  ucm("update");
  assert.match(ucm("docs", "lib.sumSquares"), /```text\n⧩ 140\n```/);
  assert.match(ucm("docs", "lib.show"), /⧩ 90/);

  // an update that breaks an example is reported (the example calls sq with a number)
  scratch(`// ucm: namespace lib\nexport const sq = (x: string): number => x.length;\n`);
  const update = ucm("update");
  assert.match(update, /! lib\.show: doc example: .*Argument of type 'number' is not assignable to parameter of type 'string'/);
  assert.match(ucm("docs", "lib.show"), /> ✗ this example doesn't typecheck: /);
});
