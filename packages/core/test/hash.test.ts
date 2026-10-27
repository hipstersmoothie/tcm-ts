import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as Core from "../src/index.ts";
import type { Analysis } from "../src/index.ts";

// UCM_CORE runs these tests against another build of the analyzer, e.g. the self-hosted one in selfhost/core.ts
const { analyzeFile, analyzeProject } = (await import(process.env.UCM_CORE ? path.resolve(process.env.UCM_CORE) : "../src/index.ts")) as typeof Core;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm-core-"));
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
let n = 0;

function analyze(source: string): Analysis {
  const file = path.join(dir, `f${n++}.ts`);
  fs.writeFileSync(file, source);
  const a = analyzeFile(file, {
    cacheDir: path.join(dir, ".ucm", "cache"),
    resolveName: (name) => {
      throw new Error(`unknown ${name}`);
    },
  });
  assert.deepEqual(a.diagnostics.map((d) => d.message), []);
  assert.deepEqual(a.errors, []);
  return a;
}

const hashes = (src: string) => Object.fromEntries(analyze(src).defs.map((d) => [d.nameHint, d.hash]));

test("local renames, formatting, comments and export do not change the hash", () => {
  const a = hashes(`export function sum(xs: number[]): number { let total = 0; for (const x of xs) total += x; return total }`);
  const b = hashes(`
    /** docs are metadata */
    function sum(values: number[]): number {
      let acc = 0 // running total
      for (const v of values) acc += v
      return acc
    }`);
  assert.equal(a.sum, b.sum);
});

test("a value's own name is not part of its hash, a function's is (it's observable as .name)", () => {
  assert.equal(hashes(`const xs = [1, 2]`).xs, hashes(`const ys = [1, 2]`).ys);
  assert.notEqual(hashes(`const inc = (x: number) => x + 1`).inc, hashes(`const plusOne = (x: number) => x + 1`).plusOne);
  assert.notEqual(hashes(`class A extends Error {}`).A, hashes(`class B extends Error {}`).B);
});

test("local names are alpha-renamable unless they become a runtime name", () => {
  // parameters and plain locals: renaming is invisible
  assert.equal(hashes(`const f = (x: number) => { const y = x + 1; return y }`).f, hashes(`const f = (a: number) => { const b = a + 1; return b }`).f);
  // local function names, and bindings that name an anonymous function, are visible through .name
  assert.notEqual(hashes(`function outer() { function a() {} return a }`).outer, hashes(`function outer() { function b() {} return b }`).outer);
  assert.notEqual(hashes(`const f = () => { const g = () => 1; return g }`).f, hashes(`const f = () => { const h = () => 1; return h }`).f);
  assert.notEqual(hashes(`const f = (cb = () => 1) => cb`).f, hashes(`const f = (fn = () => 1) => fn`).f);
  assert.notEqual(hashes(`const f = () => { let g; g = () => 1; return g }`).f, hashes(`const f = () => { let h; h = () => 1; return h }`).f);
});

test("literal spelling is normalized, values are not", () => {
  const a = hashes(`const k = 1_000; const s = 'hi'; const o = { a: 1 }.a`);
  const b = hashes(`const k = 0x3e8; const s = "hi"; const o = { a: 1 }["a"]`);
  assert.deepEqual(a, b);
  assert.notEqual(hashes(`const k = 1001`).k, a.k);
});

test("types and property names are part of the hash", () => {
  assert.notEqual(hashes(`const f = (x: number) => x`).f, hashes(`const f = (x: string) => x`).f);
  assert.notEqual(hashes(`const p = (o: any) => o.a`).p, hashes(`const p = (o: any) => o.b`).p);
  // `{ a }` binds a local but also names a property
  assert.notEqual(hashes(`const g = (o: any) => { const { a } = o; return a }`).g, hashes(`const g = (o: any) => { const { b } = o; return b }`).g);
});

test("dependencies are referenced by hash, so the name a dependency is referenced by doesn't matter", () => {
  const a = hashes(`const base = 2; const scale = (x: number) => x * base`);
  const b = hashes(`const two = 2; const scale = (x: number) => x * two`);
  assert.equal(a.base, b.two);
  assert.equal(a.scale, b.scale);
  const c = hashes(`const base = 3; const scale = (x: number) => x * base`);
  assert.notEqual(c.scale, a.scale, "changing a dependency changes dependents");
});

test("mutually recursive definitions hash as a cycle, independent of source order", () => {
  const a = analyze(`
    function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1) }
    function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1) }`).defs;
  const b = analyze(`
    function isOdd(k: number): boolean { return k === 0 ? false : isEven(k - 1) }
    function isEven(k: number): boolean { return k === 0 ? true : isOdd(k - 1) }`).defs;
  assert.equal(a[0]!.componentSize, 2);
  assert.equal(a[0]!.componentHash, b[0]!.componentHash);
  const byName = (ds: typeof a) => Object.fromEntries(ds.map((d) => [d.nameHint, d.hash]));
  assert.equal(byName(a).isEven, byName(b).isEven);
  assert.equal(byName(a).isOdd, byName(b).isOdd);
  assert.notEqual(byName(a).isEven, byName(a).isOdd);
});

