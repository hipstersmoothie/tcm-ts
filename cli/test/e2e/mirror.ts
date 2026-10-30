// A mirror: a project imported with --mirror, whose files tcm keeps in step with the codebase.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { okIn, plainEnv, strip, tcmBin, tempDir } from "./harness.ts";

/** a mirror: edits, additions, removals and renames made in tcm are written back to the files */
export const testMirrorWritesBack = () => {
  const root = tempDir("mirror");
  const project = path.join(root, "proj");
  const dir = path.join(root, "cb");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  };
  const read = (file: string) => fs.readFileSync(path.join(project, file), "utf8");
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
  const ran = spawnSync(process.execPath, [tcmBin(), "run", "calc.use.eleven"], { cwd: dir, encoding: "utf8", env: plainEnv() });
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
};

/** a mirror's releases are kept in git with its files, and made again in a fresh codebase */
export const testMirrorReleasesInGit = () => {
  const root = tempDir("mirror");
  const repo = path.join(root, "repo");
  const lib = path.join(repo, "lib");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [tcmBin(), ...args], { cwd, encoding: "utf8", env: { ...plainEnv(), TCM_AUTHOR: "ada" } });
    const out = strip(r.stdout + r.stderr);
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
};

/** a cycle edited through a mirror changes only what was edited: names re-hashed together read as they did */
export const testMirrorCycleEdit = () => {
  const root = tempDir("mirror");
  const proj = path.join(root, "cycle");
  const cbDir = path.join(root, "cycle-cb");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ type: "module" }));
  // a class and a function in another file that take each other: one cycle, hashed together
  const counter = `import { log } from "./log.ts";\n\nexport class Counter {\n  n = 0;\n  bump(): number {\n    this.n++;\n    log(this);\n    return this.n;\n  }\n}\n`;
  fs.writeFileSync(path.join(proj, "src", "counter.ts"), counter);
  fs.writeFileSync(path.join(proj, "src", "log.ts"), `import type { Counter } from "./counter.ts";\n\nexport function log(c: Counter): void {\n  console.log("at", c.n);\n}\n`);
  fs.mkdirSync(cbDir);
  const run = (...args: string[]) => okIn(cbDir, ...args);
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
};

/** a mirror makes files for new namespaces, and renames reach files near it */
export const testMirrorNewNamespacesAndNearbyRenames = () => {
  const root = tempDir("mirror");
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
  const run = (...args: string[]) => okIn(cbDir, ...args);
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

  // in the codebase anything can be imported; in the files, what another file imports is exported where it is
  fs.appendFileSync(path.join(repo, "src", "paths.ts"), `\nconst SEP = "/";\n\nexport const join = (a: string, b: string): string => a + SEP + b;\n`);
  fs.writeFileSync(path.join(cbDir, "scratch.ts"), `// tcm: namespace app.extra\nimport { SEP } from "#codebase/app/paths";\nexport const under = (p: string): string => SEP + p;\n`);
  run("add");
  assert.match(fs.readFileSync(path.join(repo, "src", "paths.ts"), "utf8"), /\nexport const SEP = "\/";\n/);
  assert.match(fs.readFileSync(path.join(repo, "src", "extra.ts"), "utf8"), /import \{ SEP \} from "\.\/paths\.ts";/);
  assert.match(run("mirror", "--check"), /the files hash to what the codebase holds/);

  // saved from a scratch file and then re-derived in the same update (it uses one that was): its new code is
  // written, not left as propagation-only
  fs.writeFileSync(path.join(repo, "src", "chain.ts"), `export const h = (): number => 1;\nexport const g = (): number => h() + 1;\nexport const f = (): number => g() * 10;\n`);
  fs.writeFileSync(path.join(cbDir, "scratch.ts"), `// tcm: namespace app.chain\nimport { g } from "#codebase/app/chain";\nexport const h = (): number => 2;\nexport const f = (): number => g() * 100;\n`);
  assert.match(run("update"), /mirror: wrote chain\.ts/);
  assert.equal(fs.readFileSync(path.join(repo, "src", "chain.ts"), "utf8"), `export const h = (): number => 2;\nexport const g = (): number => h() + 1;\nexport const f = (): number => g() * 100;\n`);
  assert.match(run("mirror", "--check"), /the files hash to what the codebase holds/);
};

