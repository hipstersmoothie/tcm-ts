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

  // files changed outside tcm (by hand, a git pull or checkout) are imported before the next command
  put("src/use.ts", read("src/use.ts") + "export const ten = () => 10;\n");
  fs.writeFileSync(scratch, `// tcm: namespace calc.math\nexport const half = (x: number) => x / 2;\n`);
  assert.match(tcm("add"), /mirror: src\/use\.ts changed outside tcm; importing it[\s\S]*\+ new 1/);
  assert.match(tcm("ls", "calc.use"), /calc\.use\.ten/, "the edit is in the codebase");
  assert.match(read("src/math.ts"), /export const half/, "and the command's change is in the files");
  // a definition gone from the files goes from the codebase
  put("src/use.ts", read("src/use.ts").replace("export const ten = () => 10;\n", ""));
  const gone = tcm("ls", "calc.use");
  assert.match(gone, /- removed +calc\.use\.ten \(gone from the files\)/);
  assert.doesNotMatch(gone, /^calc\.use\.ten/m);
  // files that don't import yet (an edit half made) wait, and so does writing back to them; what the codebase
  // changed meanwhile is written once they import
  put("src/use.ts", read("src/use.ts") + "export const eleven = () => 11 +;\n");
  fs.writeFileSync(scratch, `// tcm: namespace calc.math\nexport const halve = (x: number) => x / 2;\n`);
  const waiting = tcm("add");
  assert.match(waiting, /TS1109: Expression expected[\s\S]*nothing was imported/);
  assert.match(waiting, /mirror: src\/use\.ts changed outside tcm and doesn't import yet/);
  assert.doesNotMatch(read("src/math.ts"), /halve/);
  fs.writeFileSync(scratch, `// tcm: namespace calc.use\nexport const nine = () => 9;\n`);
  tcm("update");
  put("src/use.ts", read("src/use.ts").replace("11 +;", "11;"));
  assert.match(tcm("ls", "calc.use"), /calc\.use\.eleven/);
  assert.match(read("src/math.ts"), /export const halve/, "write-back resumes");
  assert.match(read("src/use.ts"), /export const nine = \(\) => 9;\nexport const eleven = \(\) => 11;\n$/, "with the codebase's change to a definition the files hadn't changed");
  assert.match(tcm("mirror", "--check"), /the files hash to what the codebase holds/);
  // what importing them says goes to stderr: a command's output is its own
  put("src/use.ts", read("src/use.ts").replace("() => 11", "() => 12"));
  const ran = spawnSync(process.execPath, [BIN, "run", "calc.use.eleven"], { cwd: dir, encoding: "utf8", env });
  assert.equal(ran.stdout, "12\n");
  assert.match(ran.stderr, /mirror: src\/use\.ts changed outside tcm; importing it/);

  // an import a change stops using goes with it
  assert.match(read("src/math.ts"), /^import fs from "node:fs";$/m);
  tcm("edit", "--force", "calc.math.exists");
  fs.writeFileSync(scratch, fs.readFileSync(scratch, "utf8").replace("fs.existsSync(p)", "p.length > 0"));
  tcm("update");
  assert.doesNotMatch(read("src/math.ts"), /node:fs/);
  assert.match(read("src/math.ts"), /^\/\/ Arithmetic, as the rest of the project needs it\.\n\n/, "and only it");
  assert.match(tcm("mirror", "--check"), /the files hash to what the codebase holds/);
});