test("globals and locals with the same name are distinguished", () => {
  const a = hashes(`const f = () => Math.max(1, 2)`);
  const b = hashes(`const f = () => { const Math = { max: (a: number, b: number) => a }; return Math.max(1, 2) }`);
  assert.notEqual(a.f, b.f);
});

test("watch expressions are analyzed but kept apart from definitions", () => {
  const a = analyze(`const sq = (x: number) => x * x\nsq(4)`);
  assert.equal(a.defs.length, 1);
  assert.equal(a.watches.length, 1);
  assert.equal(a.watches[0]!.expression, "sq(4)");
  assert.deepEqual(a.watches[0]!.deps.map((d) => d.ref), [`#${a.defs[0]!.hash}`]);
});

test("unsupported constructs are rejected with a reason", () => {
  const file = path.join(dir, `bad${n++}.ts`);
  fs.writeFileSync(file, `let counter = 0`);
  const a = analyzeFile(file, { cacheDir: dir, resolveName: () => "" });
  assert.match(a.errors[0]!, /immutable/);
});

function project(files: Record<string, string>) {
  const sub = fs.mkdtempSync(path.join(dir, "proj-"));
  const paths = Object.entries(files).map(([name, text]) => {
    const file = path.join(sub, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  });
  const a = analyzeProject(paths, { cacheDir: path.join(sub, ".ucm", "cache"), resolveName: () => "" });
  assert.deepEqual([...a.diagnostics.map((d) => d.message), ...a.errors], []);
  return Object.fromEntries(a.defs.map((d) => [d.nameHint, d]));
}

test("splitting code across files and re-exporting through barrels does not change hashes", () => {
  const one = hashes(`const double = (x: number) => x * 2; const quad = (x: number) => double(double(x))`);
  const split = project({
    "math/double.ts": `export const double = (x: number) => x * 2;`,
    "math/index.ts": `export * from "./double.ts";`,
    "quad.ts": `import { double as twice } from "./math/index.ts";\nexport const quad = (x: number) => twice(twice(x));`,
  });
  assert.equal(split.double!.hash, one.double);
  assert.equal(split.quad!.hash, one.quad);
});

test("import cycles between files become hash cycles", () => {
  const p = project({
    "even.ts": `import { isOdd } from "./odd.ts";\nexport function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1) }`,
    "odd.ts": `import { isEven } from "./even.ts";\nexport function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1) }`,
  });
  const single = analyze(`
    function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1) }
    function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1) }`).defs;
  assert.equal(p.isEven!.componentSize, 2);
  assert.equal(p.isEven!.componentHash, single[0]!.componentHash);
});

test("optional children are labelled by slot", () => {
  // without slot labels, `(): T => x` and `() => x` style ambiguities could collide; check a few near-misses
  const a = hashes(`class A { m?(): void {} }`);
  const b = hashes(`class A { m(): void {} }`);
  assert.notEqual(a.A, b.A);
  assert.notEqual(hashes(`const f = function g() { return 1 }`).f, hashes(`const f = function () { return 1 }`).f);
});

test("a lineage salt gives identical code separate identities", () => {
  const file = path.join(dir, `salted${n++}.ts`);
  fs.writeFileSync(file, `export const cacheA = new Map<string, number>();\nexport const cacheB = new Map<string, number>();\n`);
  const run = (saltFor?: (f: string, name: string) => string | undefined) =>
    Object.fromEntries(analyzeProject([file], { cacheDir: dir, resolveName: () => "", saltFor }).defs.map((d) => [d.nameHint, d.hash]));
  const unsalted = run();
  assert.equal(unsalted.cacheA, unsalted.cacheB, "without salts, identical code is one definition");
  const salted = run((_f, name) => `lib.${name}`);
  assert.notEqual(salted.cacheA, salted.cacheB, "two `new Map()`s are two maps");
  assert.deepEqual(run((_f, name) => `lib.${name}`), salted, "the same salts reproduce the same hashes");
});

test("shorthand and explicit property forms hash the same", () => {
  assert.equal(hashes(`const f = (o: { a: number }) => { const { a } = o; return { a } }`).f, hashes(`const f = (o: { a: number }) => { const { a: a } = o; return { a: a } }`).f);
  assert.equal(hashes(`const f = (o: { a?: number }) => { const { a = 1 } = o; return a }`).f, hashes(`const f = (o: { a?: number }) => { const { a: a = 1 } = o; return a }`).f);
  assert.equal(hashes(`const x = 1; const f = () => ({ x })`).f, hashes(`const x = 1; const f = () => ({ x: x })`).f);
});
