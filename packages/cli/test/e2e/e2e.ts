// The whole workflow, end to end: init, add, rename, update, todo, edit, run, tests, and what tcm accepts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { okIn, tempDir } from "./harness.ts";

/** A new directory to run tcm in (a space in its path catches quoting bugs), and helpers to run it there. */
function fixture() {
  const dir = tempDir("e2e");
  const tcm = (...args: string[]): string => okIn(dir, ...args);
  const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
  const hashOf = (name: string) => /#([a-z2-7]{8})/.exec(tcm("ls", name).split("\n").find((l) => l.startsWith(name + " "))!)![1];
  return { dir, tcm, scratch, hashOf };
}

/** A fixture with a new codebase in it: each test starts from its own. */
function setUp() {
  const f = fixture();
  f.tcm("init");
  return f;
}

/** init → add → mv → update → todo → edit → run */
export const testInitAddMvUpdateTodoEditRun = () => {
  const { tcm, scratch, dir, hashOf } = fixture();
  tcm("init");
  assert.match(tcm("check"), /⧩ 144/);
  tcm("add");

  scratch(`// tcm: namespace lib
import { square } from "#codebase";
export function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1) }
export function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1) }
export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 0);
export const main = (...args: string[]) => \`\${sumSquares(args.map(Number))} \${isEven(args.length)}\`;
`);
  assert.match(tcm("add"), /\+ new\s+lib\.main/);
  assert.equal(tcm("run", "lib.main", "1", "2").trim(), "5 true");

  // renames are metadata: dependents keep their hash and render with the new name
  const before = hashOf("lib.sumSquares");
  tcm("mv", "square", "math.sq");
  assert.match(tcm("diff"), /renamed\s+> square → math\.sq/);
  assert.equal(hashOf("lib.sumSquares"), before);
  assert.match(tcm("view", "lib.sumSquares"), /import \{ sq \} from "#codebase\/math";[\s\S]*xs\.map\(sq\)/);

  // rendering a definition and re-hashing it is the identity
  tcm("edit", "lib.sumSquares", "lib.main", "--file", "roundtrip.ts");
  assert.match(tcm("check", "roundtrip.ts"), /= identical\s+lib\.sumSquares[\s\S]*= identical\s+lib\.main/);
  // across namespaces, including a function renamed by `mv` (it keeps its runtime name `square`)
  tcm("edit", "lib.sumSquares", "math.sq", "--file", "cross.ts");
  const cross = fs.readFileSync(path.join(dir, "cross.ts"), "utf8");
  assert.match(cross, /\/\/ tcm: path math\.sq\nexport const square =/);
  assert.match(tcm("check", "cross.ts"), /= identical\s+lib\.sumSquares[\s\S]*= identical\s+math\.sq/);

  // a compatible update propagates to dependents
  scratch(`// tcm: namespace math\nexport const sq = (x: number): number => x * x * x;\n`);
  const upd = tcm("update");
  assert.match(upd, /~ updated\s+lib\.sumSquares/);
  assert.match(upd, /~ updated\s+lib\.main/);
  assert.equal(tcm("run", "lib.main", "1", "2").trim(), "9 true");

  // diff separates the edit from dependents that were only re-hashed because of it
  const d = tcm("diff");
  assert.match(d, /changes from `update scratch\.ts`/);
  // `mv square math.sq` kept the function's runtime name; this edit declares `sq`, so the name changes too
  assert.match(d, /edited\s+~ math\.sq[\s\S]*- export const square = \(x: number\): number => x \* x\n\s+\+ export const sq = \(x: number\): number => x \* x \* x/);
  assert.match(d, /updated because a dependency changed[\s\S]*lib\.main .* via lib\.sumSquares[\s\S]*lib\.sumSquares .* via math\.sq/);
  assert.doesNotMatch(d.split("updated because")[0]!, /lib\.sumSquares/, "propagated definitions are not listed as edits");

  // an incompatible update leaves dependents on the old version and lists them in todo
  scratch(`// tcm: namespace math\nexport const sq = (x: string): string => x + x;\n`);
  tcm("update");
  assert.match(tcm("todo"), /needs fixing lib\.sumSquares/);
  assert.equal(tcm("run", "lib.main", "1", "2").trim(), "9 true");

  // edit the todo item against the new definition, fix it, update
  tcm("edit", "lib.sumSquares", "--force");
  const text = fs.readFileSync(path.join(dir, "scratch.ts"), "utf8");
  assert.match(text, /import \{ sq \} from "#codebase\/math"/);
  scratch(text.replace("xs.map(sq)", "xs.map(String).map(sq).map(Number)"));
  tcm("update");
  assert.match(tcm("todo"), /nothing to do/);
  assert.equal(tcm("run", "lib.main", "4").trim(), "44 false");
};

