import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// UCM_BIN runs the same scenario against another build, e.g. the self-hosted one in selfhost/ucm.ts
const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
// a space in the path catches quoting bugs in generated imports and spawned processes
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm e2e "));

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}

const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
const hashOf = (name: string) => /#([a-z2-7]{8})/.exec(ucm("ls", name).split("\n").find((l) => l.startsWith(name + " "))!)![1];

test("init → add → mv → update → todo → edit → run", () => {
  ucm("init");
  assert.match(ucm("check"), /⧩ 144/);
  ucm("add");

  scratch(`// ucm: namespace lib
import { square } from "#codebase";
export function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1) }
export function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1) }
export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 0);
export const main = (...args: string[]) => \`\${sumSquares(args.map(Number))} \${isEven(args.length)}\`;
`);
  assert.match(ucm("add"), /\+ new\s+lib\.main/);
  assert.equal(ucm("run", "lib.main", "1", "2").trim(), "5 true");

  // renames are metadata: dependents keep their hash and render with the new name
  const before = hashOf("lib.sumSquares");
  ucm("mv", "square", "math.sq");
  assert.match(ucm("diff"), /renamed\s+> square → math\.sq/);
  assert.equal(hashOf("lib.sumSquares"), before);
  assert.match(ucm("view", "lib.sumSquares"), /import \{ sq \} from "#codebase\/math";[\s\S]*xs\.map\(sq\)/);

  // rendering a definition and re-hashing it is the identity
  ucm("edit", "lib.sumSquares", "lib.main", "--file", "roundtrip.ts");
  assert.match(ucm("check", "roundtrip.ts"), /= identical\s+lib\.sumSquares[\s\S]*= identical\s+lib\.main/);
  // across namespaces, including a function renamed by `mv` (it keeps its runtime name `square`)
  ucm("edit", "lib.sumSquares", "math.sq", "--file", "cross.ts");
  const cross = fs.readFileSync(path.join(dir, "cross.ts"), "utf8");
  assert.match(cross, /\/\/ ucm: path math\.sq\nconst square =/);
  assert.match(ucm("check", "cross.ts"), /= identical\s+lib\.sumSquares[\s\S]*= identical\s+math\.sq/);

  // a compatible update propagates to dependents
  scratch(`// ucm: namespace math\nexport const sq = (x: number): number => x * x * x;\n`);
  const upd = ucm("update");
  assert.match(upd, /~ updated\s+lib\.sumSquares/);
  assert.match(upd, /~ updated\s+lib\.main/);
  assert.equal(ucm("run", "lib.main", "1", "2").trim(), "9 true");

  // diff separates the edit from dependents that were only re-hashed because of it
  const d = ucm("diff");
  assert.match(d, /changes from `update scratch\.ts`/);
  // `mv square math.sq` kept the function's runtime name; this edit declares `sq`, so the name changes too
  assert.match(d, /edited\s+~ math\.sq[\s\S]*- const square = \(x: number\): number => x \* x\n\s+\+ const sq = \(x: number\): number => x \* x \* x/);
  assert.match(d, /updated because a dependency changed[\s\S]*lib\.main .* via lib\.sumSquares[\s\S]*lib\.sumSquares .* via math\.sq/);
  assert.doesNotMatch(d.split("updated because")[0]!, /lib\.sumSquares/, "propagated definitions are not listed as edits");

  // an incompatible update leaves dependents on the old version and lists them in todo
  scratch(`// ucm: namespace math\nexport const sq = (x: string): string => x + x;\n`);
  ucm("update");
  assert.match(ucm("todo"), /needs fixing lib\.sumSquares/);
  assert.equal(ucm("run", "lib.main", "1", "2").trim(), "9 true");

  // edit the todo item against the new definition, fix it, update
  ucm("edit", "lib.sumSquares", "--force");
  const text = fs.readFileSync(path.join(dir, "scratch.ts"), "utf8");
  assert.match(text, /import \{ sq \} from "#codebase\/math"/);
  scratch(text.replace("xs.map(sq)", "xs.map(String).map(sq).map(Number)"));
  ucm("update");
  assert.match(ucm("todo"), /nothing to do/);
  assert.equal(ucm("run", "lib.main", "4").trim(), "44 false");
});