/** a definition moved to another namespace moves to its file, and what imports it follows */
export const testMirrorMoves = () => {
  const root = tempDir("mirror");
  const repo = path.join(root, "moves");
  const cbDir = path.join(root, "moves-cb");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(repo, "src", "math.ts"), `export function double(x: number): number {\n  return x * 2;\n}\n\nexport const half = (x: number): number => x / 2;\n\nexport const halfDouble = (x: number): number => half(double(x));\n`);
  fs.writeFileSync(path.join(repo, "src", "use.ts"), `import { double, half } from "./math.ts";\n\nexport const quarter = (x: number): number => half(half(x));\nexport const quad = (x: number): number => double(double(x));\n`);
  fs.writeFileSync(path.join(repo, "src", "extra.ts"), `export const one = 1;\n`);
  const report = `import { half } from "../src/math.ts";\n\nconsole.log(half(8));\n`;
  fs.writeFileSync(path.join(repo, "scripts", "report.ts"), report);
  assert.equal(spawnSync("git", ["-C", repo, "init", "-q"]).status, 0);
  fs.mkdirSync(cbDir);
  const run = (...args: string[]) => okIn(cbDir, ...args);
  const read = (f: string) => fs.readFileSync(path.join(repo, f), "utf8");
  run("init");
  run("import", path.join(repo, "src"), "--into", "app", "--mirror");

  assert.match(run("mv", "app.math.half", "app.extra.half"), /mirror: wrote/);
  // its declaration moves; the file it left imports it for the code there that still uses it
  assert.equal(read("src/math.ts"), `import { half } from "./extra.ts";\nexport function double(x: number): number {\n  return x * 2;\n}\n\nexport const halfDouble = (x: number): number => half(double(x));\n`);
  assert.equal(read("src/extra.ts"), `export const one = 1;\n\nexport const half = (x: number): number => x / 2;\n`);
  // imports of it follow it, splitting one that brought others too, outside the mirror as well
  assert.equal(read("src/use.ts"), `import { double } from "./math.ts";\nimport { half } from "./extra.ts";\n\nexport const quarter = (x: number): number => half(half(x));\nexport const quad = (x: number): number => double(double(x));\n`);
  assert.equal(read("scripts/report.ts"), `import { half } from "../src/extra.ts";\n\nconsole.log(half(8));\n`);
  assert.match(run("mirror", "--check"), /the files hash to what the codebase holds/);

  // moved back and renamed at once
  run("mv", "app.extra.half", "app.math.halve");
  assert.doesNotMatch(read("src/extra.ts"), /half/);
  assert.match(read("src/math.ts"), /export const halfDouble = \(x: number\): number => halve\(double\(x\)\);/);
  assert.match(read("src/use.ts"), /import \{ double, halve \} from "\.\/math\.ts";|import \{ double \} from "\.\/math\.ts";\nimport \{ halve \} from "\.\/math\.ts";/);
  assert.match(read("scripts/report.ts"), /import \{ halve \} from "\.\.\/src\/math\.ts";\n\nconsole\.log\(halve\(8\)\);/);
  assert.match(run("mirror", "--check"), /the files hash to what the codebase holds/);
};

/**
 * A whole repository mirrored: its code, and everything else git keeps as files of the codebase (configuration,
 * scripts, hidden and extensionless files, bytes), but not what git ignores.
 */
