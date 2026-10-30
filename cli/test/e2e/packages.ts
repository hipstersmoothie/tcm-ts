// npm packages end to end, with nothing installed in the project: tcm provides what scratch files import, pins
// definitions by compatible range, runs one locked version per range, upgrades within a range (no hashes change)
// and across ranges (re-pinned and re-hashed, peers moving along), and refuses an app that mixes ranges of a
// package others are built against. Uses the npm registry.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { okIn, plainEnv, tcmBin, tcmIn, tempDir } from "./harness.ts";

/** A new codebase with no scratch file, and ways to work in it. */
function setUp() {
  const dir = tempDir("packages");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const fails = (...args: string[]) => {
    const r = tcmIn(dir, ...args);
    assert.notEqual(r.status, 0, `tcm ${args.join(" ")} should fail`);
    return r.out;
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
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  return { dir, tcm, fails, write, sql, hashOf };
}

/** A codebase with time.short (on ms 1, re-pinned from ms 2) and a scratch file that watches it. */
function timeOnMs1() {
  const c = setUp();
  c.write("time.ts", `// tcm: namespace time\nimport ms from "ms";\nexport const short = (n: number): string => ms(n);\n\nshort(90_000);\n`);
  c.tcm("add", "time.ts");
  fs.rmSync(path.join(c.dir, "time.ts"));
  c.tcm("upgrade", "ms@1", "time");
  c.write("scratch.ts", `import { short } from "#codebase/time";\n\nshort(90_000);\n`);
  return c;
}

/** Packages: provided without installing, pinned by range, one version per range, upgrades and guards. */
export const testPackagesPinnedByRange = () => {
  const { dir, tcm, write, sql, hashOf } = setUp();
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
};

/** Packages: an app can't mix ranges of a package others build against; upgrading moves its peers. */
export const testPackagesOneRangePerApp = () => {
  const { dir, tcm, fails, write } = setUp();
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
  // with both majors in the cache, each React DOM runs on the React its peer range accepts
  const reactSeenBy = (alias: string) =>
    spawnSync(process.execPath, ["-e", 'console.log(require("react/package.json").version)'], { cwd: path.join(dir, ".tcm", "cache", "node_modules", alias), encoding: "utf8" }).stdout.trim();
  assert.match(reactSeenBy("npm__react-dom__18"), /^18\./);
  assert.match(reactSeenBy("npm__react-dom__19"), /^19\./);
};

/** Packages: a locked version is one tarball, and it travels with the code. */
export const testPackagesLockedTarballTravels = () => {
  const { dir, tcm, fails, sql } = timeOnMs1();
  // hold ms 1 back at an older version than the registry's newest, installed and recorded
  const there = tempDir("packages remote");
  spawnSync(process.execPath, [tcmBin(), "init"], { cwd: there, env: plainEnv() });
  sql("UPDATE packages SET version = '1.0.0', integrity = NULL WHERE name = 'ms' AND range = '1'");
  fs.rmSync(path.join(dir, ".tcm", "cache", "node_modules"), { recursive: true, force: true });
  assert.match(tcm("check", "--fresh"), /⧩ '2m'/);
  const mine = sql("SELECT version, integrity FROM packages WHERE name = 'ms' AND range = '1'")[0]!;
  assert.equal(mine.version, "1.0.0");
  assert.match(mine.integrity!, /^sha(512|1)-/, "the install recorded the tarball's hash");

  // pushed code brings the versions it runs on, not whatever is newest over there
  tcm("remote", "add", "there", there);
  tcm("push", "there");
  const theirs = (() => {
    const db = new DatabaseSync(path.join(there, ".tcm", "codebase.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT version, integrity FROM packages WHERE name = 'ms' AND range = '1'").get() as Record<string, string>;
    } finally {
      db.close();
    }
  })();
  assert.deepEqual({ ...theirs }, { ...mine });

  // different bytes under a locked version are refused
  sql("UPDATE packages SET integrity = 'sha512-not-what-the-registry-serves' WHERE name = 'ms' AND range = '1'");
  fs.rmSync(path.join(dir, ".tcm", "cache", "node_modules"), { recursive: true, force: true });
  assert.match(fails("check", "--fresh"), /ms@1\.0\.0: the installed tarball .* isn't the one this codebase locked/);
  sql("UPDATE packages SET integrity = ? WHERE name = 'ms' AND range = '1'", mine.integrity!);
};
