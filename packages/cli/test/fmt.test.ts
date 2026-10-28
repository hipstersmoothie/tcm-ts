import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Formatting with oxfmt, with nothing to set up. Formatting never changes a hash, so what's saved is formatted,
// and `tcm fmt` restyles stored code (after a `fmt.config` change) with no hash changing. Uses the npm registry.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm fmt "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const tcm = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
};
const hashes = () => {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT path, hash FROM names ORDER BY path").all();
  } finally {
    db.close();
  }
};

test("fmt: what's saved is formatted, and restyling stored code changes no hash", () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  const written = `// tcm: namespace lib\nexport function shout(s:string){return s.toUpperCase()+"!"}\nexport const greet=(n:string)=>shout("hi "+n)\n`;
  fs.writeFileSync(path.join(dir, "lib.ts"), written);
  tcm("add", "lib.ts");
  assert.equal(fs.readFileSync(path.join(dir, "lib.ts"), "utf8"), written, "the scratch file is left as written");
  assert.match(tcm("view", "lib.shout"), /export function shout\(s: string\) \{\n {2}return s\.toUpperCase\(\) \+ "!";\n\}/, "the codebase has it formatted");
  const before = hashes();

  // a style change restyles everything stored, without a single hash changing
  fs.writeFileSync(path.join(dir, "f.ts"), `// tcm: namespace fmt\nexport const config = { singleQuote: true, semi: false };\n`);
  tcm("add", "f.ts");
  const fmt = tcm("fmt", "lib");
  assert.match(fmt, /reformatted 2 definition\(s\); no hashes changed/);
  assert.match(tcm("view", "lib.greet"), /shout\('hi ' \+ n\)/);
  assert.match(tcm("view", "lib.shout"), /return s\.toUpperCase\(\) \+ '!'\n/);
  assert.deepEqual(hashes().filter((h) => !String(h.path).startsWith("fmt.")), before);
  assert.match(tcm("verify"), /rendering and re-hashing is the identity/);
  assert.match(tcm("fmt", "lib"), /everything is formatted/);
});