export const testMirrorWholeRepository = () => {
  const root = tempDir("mirror repo");
  const repo = path.join(root, "repo");
  const dir = path.join(root, "cb");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const put = (file: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  put(".gitignore", "node_modules/\n");
  put("README.md", "# repo\n\nSee [the guide](docs/guide.md).\n");
  put("LICENSE", "MIT\n");
  put("package.json", JSON.stringify({ type: "module" }));
  put("scripts/run.sh", "#!/bin/sh\necho hi\n");
  put(".github/workflows/ci.yml", "on: push\n");
  put("geo/package.json", JSON.stringify({ name: "geo", type: "module" }));
  put("geo/src/index.ts", "export const square = (x: number): number => x * x;\n");
  put("geo/blob.bin", Buffer.from([0x89, 0x50, 0, 0xff]));
  put("docs/guide.md", "# Guide\n");
  put("node_modules/x/index.js", "module.exports = 1;\n");
  assert.equal(spawnSync("git", ["-C", repo, "init", "-q"]).status, 0);
  fs.mkdirSync(dir);
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  assert.doesNotMatch(tcm("import", repo, "--into", "r", "--mirror"), /warning/);
  const ls = tcm("ls", "r");
  for (const line of [/r\.geo\.square +#\w+ +: \(x: number\) => number/, /r\.README +#\w+ +: md/, /r\.LICENSE +#\w+ +: text/, /r\.gitignore +#\w+ +: text/, /r\.package +#\w+ +: json/, /r\.geo\.package +#\w+ +: json/, /r\.scripts\.run +#\w+ +: sh/, /r\._github\.workflows\.ci +#\w+ +: yml/, /r\.geo\.blob +#\w+ +: bin/, /r\.docs\.guide +#\w+ +: md/]) {
    assert.match(ls, line);
  }
  assert.doesNotMatch(ls, /node_modules|r\.x\b/, "what git ignores isn't the codebase's");
  assert.match(tcm("view", "r.LICENSE"), /^MIT$/m);
  assert.match(tcm("view", "r.geo.blob"), /\(bin, 4 bytes\)/);
  // a file changed outside tcm is followed, one removed goes
  put("LICENSE", "Apache-2.0\n");
  assert.match(tcm("view", "r.LICENSE"), /^Apache-2\.0$/m);
  fs.rmSync(path.join(repo, "scripts"), { recursive: true });
  assert.match(tcm("ls", "r"), /- removed +r\.scripts\.run/);
  assert.doesNotMatch(tcm("ls", "r"), /r\.scripts/);
  assert.match(tcm("mirror", "--check"), /the files hash to what the codebase holds/);
};

/**
 * JSX coming to a namespace whose file is `.ts` makes it `.tsx` (JSX only parses there), and imports of it follow;
 * the JSX is written, and edited, as it is.
 */
export const testMirrorJsxMakesTheFileTsx = () => {
  const proj = path.join(tempDir("mirror tsx"), "proj");
  const cbDir = path.join(proj, "codebase");
  // a stand-in for React 19 (what JSX compiles to), so nothing is installed in the project
  const react = path.join(proj, "node_modules", "react");
  fs.mkdirSync(react, { recursive: true });
  fs.mkdirSync(cbDir);
  fs.writeFileSync(path.join(react, "package.json"), JSON.stringify({ name: "react", version: "19.0.0", type: "module", exports: { "./jsx-runtime": { types: "./jsx-runtime.d.ts", default: "./jsx-runtime.js" } } }));
  fs.writeFileSync(path.join(react, "jsx-runtime.js"), `export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;\nexport const Fragment = "fragment";\n`);
  fs.writeFileSync(path.join(react, "jsx-runtime.d.ts"), `export declare function jsx(type: unknown, props: unknown): JSX.Element;\nexport declare const jsxs: typeof jsx;\nexport declare const Fragment: unique symbol;\nexport declare namespace JSX {\n  type Element = { type: unknown; props: unknown };\n  interface IntrinsicElements { [name: string]: Record<string, unknown> }\n}\n`);
  fs.writeFileSync(path.join(proj, ".gitignore"), "node_modules/\ncodebase/\n");
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ type: "module", dependencies: { react: "19.0.0" } }));
  fs.writeFileSync(path.join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", jsx: "react-jsx", noEmit: true, allowImportingTsExtensions: true } }));
  fs.writeFileSync(path.join(proj, "ui.ts"), "export const shout = (s: string): string => s.toUpperCase();\n");
  fs.writeFileSync(path.join(proj, "main.ts"), `import { shout } from "./ui.ts";\n\nexport const hi = (): string => shout("hi");\n`);
  assert.equal(spawnSync("git", ["-C", proj, "init", "-q"]).status, 0);
  const ok = (...args: string[]) => okIn(cbDir, ...args);
  ok("init");
  fs.rmSync(path.join(cbDir, "scratch.ts"));
  ok("import", "..", "--into", "app", "--mirror");
  const title = `export const Title = ({ text }: { text: string }) => <>{text && <b className="t">{shout(text)}</b>}</>;`;
  fs.writeFileSync(path.join(cbDir, "scratch.tsx"), `// tcm: namespace app.ui\nimport { shout } from "#codebase/app/ui";\n\n${title}\n`);
  assert.match(ok("add", "scratch.tsx"), /mirror: wrote ui\.ts \(now ui\.tsx\)/);
  assert.ok(!fs.existsSync(path.join(proj, "ui.ts")));
  assert.equal(fs.readFileSync(path.join(proj, "ui.tsx"), "utf8"), `export const shout = (s: string): string => s.toUpperCase();\n\n${title}\n`);
  assert.match(fs.readFileSync(path.join(proj, "main.ts"), "utf8"), /import \{ shout \} from "\.\/ui\.tsx";/);
  assert.match(ok("mirror", "--check"), /the files hash to what the codebase holds/);
  ok("edit", "app.ui.Title", "--file", "edit.tsx");
  assert.match(fs.readFileSync(path.join(cbDir, "edit.tsx"), "utf8"), /\nexport const Title = \(\{ text \}: \{ text: string \}\) => <>\{text && <b className="t">\{shout\(text\)\}<\/b>\}<\/>/);
}