/** classes keep their identity and runtime name through renames */
export const testClassesKeepIdentityThroughRenames = () => {
  const { tcm, scratch } = setUp();
  scratch(`// tcm: namespace errors
export class UsageError extends Error {}
export class ConflictError extends Error {}
export const probe = () => [new UsageError("u") instanceof ConflictError, new ConflictError("c").constructor.name].join(" ");
`);
  tcm("add");
  assert.equal(tcm("run", "errors.probe").trim(), "false ConflictError");
  assert.match(tcm("mv", "errors.ConflictError", "errors.Clash"), /still named `ConflictError` at runtime/);
  assert.equal(tcm("run", "errors.probe").trim(), "false ConflictError");
  assert.match(tcm("view", "errors.Clash"), /class ConflictError extends Error/);
  // editing it binds it back to errors.Clash, not to a fresh errors.ConflictError
  tcm("edit", "errors.Clash", "--file", "clash.ts");
  assert.match(tcm("check", "clash.ts"), /= identical\s+errors\.Clash/);
};

/** separately declared definitions keep separate identities */
export const testSeparateDeclarationsKeepSeparateIdentities = () => {
  const { tcm, scratch, hashOf } = setUp();
  // two identical stateful values are two objects, as in plain TypeScript
  scratch(`// tcm: namespace state
export const cacheA = new Map<string, number>();
export const cacheB = new Map<string, number>();
export const probe = () => { cacheA.set("k", 1); return String(cacheA === cacheB) + " " + cacheB.size; };
`);
  tcm("add");
  assert.equal(tcm("run", "state.probe").trim(), "false 0");
  assert.match(tcm("check"), /= identical\s+state\.cacheA[\s\S]*= identical\s+state\.cacheB/, "re-checking reproduces the same hashes");

  // the same class source added in two namespaces is two classes
  const errSource = `export class AppError extends Error {}\n`;
  scratch(errSource);
  tcm("add", "--into", "one");
  tcm("add", "--into", "two");
  assert.notEqual(hashOf("one.AppError"), hashOf("two.AppError"));
  scratch(`import { AppError as One } from "#codebase/one";\nimport { AppError as Two } from "#codebase/two";\nexport const crossCheck = () => new One() instanceof Two;\n`);
  tcm("add");
  assert.equal(tcm("run", "crossCheck").trim(), "false");

  // renaming keeps both the hash and the runtime name
  const before = hashOf("state.probe");
  assert.match(tcm("mv", "state.probe", "state.check"), /still named `probe` at runtime/);
  assert.equal(hashOf("state.check"), before);
};

/** a definition saved with what it uses re-derived reaches the new version */
export const testRederivedDependencyReachesNewVersion = () => {
  const { tcm, scratch } = setUp();
  scratch(`// tcm: namespace chain\nexport const a = () => 1;\nexport const b = () => a() * 10;\nexport const c = () => b() + 100;\n`);
  tcm("add");
  // a and c change together; b, between them and not in the file, is re-derived: c must use the new b
  scratch(`// tcm: namespace chain\nimport { b } from "#codebase/chain";\nexport const a = () => 2;\nexport const c = () => b() + 200;\n`);
  assert.match(tcm("update"), /~ updated +chain\.b \(dependent\)/);
  assert.equal(tcm("run", "chain.c").trim(), "220");
};