test("classes keep their identity and runtime name through renames", () => {
  scratch(`// ucm: namespace errors
export class UsageError extends Error {}
export class ConflictError extends Error {}
export const probe = () => [new UsageError("u") instanceof ConflictError, new ConflictError("c").constructor.name].join(" ");
`);
  ucm("add");
  assert.equal(ucm("run", "errors.probe").trim(), "false ConflictError");
  assert.match(ucm("mv", "errors.ConflictError", "errors.Clash"), /still named `ConflictError` at runtime/);
  assert.equal(ucm("run", "errors.probe").trim(), "false ConflictError");
  assert.match(ucm("view", "errors.Clash"), /class ConflictError extends Error/);
  // editing it binds it back to errors.Clash, not to a fresh errors.ConflictError
  ucm("edit", "errors.Clash", "--file", "clash.ts");
  assert.match(ucm("check", "clash.ts"), /= identical\s+errors\.Clash/);
});

test("separately declared definitions keep separate identities", () => {
  // two identical stateful values are two objects, as in plain TypeScript
  scratch(`// ucm: namespace state
export const cacheA = new Map<string, number>();
export const cacheB = new Map<string, number>();
export const probe = () => { cacheA.set("k", 1); return String(cacheA === cacheB) + " " + cacheB.size; };
`);
  ucm("add");
  assert.equal(ucm("run", "state.probe").trim(), "false 0");
  assert.match(ucm("check"), /= identical\s+state\.cacheA[\s\S]*= identical\s+state\.cacheB/, "re-checking reproduces the same hashes");

  // the same class source added in two namespaces is two classes
  const errSource = `export class AppError extends Error {}\n`;
  scratch(errSource);
  ucm("add", "--into", "one");
  ucm("add", "--into", "two");
  assert.notEqual(hashOf("one.AppError"), hashOf("two.AppError"));
  scratch(`import { AppError as One } from "#codebase/one";\nimport { AppError as Two } from "#codebase/two";\nexport const crossCheck = () => new One() instanceof Two;\n`);
  ucm("add");
  assert.equal(ucm("run", "crossCheck").trim(), "false");

  // renaming keeps both the hash and the runtime name
  const before = hashOf("state.probe");
  assert.match(ucm("mv", "state.probe", "state.check"), /still named `probe` at runtime/);
  assert.equal(hashOf("state.check"), before);
});

test("tests are definitions, cached by hash", () => {
  scratch(`// ucm: namespace calc
import assert from "node:assert/strict";
export const double = (x: number) => x * 2;
export const testDouble = () => assert.equal(double(21), 42);
export const testBroken = () => { console.log("about to fail"); assert.equal(double(1), 3); };
export const offset = 10;
export const testUnrelated = () => assert.ok(offset > 0);
`);
  const checked = ucm("check");
  assert.match(checked, /tests\s+2 passed, 1 failed/);
  assert.match(checked, /✗ calc\.testBroken[\s\S]*2 !== 3[\s\S]*│ about to fail/);
  ucm("add");
  // check already ran them, so `ucm test` is all cache hits; failures still fail the command
  assert.throws(() => ucm("test", "calc"), /2 passed, 1 failed \(3 cached\)/);

  // changing what a test depends on re-runs exactly the tests that depend on it
  scratch(`// ucm: namespace calc\nexport const double = (x: number) => x * 2 + 1;\n`);
  ucm("update");
  let after = "";
  assert.throws(() => ucm("test", "calc"), (e: Error) => ((after = e.message), true));
  assert.match(after, /✓ calc\.testBroken\s+\d+ms/, "re-ran, and now passes");
  assert.match(after, /✗ calc\.testDouble\s+\d+ms[\s\S]*43 !== 42/, "re-ran, and now fails");
  assert.match(after, /✓ calc\.testUnrelated\s+\(cached\)/, "doesn't depend on double, so not re-run");
  assert.match(after, /2 passed, 1 failed \(1 cached\)/);
});