test("a mirror's releases are kept in git with its files, and made again in a fresh codebase", () => {
  const repo = path.join(root, "repo");
  const lib = path.join(repo, "lib");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...env, TCM_AUTHOR: "ada" } });
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
    return out;
  };
  const sh = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(lib, "index.ts"), `/** Shapes. */\nexport const manifest = { name: "shapes" };\n`);
  fs.writeFileSync(path.join(lib, "area.ts"), `export const square = (s: number): number => s * s;\n`);
  sh("init", "-q");
  sh("add", ".");
  sh("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "shapes");
  for (const d of [first, second]) {
    fs.mkdirSync(d);
    run(d, "init");
    fs.rmSync(path.join(d, "scratch.ts"));
  }
  run(first, "import", lib, "--into", "geo", "--mirror");

  // a release is made from a commit, and recorded with the files
  const commit = sh("rev-parse", "HEAD");
  assert.match(run(first, "release", "shapes"), /recorded in .*tcm-releases\.json, from commit/);
  const records = JSON.parse(fs.readFileSync(path.join(lib, "tcm-releases.json"), "utf8")) as { version: string; commit: string }[];
  assert.deepEqual(records.map((r) => [r.version, r.commit]), [["0.1.0", commit]]);
  sh("add", ".");
  sh("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "shapes 0.1.0");

  // the next one, after a change made through tcm; a change git doesn't have yet stops it
  fs.writeFileSync(path.join(first, "scratch.ts"), `// tcm: namespace geo.area\nexport const cube = (s: number): number => s * s * s;\n`);
  run(first, "add");
  assert.throws(() => run(first, "release", "shapes"), /has changes git doesn't have yet; commit them first/);
  sh("add", ".");
  sh("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "cube");
  assert.match(run(first, "release", "shapes"), /released shapes@0\.1\.1/);
  sh("add", ".");
  sh("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "shapes 0.1.1");

  // a codebase linked to the mirror afresh has both releases, with their notes, at the same code
  assert.match(run(second, "import", lib, "--into", "geo", "--mirror"), /made 2 releases again from git/);
  const releases = (d: string) => run(d, "releases").replace(/#\w+/g, "");
  assert.equal(releases(second), releases(first));
  assert.equal(run(second, "changelog", "shapes"), run(first, "changelog", "shapes"));
  assert.equal(run(second, "release", "check", "shapes"), run(first, "release", "check", "shapes"));
  assert.match(run(second, "release", "check", "shapes"), /after 0\.1\.1\): no API changes/);
  // and packs as the release it's at
  assert.match(run(second, "pack", "shapes", "--out", path.join(root, "packed")), /packed shapes@0\.1\.1/);
  // each release is at its own history entry: the earlier one packs as it was, without cube
  assert.match(run(second, "pack", "shapes@0.1.0", "--out", path.join(root, "packed-0.1.0")), /packed shapes@0\.1\.0/);
  assert.equal(fs.readdirSync(path.join(root, "packed-0.1.0", "modules")).length < fs.readdirSync(path.join(root, "packed", "modules")).length, true);
});

test("a cycle edited through a mirror changes only what was edited: names re-hashed together read as they did", () => {
  const proj = path.join(root, "cycle");
  const cbDir = path.join(root, "cycle-cb");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ type: "module" }));
  // a class and a function in another file that take each other: one cycle, hashed together
  const counter = `import { log } from "./log.ts";\n\nexport class Counter {\n  n = 0;\n  bump(): number {\n    this.n++;\n    log(this);\n    return this.n;\n  }\n}\n`;
  fs.writeFileSync(path.join(proj, "src", "counter.ts"), counter);
  fs.writeFileSync(path.join(proj, "src", "log.ts"), `import type { Counter } from "./counter.ts";\n\nexport function log(c: Counter): void {\n  console.log("at", c.n);\n}\n`);
  fs.mkdirSync(cbDir);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: cbDir, encoding: "utf8", env });
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
    return out;
  };
  run("init");
  fs.rmSync(path.join(cbDir, "scratch.ts"));
  run("import", proj, "--into", "app", "--mirror");
  assert.match(run("edit", "app.log.log"), /with app\.counter\.Counter/);
  const scratch = path.join(cbDir, "scratch.ts");
  fs.writeFileSync(scratch, fs.readFileSync(scratch, "utf8").replace(`console.log("at", c.n);`, `console.log("count", c.n);`));
  assert.match(run("update"), /mirror: wrote src\/log\.ts/);
  assert.equal(fs.readFileSync(path.join(proj, "src", "counter.ts"), "utf8"), counter, "Counter's file reads as it did");
  assert.equal(fs.readFileSync(path.join(proj, "src", "log.ts"), "utf8"), `import type { Counter } from "./counter.ts";\n\nexport function log(c: Counter): void {\n  console.log("count", c.n);\n}\n`);
  assert.match(run("mirror", "--check"), /the files hash to what the codebase holds/);
});

test("a mirror makes files for new namespaces, and renames reach files near it", () => {
  const repo = path.join(root, "near");
  const cbDir = path.join(root, "near-cb");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(repo, "src", "math.ts"), `export function double(x: number): number {\n  return x * 2;\n}\n`);
  // outside the mirror (src/), in the same repository
  const report = `import { double } from "../src/math.ts";\n\nconsole.log(double(21));\n`;
  fs.writeFileSync(path.join(repo, "scripts", "report.ts"), report);
  assert.equal(spawnSync("git", ["-C", repo, "init", "-q"]).status, 0);
  fs.mkdirSync(cbDir);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: cbDir, encoding: "utf8", env });
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
    return out;
  };
  run("init");
  run("import", path.join(repo, "src"), "--into", "app", "--mirror");

  // a namespace with no file yet gets one, where the mirror reads it back as that namespace
  fs.writeFileSync(path.join(cbDir, "scratch.ts"), `// tcm: namespace app.extra\nimport { double } from "#codebase/app/math";\nexport const quad = (x: number): number => double(double(x));\n`);
  assert.match(run("add"), /mirror: wrote extra\.ts/);
  assert.equal(fs.readFileSync(path.join(repo, "src", "extra.ts"), "utf8"), `import { double } from "./math.ts";\n\nexport const quad = (x: number): number => double(double(x));\n`);

  // a rename reaches the script that uses it, outside the mirror
  assert.match(run("mv", "app.math.double", "app.math.twice"), /mv|moved/);
  assert.equal(fs.readFileSync(path.join(repo, "scripts", "report.ts"), "utf8"), report.replaceAll("double", "twice"));
  assert.match(fs.readFileSync(path.join(repo, "src", "extra.ts"), "utf8"), /twice\(twice\(x\)\)/);
  assert.match(run("mirror", "--check"), /the files hash to what the codebase holds/);

  // code edited in a scratch file that spells an import its own way is kept as the file spells it, so the next
  // write doesn't bring the scratch file's spelling in
  fs.writeFileSync(path.join(repo, "src", "paths.ts"), `import path from "node:path";\n\nexport const base = (p: string): string => path.basename(p);\n`);
  run("import", path.join(repo, "src"), "--into", "app", "--update");
  fs.writeFileSync(path.join(cbDir, "scratch.ts"), `// tcm: namespace app.paths\nimport nodePath from "node:path";\nexport const base = (p: string): string => nodePath.basename(p).toUpperCase();\n`);
  run("update");
  assert.match(fs.readFileSync(path.join(repo, "src", "paths.ts"), "utf8"), / path\.basename\(p\)\.toUpperCase\(\)/);
  assert.match(run("view", "app.paths.base"), / path\.basename\(p\)\.toUpperCase\(\)/);
});
