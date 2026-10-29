import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A mirror: a project imported with --mirror, whose files tcm keeps in step with the codebase.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm mirror ")));
const project = path.join(root, "proj");
const dir = path.join(root, "cb");
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

const tcm = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
};
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
};
const read = (file: string) => fs.readFileSync(path.join(project, file), "utf8");

test("a mirror: edits, additions, removals and renames made in tcm are written back to the files", () => {
  put("package.json", JSON.stringify({ type: "module" }));
  put(
    "src/math.ts",
    `// Arithmetic, as the rest of the project needs it.\nimport fs from "node:fs";\n\n/** Twice \`x\`. */\nexport function double(x: number): number {\n  return x * 2;\n}\n\n// a constant nobody else uses\nconst SCALE = 3;\n\nexport const triple = (x: number): number => x * SCALE;\nexport const exists = (p: string) => fs.existsSync(p);\nexport const unused = 1;\n`,
  );
  put("src/use.ts", `import { double, triple } from "./math.ts";\nimport * as math from "./math.ts";\n\nexport const quad = (x: number) => double(double(x));\nexport const both = (x: number) => ({ double, t: triple(x), via: math.double(x) });\n`);
  fs.mkdirSync(dir);
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  assert.match(tcm("import", project, "--into", "calc", "--mirror"), /written back to/);
  assert.match(tcm("mirror", "--check"), /the files hash to what the codebase holds/);

  // an edit made through a scratch file replaces the declaration where it is; the rest of the file is untouched
  tcm("edit", "calc.math.double");
  const scratch = path.join(dir, "scratch.ts");
  fs.writeFileSync(scratch, fs.readFileSync(scratch, "utf8").replace("return x * 2;", "return x + x;"));
  assert.match(tcm("update"), /mirror: wrote src\/math\.ts/);
  const edited = read("src/math.ts");
  assert.match(edited, /return x \+ x;/);
  assert.match(edited, /^\/\/ Arithmetic, as the rest of the project needs it\.\nimport fs from "node:fs";/, "comments and imports stay as written");
  assert.match(edited, /\/\/ a constant nobody else uses\nconst SCALE = 3;/);
  assert.equal(read("src/use.ts").includes("double(double(x))"), true, "dependents re-hashed by the update keep their text");

  // a rename is made at every reference: named imports, namespace imports, shorthand properties
  tcm("mv", "calc.math.double", "calc.math.twice");
  assert.match(read("src/math.ts"), /export function twice\(x: number\): number \{/);
  assert.equal(read("src/use.ts"), `import { twice, triple } from "./math.ts";\nimport * as math from "./math.ts";\n\nexport const quad = (x: number) => twice(twice(x));\nexport const both = (x: number) => ({ double: twice, t: triple(x), via: math.twice(x) });\n`);

  // a new definition goes to its namespace's file, with what it uses imported; a removed one is deleted
  fs.writeFileSync(scratch, `// tcm: namespace calc.use\nimport { triple } from "#codebase/calc/math";\nexport const nine = () => triple(3);\n`);
  tcm("add");
  assert.match(read("src/use.ts"), /\nexport const nine = \(\) => triple\(3\);\n$/);
  tcm("rm", "calc.math.unused");
  assert.doesNotMatch(read("src/math.ts"), /unused/);
  assert.match(tcm("mirror", "--check"), /the files hash to what the codebase holds/);

  // a file changed by hand isn't overwritten: write-back waits until it's imported again
  put("src/use.ts", read("src/use.ts") + "export const ten = () => 10;\n");
  fs.writeFileSync(scratch, `// tcm: namespace calc.math\nexport const half = (x: number) => x / 2;\n`);
  assert.match(tcm("add"), /mirror: src\/use\.ts changed since tcm last saw it/);
  assert.doesNotMatch(read("src/math.ts"), /half/);
  tcm("import", project, "--into", "calc", "--update");
  assert.match(tcm("ls", "calc.use"), /calc\.use\.ten/, "the hand edit is in the codebase");
  fs.writeFileSync(scratch, `// tcm: namespace calc.math\nexport const halve = (x: number) => x / 2;\n`);
  tcm("add");
  assert.match(read("src/math.ts"), /export const halve/, "and write-back resumes");
  assert.match(tcm("mirror", "--check"), /the files hash to what the codebase holds/);
});
