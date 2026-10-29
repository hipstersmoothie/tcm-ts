// Packages and releases: a `manifest` definition makes its namespace a package; a release names a point in history
// for good, with notes kept in the codebase. The version and the list of changes come from semver checks of the
// package's API since its previous release; packages depend on each other through their releases.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LINTS } from "../../src/semver-checks.ts";
import { plainEnv, repoPath, strip, tcmBin, tempDir } from "./harness.ts";

function codebase(name: string) {
  const dir = tempDir(`releases ${name}`);
  const env = { ...plainEnv(), TCM_AUTHOR: "ada" };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [tcmBin(), ...args], { cwd: dir, encoding: "utf8", env });
    return { status: r.status, out: strip(r.stdout + r.stderr) };
  };
  const tcm = (...args: string[]) => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} (in ${name}) exited ${r.status}:\n${r.out}`);
    return r.out;
  };
  const save = (text: string, mode = "update") => (fs.writeFileSync(path.join(dir, "scratch.ts"), text), tcm(mode));
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  return { dir, run, tcm, save, file: (f: string) => path.join(dir, f) };
}

/** a package's releases: versions from the changes, notes from the codebase, drafts for the words */
export const testPackageReleases = () => {
  const a = codebase("one");
  a.save(`// tcm: namespace lib\nexport const manifest = { name: "squares" };\n/** Squares a number. Quickly. */\nexport const square = (x: number): number => x * x;\nexport const helper = (x: number): number => x + 1;\n`, "add");
  a.save(`// tcm: namespace other\nexport const detail = 1;\n`, "add");
  assert.match(a.tcm("release"), /released squares@0\.1\.0 as #\w{8}: its first release\n\n## 0\.1\.0 \(\d{4}-\d\d-\d\d\)\n\nThe first release: 2 definition\(s\)\./);

  // a breaking change: the version follows (a minor step, before 1.0), and nothing smaller is accepted
  a.save(`// tcm: namespace lib\n/** Cubes a number. */\nexport const cube = (x: number): number => x * x * x;\nexport const square = (x: number): number => x ** 2;\n`);
  a.tcm("rm", "lib.helper");
  a.save(`// tcm: namespace other\nexport const detail = 2;\n`);
  assert.match(a.tcm("release", "check"), /squares's next release: 0\.2\.0 \(after 0\.1\.0\): breaking changes\n\n {2}major {2}lib\.helper removed\n {9}definition_removed: code that uses it no longer compiles/);
  assert.match(a.run("release", "@0.1.1").out, /0\.1\.1 is too small a step from 0\.1\.0: breaking changes \(lib\.helper\) call for 0\.2\.0/);

  // a draft: people write above the marker; below it is regenerated, so editing it changes nothing
  assert.match(a.tcm("release", "--draft"), /wrote release-squares\.md \(squares's next release, 0\.2\.0 as things stand\)/);
  const draft = fs.readFileSync(a.file("release-squares.md"), "utf8");
  fs.writeFileSync(a.file("release-squares.md"), draft.replace("<!-- what this release is about, for the people who use it -->", "Cubes, and a faster `square`.").replace(/- `lib\.helper` removed\n/, ""));
  const out = a.tcm("release");
  assert.match(out, /released squares@0\.2\.0 .*: breaking changes/);
  assert.match(out, /Cubes, and a faster `square`\.\n\n### Breaking changes\n\n- `lib\.helper` removed\n\n### Added\n\n- `lib\.cube` `\(x: number\) => number`: Cubes a number\.\n\n### Changed\n\n- `lib\.square` \(new implementation, same API\)$/m);
  assert.doesNotMatch(out, /other\.detail/, "only the package's own definitions");
  assert.ok(!fs.existsSync(a.file("release-squares.md")), "the draft's words are in the release now");

  // a version can be further than the changes call for, never less; releases don't change; todo holds them up
  a.tcm("branch", "other");
  a.save(`// tcm: namespace lib\nexport const cube = (x: number): number => x ** 3;\n`);
  assert.match(a.run("release", "squares@0.2.0").out, /squares@0\.2\.0 is already released/);
  a.tcm("switch", "other");
  a.save(`// tcm: namespace lib\nexport const cube = (x: number): number => x * x * x * 1;\n`);
  a.tcm("switch", "main");
  a.run("merge", "other");
  assert.match(a.run("release").out, /squares has work left \(`tcm todo`\)/);
  const [keep] = [...a.tcm("ls", "lib.cube").matchAll(/#([a-z2-7]{8})/g)].map((m) => m[1]);
  a.tcm("resolve", "lib.cube", `#${keep}`);
  assert.match(a.tcm("release", "1.0.0"), /released squares@1\.0\.0 .*: as asked/);
  // with nothing new there's no release to make, unless one is asked for by version
  assert.match(a.run("release").out, /squares has nothing new since 1\.0\.0: no release to make/);

  // listed, rendered as a changelog, and usable wherever a history entry is
  assert.match(a.tcm("releases"), /^squares {2}lib\n {2}1\.0\.0 .*\n {2}0\.2\.0 .* Cubes, and a faster `square`\.\n {2}0\.1\.0 /);
  const log = a.tcm("changelog");
  assert.match(log, /^# Changelog\n\n## 1\.0\.0[\s\S]*## 0\.2\.0[\s\S]*## 0\.1\.0/);
  assert.doesNotMatch(log, /<!--/);
  a.tcm("changelog", "--out", "CHANGELOG.md");
  assert.equal(fs.readFileSync(a.file("CHANGELOG.md"), "utf8"), log);
  assert.match(a.tcm("diff", "squares@0.2.0"), /changes since squares@0\.2\.0[\s\S]*lib\.cube/);
  assert.match(a.tcm("release", "view", "@0.2.0"), /^## 0\.2\.0 .*\n\nCubes/);

  // packing a release packs it, at its version, with its changelog, whatever's on the branch now
  a.save(`// tcm: namespace lib\nexport const later = 1;\n`, "add");
  a.tcm("pack", "squares@0.2.0");
  const pkg = path.join(a.dir, ".tcm", "pack", "squares");
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version, "0.2.0");
  const changes = fs.readFileSync(path.join(pkg, "CHANGELOG.md"), "utf8");
  assert.match(changes, /## 0\.2\.0[\s\S]*## 0\.1\.0/);
  assert.doesNotMatch(changes, /1\.0\.0/);
  const index = fs.readFileSync(path.join(pkg, "index.d.ts"), "utf8");
  assert.match(index, / as cube /);
  assert.doesNotMatch(index, / as later | as manifest /);
};

/** semver checks: each kind of API change, the lint it trips and the version it calls for */
export const testSemverChecks = () => {
  const a = codebase("lints");
  const before: Record<string, string> = {
    opt: `export const f = (x: number): number => x;`,
    req: `export const f = (x: number): number => x;`,
    wide: `export const f = (x: number): string => String(x);`,
    ret: `export const f = (x: number): number => x;`,
    union: `export type Shape = "circle" | "square";`,
    prop: `export interface Options { size: number }`,
    gone: `export interface Options { size: number; label: string }`,
    impl: `export const f = (x: number): number => x * 2;`,
    rename: `export const f = 1;`,
  };
  const after: Record<string, string> = {
    opt: `export const f = (x: number, y?: number): number => x + (y ?? 0);`,
    req: `export const f = (x: number, y: number): number => x + y;`,
    wide: `export const f = (x: number | string): string => String(x);`,
    ret: `export const f = (x: number): number | undefined => x || undefined;`,
    union: `export type Shape = "circle" | "square" | "triangle";`,
    prop: `export interface Options { size: number; label?: string }`,
    gone: `export interface Options { size: number }`,
    impl: `export const f = (x: number): number => x + x;`,
  };
  for (const [ns, text] of Object.entries(before)) a.save(`// tcm: namespace ${ns}\nexport const manifest = { name: "${ns}" };\n${text}\n`, "add");
  for (const ns of Object.keys(before)) a.tcm("release", `${ns}@1.0.0`);
  for (const [ns, text] of Object.entries(after)) a.save(`// tcm: namespace ${ns}\n${text}\n`);
  a.tcm("mv", "rename.f", "rename.g");
  const check = (ns: string) => a.tcm("release", "check", ns);
  assert.match(check("opt"), /1\.1\.0 .*: additions[\s\S]*minor {2}opt\.f takes a new optional parameter: y\n {9}function_optional_parameter_added/);
  assert.match(check("req"), /2\.0\.0 .*: breaking changes[\s\S]*major {2}req\.f takes a required parameter it didn't: y: number\n {9}function_required_parameter_added/);
  assert.match(check("wide"), /1\.1\.0[\s\S]*minor {2}wide\.f accepts more for a parameter: x: number → string \| number/);
  assert.match(check("ret"), /2\.0\.0[\s\S]*major {2}ret\.f can return more kinds of value: number → number \| undefined\n {9}function_return_type_widened: callers may get a value they don't handle/);
  assert.match(check("union"), /2\.0\.0[\s\S]*major {2}union\.Shape has a new case: "triangle"\n {9}type_union_member_added: code handling every case no longer does/);
  assert.match(check("prop"), /1\.1\.0[\s\S]*minor {2}prop\.Options has a new optional property: label/);
  assert.match(check("gone"), /2\.0\.0[\s\S]*major {2}gone\.Options lost a property: label/);
  assert.match(check("impl"), /1\.0\.1 .*: changes with the same API[\s\S]*patch {2}impl\.f changed, with the same API/);
  assert.match(check("rename"), /2\.0\.0[\s\S]*major {2}rename\.f renamed: rename\.g\n {9}definition_renamed: code that imports it by its old name no longer compiles/);
};

/** every semver lint is documented */
export const testSemverLintsDocumented = () => {
  const docs = fs.readFileSync(repoPath("packages/docs/releases.md"), "utf8");
  for (const [id, l] of Object.entries(LINTS)) assert.ok(docs.includes(`| \`${id}\` | ${l.level} |`), `${id} is in docs/releases.md`);
}

/** packages depend on each other through their releases */
export const testPackagesDependThroughReleases = () => {
  const a = codebase("two");
  a.save(`// tcm: namespace geo\nexport const manifest = { name: "geo" };\nexport interface Point { x: number; y: number }\nexport const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);\n`, "add");
  a.save(`// tcm: namespace atlas\nimport { distance, type Point } from "#codebase/geo";\nexport const manifest = { name: "atlas", bin: { atlas: "main" } };\nexport const length = (ps: Point[]): number => ps.slice(1).reduce((n, p, i) => n + distance(ps[i]!, p), 0);\nexport const main = (): number => (console.log(length([{ x: 0, y: 0 }, { x: 3, y: 4 }])), 0);\n`, "add");
  assert.match(a.run("release").out, /which package\? atlas, geo/);
  assert.match(a.run("pack", "atlas").out, /this uses geo\.Point, geo\.distance from geo, which geo hasn't released yet: release geo first/);
  a.tcm("release", "geo");
  a.tcm("release", "atlas");

  // atlas imports what it uses of geo from geo's release, rather than carrying a copy
  assert.match(a.tcm("pack", "atlas@0.1.0"), /packed atlas@0\.1\.0 into \.tcm\/pack\/atlas: 2 module\(s\), depends on geo/);
  const dir = path.join(a.dir, ".tcm", "pack", "atlas");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies, { geo: "^0.1.0" });
  const modules = fs.readdirSync(path.join(dir, "modules")).map((f) => fs.readFileSync(path.join(dir, "modules", f), "utf8")).join("\n");
  assert.match(modules, /import \{ distance as distance \} from "geo";/);
  assert.match(modules, /import type \{ Point as Point \} from "geo";/);
  assert.doesNotMatch(modules, /Math\.hypot/, "geo's code isn't copied in");

  // a change to geo is geo's: atlas's code didn't change, only what it uses
  a.save(`// tcm: namespace geo\nimport type { Point } from "#codebase/geo";\nexport const distance = (a: Point, b: Point, digits?: number): number => Number(Math.hypot(a.x - b.x, a.y - b.y).toFixed(digits ?? 10));\n`);
  assert.match(a.tcm("release", "check", "geo"), /geo's next release: 0\.1\.1 .*: additions/);
  assert.match(a.tcm("release", "check", "atlas"), /atlas's next release: 0\.1\.1 .*: no API changes[\s\S]*follow those changes \(atlas\.length/);
  assert.match(a.run("pack", "atlas").out, /geo@0\.1\.0 doesn't export as it is here: release geo first/);
  a.tcm("release", "geo");
  a.tcm("pack", "atlas");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies, { geo: "^0.1.1" });
  assert.match(a.tcm("releases"), /^atlas {2}atlas\n {2}0\.1\.0 [\s\S]*geo {2}geo\n {2}0\.1\.1 [\s\S]* {2}0\.1\.0 /m);
};

/** releases travel with push and pull, list the contributions that touched them, and never change */
export const testReleasesTravelAndNeverChange = () => {
  const server = codebase("server");
  server.save(`// tcm: namespace lib\nexport const manifest = { name: "lib" };\nexport const one = 1;\n`, "add");
  server.save(`// tcm: namespace tools\nexport const manifest = { name: "tools" };\nexport const t = 1;\n`, "add");
  const me = codebase("me");
  me.tcm("remote", "add", "origin", server.dir);
  me.tcm("pull");
  me.tcm("release", "lib@1.0.0");
  me.tcm("release", "tools@1.0.0");
  assert.match(me.tcm("push"), /released lib@1\.0\.0, tools@1\.0\.0 on origin|released tools@1\.0\.0, lib@1\.0\.0 on origin/);
  assert.match(server.tcm("releases"), /lib {2}lib\n {2}1\.0\.0 /);

  // a contribution merged on the server shows in the next release of the package it touched, not the other
  me.tcm("branch", "two");
  me.tcm("switch", "two");
  me.save(`// tcm: namespace lib\n/** Two. */\nexport const two = 2;\n`, "add");
  me.tcm("contribute", "--title", "Add two");
  me.tcm("contribution", "merge", "1");
  me.tcm("switch", "main");
  me.tcm("pull");
  assert.match(me.tcm("release", "lib"), /### Added\n\n- `lib\.two` `2`: Two\.\n\n### Contributions\n\n- #1 Add two \(ada\)/);
  me.save(`// tcm: namespace tools\nexport const t = 2;\n`);
  assert.doesNotMatch(me.tcm("release", "tools"), /Contributions/);
  me.tcm("push");

  // a codebase that pulls gets the releases, with the history they name
  const other = codebase("other");
  other.tcm("remote", "add", "origin", server.dir);
  assert.match(other.tcm("pull"), /received release\(s\) .*lib@1\.1\.0/);
  assert.equal(other.tcm("changelog", "lib"), me.tcm("changelog", "lib"));
  assert.match(other.tcm("diff", "lib@1.0.0", "lib@1.1.0"), /\+ lib\.two/);

  // the same version made differently elsewhere is refused, not overwritten
  const rogue = codebase("rogue");
  rogue.save(`// tcm: namespace lib\nexport const manifest = { name: "lib" };\nexport const x = 1;\n`, "add");
  rogue.tcm("release", "1.1.0");
  rogue.tcm("remote", "add", "origin", server.dir);
  assert.match(rogue.run("pull").out, /has a different lib@1\.1\.0 .*a version names one release, for good/);
};
