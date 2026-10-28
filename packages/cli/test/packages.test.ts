import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// npm packages end to end, with nothing installed in the project: tcm provides what scratch files import, pins
// definitions by compatible range, runs one locked version per range, upgrades within a range (no hashes change)
// and across ranges (re-pinned and re-hashed, peers moving along), and refuses an app that mixes ranges of a
// package others are built against. Uses the npm registry.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm packages "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

function tcm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const fails = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  assert.notEqual(r.status, 0, `tcm ${args.join(" ")} should fail`);
  return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
};
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const sql = (q: string, ...p: string[]) => {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"));
  try {
    return db.prepare(q).all(...p) as Record<string, string>[];
  } finally {
    db.close();
  }
};
const hashOf = (name: string) => sql("SELECT hash FROM names WHERE path = ?", name)[0]!.hash!;

test("packages: provided without installing, pinned by range, one version per range, upgrades and guards", () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  write("time.ts", `// tcm: namespace time\nimport ms from "ms";\nexport const short = (n: number): string => ms(n);\n\nshort(90_000);\n`);
  assert.match(tcm("check", "time.ts"), /⧩ '2m'/, "imported with nothing installed");
  assert.ok(!fs.existsSync(path.join(dir, "node_modules")), "the project has no node_modules");
  tcm("add", "time.ts");
  fs.rmSync(path.join(dir, "time.ts"));
  assert.equal(tcm("deps", "time.short").trim(), "npm:ms@2#default", "pinned by compatible range");
  const locked = sql("SELECT version FROM packages WHERE name = 'ms' AND range = '2'")[0]!.version!;
  assert.match(tcm("packages"), new RegExp(`ms\\s+2\\s+${locked.replaceAll(".", "\\.")}\\s+1 definition`));

  // within a range: the lock moves, nothing is re-hashed
  const before = hashOf("time.short");
  sql("UPDATE packages SET version = '2.1.1' WHERE name = 'ms' AND range = '2'");
  const within = tcm("upgrade", "ms");
  assert.match(within, new RegExp(`ms 2\\s+2\\.1\\.1 → ${locked.replaceAll(".", "\\.")}`));
  assert.match(within, /1 definition\(s\) re-checked; no hashes changed/);
  assert.equal(hashOf("time.short"), before);
  assert.match(tcm("upgrade", "ms"), /ms is up to date/);

  // to another range: re-pinned and re-hashed, and it runs on that version
  const across = tcm("upgrade", "ms@1", "time");
  assert.match(across, /re-pinning 1 definition\(s\) in time to ms 1/);
  assert.equal(tcm("deps", "time.short").trim(), "npm:ms@1#default");
  assert.notEqual(hashOf("time.short"), before);
  assert.match(tcm("verify"), /rendering and re-hashing is the identity/);
  write("scratch.ts", `import { short } from "#codebase/time";\n\nshort(90_000);\n`);
  assert.match(tcm("check"), /⧩ '2m'/);
});

test("packages: an app can't mix ranges of a package others build against; upgrading moves its peers", () => {
  // two namespaces on two majors of React, then one app rendering both
  write("old.tsx", `// tcm: namespace old\nexport function Old() {\n  return <i>old</i>;\n}\n`);
  tcm("add", "old.tsx");
  tcm("upgrade", "react@18", "old");
  write("next.tsx", `// tcm: namespace next\nexport function Next() {\n  return <b>next</b>;\n}\n`);
  tcm("add", "next.tsx");
  tcm("upgrade", "react@19", "next");
  assert.equal(tcm("deps", "old.Old").trim(), "npm:react@18/jsx-runtime#*");
  assert.equal(tcm("deps", "next.Next").trim(), "npm:react@19/jsx-runtime#*");
  // new code in a namespace joins the range its neighbours use
  write("old2.tsx", `// tcm: namespace old\nexport function Older() {\n  return <s>older</s>;\n}\n`);
  tcm("add", "old2.tsx");
  assert.equal(tcm("deps", "old.Older").trim(), "npm:react@18/jsx-runtime#*");
  write("app.tsx", `// tcm: namespace app\nimport { createRoot } from "react-dom/client";\nimport { Old } from "#codebase/old";\nimport { Next } from "#codebase/next";\n\nexport function main() {\n  createRoot(document.body).render(<><Old /><Next /></>);\n}\n`);
  tcm("add", "app.tsx");
  const mixed = fails("build", "app.main");
  assert.match(mixed, /react 18 \(old\.Old, old\.Older\)|react 18 \(old\.Old\)/);
  assert.match(mixed, /react 19 \([^)]*next\.Next[^)]*\)/);
  assert.match(mixed, /one page can only run one react, since other packages are built against it/);

  // re-pinning old to 19 fixes it, and react-dom (built against react) follows wherever react moves
  tcm("upgrade", "react@19", "old");
  assert.match(tcm("build", "app.main"), /built app\.main/);
  const moved = tcm("upgrade", "react@18", "app");
  assert.match(moved, /with react-dom 18/);
  assert.match(tcm("deps", "app.main"), /npm:react-dom@18\/client#createRoot/);
});