/** tests are definitions, cached by hash */
export const testTestsCachedByHash = () => {
  const { tcm, scratch } = setUp();
  scratch(`// tcm: namespace calc
import assert from "node:assert/strict";
export const double = (x: number) => x * 2;
export const testDouble = () => assert.equal(double(21), 42);
export const testBroken = () => { console.log("about to fail"); assert.equal(double(1), 3); };
export const offset = 10;
export const testUnrelated = () => assert.ok(offset > 0);
`);
  const checked = tcm("check");
  assert.match(checked, /tests\s+2 passed, 1 failed/);
  assert.match(checked, /✗ calc\.testBroken[\s\S]*2 !== 3[\s\S]*│ about to fail/);
  tcm("add");
  // check already ran them, so `tcm test` is all cache hits; failures still fail the command
  assert.throws(() => tcm("test", "calc"), /2 passed, 1 failed \(3 cached\)/);

  // changing what a test depends on re-runs exactly the tests that depend on it
  scratch(`// tcm: namespace calc\nexport const double = (x: number) => x * 2 + 1;\n`);
  tcm("update");
  let after = "";
  assert.throws(() => tcm("test", "calc"), (e: Error) => ((after = e.message), true));
  assert.match(after, /✓ calc\.testBroken\s+\d+ms/, "re-ran, and now passes");
  assert.match(after, /✗ calc\.testDouble\s+\d+ms[\s\S]*43 !== 42/, "re-ran, and now fails");
  assert.match(after, /✓ calc\.testUnrelated\s+\(cached\)/, "doesn't depend on double, so not re-run");
  assert.match(after, /2 passed, 1 failed \(1 cached\)/);
};

