// Formatting with oxfmt, with nothing to set up. Formatting never changes a hash, so what's saved is formatted,
// and `tcm fmt` restyles stored code (after a `fmt.config` change) with no hash changing. Uses the npm registry.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { okIn, tempDir } from "./harness.ts";

function hashes(dir: string) {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT path, hash FROM names ORDER BY path").all();
  } finally {
    db.close();
  }
}

/** Fmt: what's saved is formatted, and restyling stored code changes no hash. */
export const testFmtRestylesWithNoHashChanging = () => {
  const dir = tempDir("fmt");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  const written = `// tcm: namespace lib\nexport function shout(s:string){return s.toUpperCase()+"!"}\nexport const greet=(n:string)=>shout("hi "+n)\n`;
  fs.writeFileSync(path.join(dir, "lib.ts"), written);
  tcm("add", "lib.ts");
  assert.equal(fs.readFileSync(path.join(dir, "lib.ts"), "utf8"), written, "the scratch file is left as written");
  assert.match(tcm("view", "lib.shout"), /export function shout\(s: string\) \{\n {2}return s\.toUpperCase\(\) \+ "!";\n\}/, "the codebase has it formatted");
  const before = hashes(dir);

  // a style change restyles everything stored, without a single hash changing
  fs.writeFileSync(path.join(dir, "f.ts"), `// tcm: namespace fmt\nexport const config = { singleQuote: true, semi: false };\n`);
  tcm("add", "f.ts");
  const fmt = tcm("fmt", "lib");
  assert.match(fmt, /reformatted 2 definition\(s\); no hashes changed/);
  assert.match(tcm("view", "lib.greet"), /shout\('hi ' \+ n\)/);
  assert.match(tcm("view", "lib.shout"), /return s\.toUpperCase\(\) \+ '!'\n/);
  assert.deepEqual(hashes(dir).filter((h) => !String(h.path).startsWith("fmt.")), before);
  assert.match(tcm("verify"), /rendering and re-hashing is the identity/);
  assert.match(tcm("fmt", "lib"), /everything is formatted/);
};
