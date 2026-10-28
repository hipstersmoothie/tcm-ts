import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Core from "../src/index.ts";

const { analyzeProject, IR_VERSION } = (await import(process.env.TCM_CORE ? path.resolve(process.env.TCM_CORE) : "../src/index.ts")) as typeof Core;

/**
 * IR v6 is frozen: these hashes are what existing codebases contain. A failure here means the hash format
 * changed. That needs a new IR_VERSION and a migration, not an update to these values.
 */
const PINNED: Record<string, string> = {
  Pair: "jpe45mxznzv3zyttfx7ygdfu66pvz3dxeg6fplynz6yamu6nms2a",
  Keys: "zftk22jy7dfirj6rht5ozld2jjbyxv4ytyqozocmdgkkobyfzila",
  Unwrap: "6r5zih7kja7tiw7hbcoepefwoapxz35pw7pgqy2knsz54qefpjea",
  Shape: "zkcb2bymdw73djrdaqobft7qlhbtbs2vrl4vx7pocimvozwfwjxa",
  first: "dhvdymuoxehwh4tpgufbc5swoaoimhkg6oa3ltjuljdjwbydma2q",
  tag: "ity4a3wxh7wrxsvks56xssfktj6hvsn6xzbp2meebuwtftturhfa",
  misc: "7uy3bmhj3gyy3mq42mehlyjo2ylnc6fbnr3bouqnz6kponoelcbq",
  Counter: "kzby6ahcvpvy77uwil4eykhypg55e4oubfuyxwngyb2erooiqlna",
  isEven: "5d5pohvux2kpswbvw4nasgxxx2qzwnxlqv4rl3g2ajg2iuuh73zq",
  isOdd: "ruefcw67un4u7ibher4p623ah6tuoyr6qyalu2nf3o7qutao2yua",
};

test("IR v6 hashes are frozen", () => {
  assert.equal(IR_VERSION, 6);
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