/** a type and a value can share a name */
export const testTypeAndValueShareName = () => {
  const { tcm, scratch } = setUp();
  scratch(`// tcm: namespace model
export const User = {
  parse(input: unknown): User {
    const o = input as { name?: unknown };
    if (typeof o.name !== "string") throw new TypeError("not a user");
    return { name: o.name };
  },
};
export type User = { name: string };
export type Box<T extends string = "x"> = { tag: T };
export const Box = <T extends string>(tag: T): Box<T> => ({ tag });
`);
  tcm("add");
  assert.doesNotMatch(tcm("ls", "model"), /conflicted/);
  scratch(`import { User, Box } from "#codebase/model";
export const greet = (u: User) => "hi " + u.name;
export const useBoth = () => greet(User.parse({ name: "ada" })) + " " + (Box("y") satisfies Box<"y">).tag;
`);
  tcm("add");
  assert.equal(tcm("run", "useBoth").trim(), "hi ada y");

  // updating the type leaves the value alone, and dependents follow the type
  scratch(`// tcm: namespace model\nexport type User = { name: string; admin?: boolean };\n`);
  const upd = tcm("update");
  assert.match(upd, /~ update\s+model\.User type/);
  assert.match(upd, /~ updated\s+greet/);
  const d = tcm("diff");
  assert.match(d, /edited\s+~ model\.User \(type\)/);
  // the value's code didn't change, but its `parse(): User` refers to the type, so it was re-hashed
  const [edited, propagated] = d.split("updated because a dependency changed");
  assert.doesNotMatch(edited!, /~ model\.User\s+#/);
  assert.match(propagated!, /~ model\.User\s+#.*via model\.User/);

  // a second value at model.User is a conflict in the value space only
  scratch(`export const User = 42;\n`);
  tcm("add", "--into", "model2");
  tcm("alias", "model2.User", "model.User");
  assert.match(tcm("todo"), /conflict model\.User/);
  assert.match(tcm("ls", "model.User"), /model\.User\s+#\w+\s+type(?! \(conflicted)/, "the type isn't part of the conflict");
};

/** top-level destructuring: each binding is a definition, the statement runs once */
export const testTopLevelDestructuring = () => {
  const { tcm, scratch, hashOf } = setUp();
  scratch(`// tcm: namespace cfg
const log: string[] = [];
function* numbers() { log.push("iterated"); yield 1; yield 2; yield 3; }
export const [first, second, ...rest] = numbers();
export const { host, port = 8080, nested: { flag } } = { host: "h", nested: { flag: true } } as { host: string; port?: number; nested: { flag: boolean } };
export const summary = () => [first, second, rest.join("+"), host, port, flag, log.length].join(" ");
`);
  assert.match(tcm("add"), /\+ new\s+cfg\.first[\s\S]*\+ new\s+cfg\.rest[\s\S]*\+ new\s+cfg\.flag/);
  assert.equal(tcm("run", "cfg.summary").trim(), "1 2 3 h 8080 true 1", "the generator was iterated once");
  assert.notEqual(hashOf("cfg.first"), hashOf("cfg.second"));

  // renaming one binding expands its shorthand and leaves the others alone
  tcm("mv", "cfg.host", "cfg.hostname");
  // stored formatted (oxfmt), one binding per line
  assert.match(tcm("view", "cfg.hostname"), /const \{\s+host: hostname,\s+port = 8080,\s+nested: \{ flag \},?\s+\} =/);
  assert.equal(tcm("run", "cfg.summary").trim(), "1 2 3 h 8080 true 1");
  assert.match(tcm("verify"), /rendering and re-hashing is the identity/);
};

/** the project's tsconfig.json decides lib and strictness; tcm's required options win */
export const testProjectTsconfig = () => {
  const { tcm, scratch, dir } = setUp();
  const tsconfigFile = path.join(dir, "tsconfig.json");
  const original = fs.readFileSync(tsconfigFile, "utf8");
  try {
    scratch(`export const pageTitle = () => document.title;\n`);
    const t = JSON.parse(original);
    t.compilerOptions.lib = ["esnext"];
    fs.writeFileSync(tsconfigFile, JSON.stringify(t));
    assert.throws(() => tcm("check"), /Cannot find name 'document'/, "a Node-only lib has no DOM");
    t.compilerOptions.lib = ["esnext", "dom"];
    t.compilerOptions.module = "commonjs";
    t.compilerOptions.noUnusedLocals = true;
    fs.writeFileSync(tsconfigFile, JSON.stringify(t));
    const out = tcm("check");
    assert.match(out, /\+ new\s+pageTitle/, "lib dom from the project's tsconfig");
    assert.match(out, /tcm requires `module` = NodeNext, ignoring the project's setting/);
    scratch(`export const f = () => { const unused = 1; return 2; };\n`);
    assert.throws(() => tcm("check"), /'unused' is declared but its value is never read/);
  } finally {
    fs.writeFileSync(tsconfigFile, original);
  }
};

/** dynamic import() loads a pinned package lazily */
export const testDynamicImportLoadsLazily = () => {
  const { tcm, scratch } = setUp();
  scratch(`export const lazyBase = async (p: string) => (await import("node:path")).basename(p);\n`);
  tcm("add");
  assert.equal(tcm("run", "lazyBase", "/a/b/report.txt").trim(), "report.txt");
  assert.match(tcm("view", "lazyBase"), /await import\("node:path"\)/);
};

/** rejects non-erasable and mutable top-level syntax */
export const testRejectsNonErasableAndMutableSyntax = () => {
  const { tcm, scratch } = setUp();
  scratch(`enum Color { Red }\n`);
  assert.throws(() => tcm("check"), /enums are not supported/);
  scratch(`export let counter = 0;\n`);
  assert.throws(() => tcm("check"), /immutable/);
};
