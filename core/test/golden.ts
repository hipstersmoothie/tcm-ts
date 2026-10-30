import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeProject, IR_VERSION } from "../src/index.ts";

/** Definitions covering most syntax, whose hashes PINNED pins (as text: the test writes it to a file to analyze). */
const CORPUS = [
  "import { readFileSync } from \"node:fs\";",
  "import type * as fs from \"node:fs\";",
  "",
  "export type Pair<A, B = A> = readonly [first: A, second?: B];",
  "export type Keys<T> = { [K in keyof T as `get${Capitalize<string & K>}`]-?: () => T[K] };",
  "export type Unwrap<T> = T extends Promise<infer U> ? Unwrap<U> : T;",
  "export interface Shape {",
  "  readonly kind: \"circle\" | \"square\";",
  "  area(): number;",
  "  [extra: string]: unknown;",
  "}",
  "",
  "export function first<T>(xs: readonly T[]): T | undefined;",
  "export function first<T>(xs: readonly T[], fallback: T): T;",
  "export function first<T>(xs: readonly T[], fallback?: T): T | undefined {",
  "  return xs.length ? xs[0] : fallback;",
  "}",
  "",
  "export const tag = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values);",
  "export const misc = async function* (o?: { a?: { b?: () => number } }) {",
  "  const { a: { b } = {}, ...rest } = o ?? {};",
  "  label: for (const [i, x] of [1n, 0x10, 1e3].entries()) {",
  "    if (typeof x === \"bigint\") continue label;",
  "    yield (o?.a?.b?.() ?? i) satisfies number;",
  "  }",
  "  yield* [tag`a\\n${b}`, `t${rest}`, /re+/g.source, void 0, !!(b as unknown)];",
  "  return readFileSync;",
  "};",
  "",
  "export class Counter<T extends number = number> implements Pick<Shape, \"kind\"> {",
  "  static #instances = 0;",
  "  readonly kind = \"circle\" as const;",
  "  #n: T;",
  "  declare note?: string;",
  "  constructor(start: T) {",
  "    this.#n = start;",
  "    Counter.#instances++;",
  "  }",
  "  get value(): T {",
  "    return this.#n;",
  "  }",
  "  static {",
  "    Counter.#instances = 0;",
  "  }",
  "}",
  "",
  "export function isEven(n: number): boolean { return n === 0 || isOdd(n - 1); }",
  "export function isOdd(n: number): boolean { return n !== 0 && isEven(n - 1); }",
  "",
  "// `?` and `!` on members, interface `extends` and class `implements` (qualified too), holes in array patterns, and",
  "// strings starting with a byte order mark (TypeScript 7's API used to drop it when decoding)",
  "export interface Opt {",
  "  a?: number;",
  "  b: { c?: string };",
  "  m?(): void;",
  "}",
  "export interface Both extends Opt, fs.ObjectEncodingOptions {}",
  "export class Holder implements Opt, fs.ObjectEncodingOptions, Partial<fs.StatsBase<bigint>> {",
  "  a?: number;",
  "  b!: { c?: string };",
  "  declare d?: string;",
  "  m?(): void {}",
  "  encoding?: null;",
  "  dev?: bigint;",
  "}",
  "export const holes = (xs: readonly number[]) => {",
  "  const [, second, , ...rest] = xs;",
  "  return [second, rest, [, 1]];",
  "};",
  "export const bom = [\"\\uFEFF\", \"\\uFEFFx\", \"x\"] as const;",
].join("\n");

/**
 * What the corpus hashes to. A failure means the hash format changed: if that was meant, bump IR_VERSION (hash.ts)
 * and re-pin; if not, it's a bug (a TypeScript release that changed how code parses, say).
 */
