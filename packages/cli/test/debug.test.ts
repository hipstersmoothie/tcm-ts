import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Definitions as files (.tcm/src), and source maps from every generated module to them: stack traces point at
// the code you read, a definition's view or the scratch file it's still in, to the column.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm debug ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
};
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const src = (file: string) => path.join(dir, ".tcm", "src", file);

test("stack traces point at definitions: their files in .tcm/src, or the scratch file", () => {
  run("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  write("lib.ts", `// tcm: namespace lib\n/** Halves. */\nexport function half(n: number): number {\n  if (n < 0) {\n    throw new Error("negative");\n  }\n  return n / 2;\n}\nexport const main = () => half(-1);\n`);
  run("add", "lib.ts");
  // each definition is a file, exactly as the editor shows it
  const view = fs.readFileSync(src("lib/half.ts"), "utf8");
  assert.match(view, /^\/\/ lib\.half #\w+\n\/\*\*\n \* Halves\.\n \*\/\nexport function half\(n: number\): number \{/);

  const out = run("run", "lib.main");
  assert.ok(out.includes(`at half (${src("lib/half.ts")}:7:11)`), out);
  assert.ok(out.includes(`at main (${src("lib/main.ts")}:4:27)`), "past the `export ` the view adds");

  // code tcm compiles itself (JSX) keeps its map through the compilation
  write("ui.tsx", `// tcm: namespace ui\nexport function Card({ n }: { n: number }) {\n  if (n < 0) {\n    throw new Error("bad card");\n  }\n  return <p>{n}</p>;\n}\nexport const show = () => Card({ n: -1 });\n`);
  run("add", "ui.tsx");
  assert.ok(run("run", "ui.show").includes(`at Card (${src("ui/Card.tsx")}:4:11)`));

  // code not saved yet points at its scratch file
  write("scratch.ts", `import { half } from "#codebase/lib";\n\nexport const quarter = (n: number): number => {\n  return half(half(n));\n};\n\nquarter(-4);\n`);
  const checked = run("check", "--fresh");
  assert.ok(checked.includes(`at quarter (${path.join(dir, "scratch.ts")}:4:10)`), checked);

  // the files follow names
  run("mv", "lib.half", "lib.halve");
  assert.ok(fs.existsSync(src("lib/halve.ts")) && !fs.existsSync(src("lib/half.ts")));
  assert.ok(run("run", "lib.main").includes(`at half (${src("lib/halve.ts")}:7:11)`), "a renamed definition's file, its runtime name unchanged");
});