test("a type and a value can share a name", () => {
  scratch(`// ucm: namespace model
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
  ucm("add");
  assert.doesNotMatch(ucm("ls", "model"), /conflicted/);
  scratch(`import { User, Box } from "#codebase/model";
export const greet = (u: User) => "hi " + u.name;
export const useBoth = () => greet(User.parse({ name: "ada" })) + " " + (Box("y") satisfies Box<"y">).tag;
`);
  ucm("add");
  assert.equal(ucm("run", "useBoth").trim(), "hi ada y");

  // updating the type leaves the value alone, and dependents follow the type
  scratch(`// ucm: namespace model\nexport type User = { name: string; admin?: boolean };\n`);
  const upd = ucm("update");
  assert.match(upd, /~ update\s+model\.User type/);
  assert.match(upd, /~ updated\s+greet/);
  const d = ucm("diff");
  assert.match(d, /edited\s+~ model\.User \(type\)/);
  // the value's code didn't change, but its `parse(): User` refers to the type, so it was re-hashed
  const [edited, propagated] = d.split("updated because a dependency changed");
  assert.doesNotMatch(edited!, /~ model\.User\s+#/);
  assert.match(propagated!, /~ model\.User\s+#.*via model\.User/);

  // a second value at model.User is a conflict in the value space only
  scratch(`export const User = 42;\n`);
  ucm("add", "--into", "model2");
  ucm("alias", "model2.User", "model.User");
  assert.match(ucm("todo"), /conflict model\.User/);
  assert.match(ucm("ls", "model.User"), /model\.User\s+#\w+\s+type(?! \(conflicted)/, "the type isn't part of the conflict");
});

test("top-level destructuring: each binding is a definition, the statement runs once", () => {
  scratch(`// ucm: namespace cfg
const log: string[] = [];
function* numbers() { log.push("iterated"); yield 1; yield 2; yield 3; }
export const [first, second, ...rest] = numbers();
export const { host, port = 8080, nested: { flag } } = { host: "h", nested: { flag: true } } as { host: string; port?: number; nested: { flag: boolean } };
export const summary = () => [first, second, rest.join("+"), host, port, flag, log.length].join(" ");
`);
  assert.match(ucm("add"), /\+ new\s+cfg\.first[\s\S]*\+ new\s+cfg\.rest[\s\S]*\+ new\s+cfg\.flag/);
  assert.equal(ucm("run", "cfg.summary").trim(), "1 2 3 h 8080 true 1", "the generator was iterated once");
  assert.notEqual(hashOf("cfg.first"), hashOf("cfg.second"));

  // renaming one binding expands its shorthand and leaves the others alone
  ucm("mv", "cfg.host", "cfg.hostname");
  assert.match(ucm("view", "cfg.hostname"), /const \{ host: hostname, port = 8080, nested: \{ flag \} \} =/);
  assert.equal(ucm("run", "cfg.summary").trim(), "1 2 3 h 8080 true 1");
  assert.match(ucm("verify"), /rendering and re-hashing is the identity/);
});

test("the project's tsconfig.json decides lib and strictness; ucm's required options win", () => {
  const tsconfigFile = path.join(dir, "tsconfig.json");
  const original = fs.readFileSync(tsconfigFile, "utf8");
  try {
    scratch(`export const pageTitle = () => document.title;\n`);
    assert.throws(() => ucm("check"), /Cannot find name 'document'/, "init's tsconfig targets Node: no DOM");
    const t = JSON.parse(original);
    t.compilerOptions.lib = ["esnext", "dom"];
    t.compilerOptions.module = "commonjs";
    t.compilerOptions.noUnusedLocals = true;
    fs.writeFileSync(tsconfigFile, JSON.stringify(t));
    const out = ucm("check");
    assert.match(out, /\+ new\s+pageTitle/, "lib dom from the project's tsconfig");
    assert.match(out, /ucm requires `module` = NodeNext, ignoring the project's setting/);
    scratch(`export const f = () => { const unused = 1; return 2; };\n`);
    assert.throws(() => ucm("check"), /'unused' is declared but its value is never read/);
  } finally {
    fs.writeFileSync(tsconfigFile, original);
  }
});

test("rejects non-erasable and mutable top-level syntax", () => {
  scratch(`enum Color { Red }\n`);
  assert.throws(() => ucm("check"), /enums are not supported/);
  scratch(`export let counter = 0;\n`);
  assert.throws(() => ucm("check"), /immutable/);
});
