import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Core from "../src/index.ts";

const { analyzeProject, IR_VERSION } = (await import(process.env.TCM_CORE ? path.resolve(process.env.TCM_CORE) : "../src/index.ts")) as typeof Core;

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

test("the hash format is pinned", () => {
  assert.equal(IR_VERSION, 1);
  const corpus = fileURLToPath(new URL("./golden/corpus.ts", import.meta.url));
  // salted the way the CLI salts a fresh definition: by the path it is first added at
  const a = analyzeProject([corpus], {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "tcm-golden-")),
    resolveName: () => "",
    saltFor: (_file, name) => `golden.${name}`,
  });
  assert.deepEqual([...a.errors, ...a.diagnostics.map((d) => d.message)], []);
  assert.deepEqual(Object.fromEntries(a.defs.map((d) => [d.nameHint, d.hash])), PINNED);
});

test("classes are nominal: their name is part of the hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-classes-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const file = path.join(dir, "errors.ts");
  fs.writeFileSync(file, `export class UsageError extends Error {}\nexport class ConflictError extends Error {}\nexport const a = () => 1;\nexport const b = () => 1;\nexport const x = 1;\nexport const y = 1;\n`);
  const a = analyzeProject([file], { cacheDir: dir, resolveName: () => "" });
  const h = Object.fromEntries(a.defs.map((d) => [d.nameHint, d.hash]));
  assert.notEqual(h.UsageError, h.ConflictError, "structurally identical classes stay distinct");
  assert.notEqual(h.a, h.b, "a function's name is observable (`a.name`), so it is hashed too");
  assert.equal(h.x, h.y, "a plain value's binding name is not observable");
});

test("importing a module with top-level side effects is refused, with a reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-effects-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const file = path.join(dir, "kinds.ts");
  // skipping the loop would silently leave `names` empty, so it must be an error, not a warning
  fs.writeFileSync(file, `export const names: string[] = [];\nfor (const n of ["a", "b"]) names.push(n);\n`);
  const a = analyzeProject([file], { cacheDir: dir, resolveName: () => "" });
  assert.match(a.errors.join("\n"), /top-level ForOfStatement: tcm stores definitions, not module side effects/);
});
