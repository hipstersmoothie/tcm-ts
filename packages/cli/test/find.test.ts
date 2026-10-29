import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm find "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

function tcm(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
}
const ok = (...args: string[]) => {
  const r = tcm(...args);
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
};
/** The names `find` lists, in order. */
const found = (query: string) => [...ok("find", query).matchAll(/^(\S+)  #/gm)].map((m) => m[1]);

test("find by type: up to renaming, reordered, awaited, more general or specific; codebase types by hash", () => {
  ok("init");
  fs.writeFileSync(
    path.join(dir, "scratch.ts"),
    `// tcm: namespace lib
export type User = { name: string; age: number };
export const head = <T>(xs: T[]): T | undefined => xs[0];
export const first = <A>(xs: A[]): A | undefined => xs[0];
export const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
export const repeat = (s: string, n: number): string => s.repeat(n);
export const nameOf = (u: User): string => u.name;
export async function loadUser(id: string): Promise<User> {
  return { name: id, age: 0 };
}
`,
  );
  ok("add");

  // the same type up to type-variable names; unknown names in the query are type variables
  assert.deepEqual(found(":(xs: T[]) => T | undefined"), ["lib.first", "lib.head"]);
  assert.match(ok("find", ":(xs: a[]) => a"), /type variables: a/);
  // exact first, then the instance or generalization
  assert.deepEqual(found(":(xs: a[]) => a"), ["lib.last", "lib.sum"]);
  assert.match(ok("find", ":(xs: a[]) => a"), /lib\.sum .*more specific/);
  assert.deepEqual(found(":(xs: number[]) => number"), ["lib.sum", "lib.last"]);
  assert.match(ok("find", ":(xs: number[]) => number"), /lib\.last .*more general/);
  assert.match(ok("find", ":(n: number, s: string) => string"), /lib\.repeat .*arguments reordered/);
  assert.match(ok("find", ":(id: string) => User"), /lib\.loadUser .*async/);
  assert.deepEqual(found(":(u: lib.User) => string"), ["lib.nameOf"]);

  // shapes refer to types by hash: a rename doesn't lose the match
  ok("mv", "lib.User", "lib.Person");
  assert.deepEqual(found(":(p: Person) => string"), ["lib.nameOf"]);

  // a name the query can't pin down says so
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace other\nexport type Person = { id: string };\n`);
  ok("add");
  const ambiguous = tcm("find", ":(p: Person) => string");
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.out, /'Person' in the query could be lib\.Person, other\.Person/);
  assert.match(tcm("find", ":(x: ").out, /isn't a TypeScript type/);
});