const PINNED: Record<string, string> = {
  Pair: "2q7k4pkeus7ywx5q6mjwntxevqyy5tcdhtcqjbm4gbpgl2sfm4nq",
  Keys: "ay5jk3jfjelou7t5ssfe6vspmkyf54txd4zbt6krbpw3z5uyvodq",
  Unwrap: "umjg7da7eq46d2lmd5gk5s42lsxbtnwalzlhh6vakzzm56hvgg6a",
  Shape: "lilautlmh5marqpnunruq7obb5vqkewcdbro7y6kibu2nxmmovpq",
  first: "6tbc7v3ulttxzjkcu35h4tquwdzbs75h4d63lo7kdfjuws2kj2aq",
  tag: "glemsz7zgcdr4bhudshz2nvqjqutrhbviqzbannxcbwa7twhik3q",
  misc: "y4t77bwgvvb2yyqqsm2aofpasnsewsqcbk3igz2g3l3scgh4chsa",
  Counter: "nigr6h67zktubvx33buu7e4nqkxmnvz4xeje2ydlyrofbq7lgk5q",
  isEven: "rsyw3cvsggtcbhrpgszqmm6eyrlgmzmbuvn3rri6ohcwtcmarxda",
  isOdd: "a5xl4lkqbysohumnclqn46gnu2jd533bh2hsj3g234kyejice5jq",
  Opt: "fzcphmqze7amagupk4bqjwhdusoltfaeo2bddjimgsme4izgpr5a",
  Both: "yhukbyrygjt5osd3jx6k5lfre7yn55odrfnj4k3ftnd4x4w7lzyq",
  Holder: "tvvq3auirpvuawu3ntaiwyr2cmrgkvpc2r23ewndjim5wzuefklq",
  holes: "un7f3pp2mduul27hwqemtlxj2h4d6a2pkruth3pr223fjnmmgrnq",
  bom: "yc2gbcvqq6iastcclsfqtasnvsl42g7sngsv2rs6eixzqi2sprnq",
};

/** The hash format is pinned. */
export const testHashFormatIsPinned = () => {
  assert.equal(IR_VERSION, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-golden-"));
  const corpus = path.join(dir, "corpus.ts");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(corpus, CORPUS + "\n");
  // salted the way the CLI salts a fresh definition: by the path it is first added at
  const a = analyzeProject([corpus], {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "tcm-golden-")),
    resolveName: () => "",
    saltFor: (_file, name) => `golden.${name}`,
  });
  assert.deepEqual([...a.errors, ...a.diagnostics.map((d) => d.message)], []);
  assert.deepEqual(Object.fromEntries(a.defs.map((d) => [d.nameHint, d.hash])), PINNED);
};

/** Classes are nominal: their name is part of the hash. */
export const testClassesAreNominal = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-classes-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const file = path.join(dir, "errors.ts");
  fs.writeFileSync(file, `export class UsageError extends Error {}\nexport class ConflictError extends Error {}\nexport const a = () => 1;\nexport const b = () => 1;\nexport const x = 1;\nexport const y = 1;\n`);
  const a = analyzeProject([file], { cacheDir: dir, resolveName: () => "" });
  const h = Object.fromEntries(a.defs.map((d) => [d.nameHint, d.hash]));
  assert.notEqual(h.UsageError, h.ConflictError, "structurally identical classes stay distinct");
  assert.notEqual(h.a, h.b, "a function's name is observable (`a.name`), so it is hashed too");
  assert.equal(h.x, h.y, "a plain value's binding name is not observable");
};

/** Importing a module with top-level side effects is refused, with a reason. */
export const testModuleSideEffectsAreRefused = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-effects-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const file = path.join(dir, "kinds.ts");
  // skipping the loop would silently leave `names` empty, so it must be an error, not a warning
  fs.writeFileSync(file, `export const names: string[] = [];\nfor (const n of ["a", "b"]) names.push(n);\n`);
  const a = analyzeProject([file], { cacheDir: dir, resolveName: () => "" });
  assert.match(a.errors.join("\n"), /top-level ForOfStatement: tcm stores definitions, not module side effects/);
};
