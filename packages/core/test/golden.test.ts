import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Core from "../src/index.ts";

const { analyzeProject, IR_VERSION } = (await import(process.env.UCM_CORE ? path.resolve(process.env.UCM_CORE) : "../src/index.ts")) as typeof Core;

/**
 * IR v4 is frozen: these hashes are what existing codebases contain. A failure here means the hash format
 * changed. That needs a new IR_VERSION and a migration, not an update to these values.
 */
const PINNED: Record<string, string> = {
  Pair: "t2enm5qiu35vnqh3fg4ohqkcsbiy34cy2vgxmwwc6e5o2clwkvna",
  Keys: "td5swpxegbue3dxn4ssy3g6q2sejtgjcgylmdwy75pgtegdlkhxa",
  Unwrap: "xdsmbkb6mjcp6p3op5tsp4i4brxpji64csmgxnnwr6p3esvohjhq",
  Shape: "3uevpakez7siabygtw7uiyvwnx3cit5xsvx2gmckpcgxn5dqur4a",
  first: "szbubjcpjyemb3gzvbrxparmwsyicqbge4nduyzhnzklicash57a",
  tag: "gsjlzwvdiakwii7vc64uhhvsvxhau5nktxnc4vox3frvzzteqgjq",
  misc: "nhvn7sh33igmp7vuhyjqjxbta35qdtsjmtnintweqxuuylyhzyxq",
  Counter: "ikrda3wmyh2u2wsihqs2xvhmfsskvvpinlrkk5j7i7i6wh5y4a3q",
  isEven: "7vtz56bm6mrjqsoygblucklnpgeyniriqb6a7u3vd7yh4i2ylnzq",
  isOdd: "i5nodgsxbylo4jjx66kafxcfa4efalmwg5q67hfjvrc3iogjym7a",
};

test("IR v4 hashes are frozen", () => {
  assert.equal(IR_VERSION, 4);
  const corpus = fileURLToPath(new URL("./golden/corpus.ts", import.meta.url));
  // salted the way the CLI salts a fresh definition: by the path it is first added at
  const a = analyzeProject([corpus], {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "ucm-golden-")),
    resolveName: () => "",
    saltFor: (_file, name) => `golden.${name}`,
  });
  assert.deepEqual([...a.errors, ...a.diagnostics.map((d) => d.message)], []);
  assert.deepEqual(Object.fromEntries(a.defs.map((d) => [d.nameHint, d.hash])), PINNED);
});

test("classes are nominal: their name is part of the hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm-classes-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm-effects-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const file = path.join(dir, "kinds.ts");
  // skipping the loop would silently leave `names` empty, so it must be an error, not a warning
  fs.writeFileSync(file, `export const names: string[] = [];\nfor (const n of ["a", "b"]) names.push(n);\n`);
  const a = analyzeProject([file], { cacheDir: dir, resolveName: () => "" });
  assert.match(a.errors.join("\n"), /top-level ForOfStatement: ucm stores definitions, not module side effects/);
});
