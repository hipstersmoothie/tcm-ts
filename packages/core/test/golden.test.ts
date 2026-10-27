import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Core from "../src/index.ts";

const { analyzeProject, IR_VERSION } = (await import(process.env.UCM_CORE ? path.resolve(process.env.UCM_CORE) : "../src/index.ts")) as typeof Core;

/**
 * IR v5 is frozen: these hashes are what existing codebases contain. A failure here means the hash format
 * changed. That needs a new IR_VERSION and a migration, not an update to these values.
 */
const PINNED: Record<string, string> = {
  Pair: "7meffkd2qxnp4ss2kzegble32jfqfmp55czwdlds3cq6dppeklyq",
  Keys: "2s5lsm367dttxzoefxzadp6ataifqfpyr4pxwbngebkmasmg24ca",
  Unwrap: "h2tuf3pel2q7u27ew3dou56h2vmmhdsnzx3w2ltraf4lc4qsqmdq",
  Shape: "3trkkyumsx7ququqj3w264kupaumyv3lpinmgozxdzqwlkxus7ia",
  first: "rfap7xpv6iqaqgq3y6wjo6z2f76xubm4cquf5h5ucfgcwukzvb3a",
  tag: "gnm2w3exliddq5lckklkti5w2p6kwgf6zzeacr7ezy5xbw2etf2a",
  misc: "m7dm5p5ry6wmm2agydsf5s7fddaeszscyvxw4ac5xt4ntu7kbh4q",
  Counter: "f4cahoxrkrijqwke6rjtchthzeyenbxxfqwlw6pvy3qt7pqpdnta",
  isEven: "pj2ouftvwv4jqo2rffcz2ywbp3vgslucjnwvj5ebbqqdzkqypccq",
  isOdd: "5wfdt2xho6ucgsyzbhceyt5kclzakj2kqyngxnhghzfpy6amq2ia",
};

test("IR v5 hashes are frozen", () => {
  assert.equal(IR_VERSION, 5);
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
