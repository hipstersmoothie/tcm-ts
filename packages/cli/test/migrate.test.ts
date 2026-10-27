import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm migrate "));

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);

test("migrate rebuilds an older-format codebase, keeping names, history, branches and identity", () => {
  ucm("init");
  ucm("add");
  scratch(`// ucm: namespace state
import { square } from "#codebase";
export const cacheA = new Map<string, number>();
export const cacheB = new Map<string, number>();
export const probe = () => [cacheA === cacheB, square(3)].join(" ");
`);
  ucm("add");
  ucm("mv", "state.cacheB", "state.other");
  scratch(`export const square = (x: number): number => x * x + 0;\n`);
  ucm("update");
  ucm("branch", "feature");
  const names = ucm("ls");
  const history = ucm("history", "50");
  const texts = () => {
    const db = new DatabaseSync(path.join(dir, ".ucm", "codebase.sqlite"));
    const rows = db.prepare("SELECT name_hint || ' | ' || source_text AS t FROM definitions ORDER BY t").all() as { t: string }[];
    db.close();
    return rows.map((r) => r.t);
  };
  const before = texts();

  // simulate a codebase from before lineage salts: strip them from the stored IR and mark it v3
  const db = new DatabaseSync(path.join(dir, ".ucm", "codebase.sqlite"));
  db.exec(`UPDATE components SET ir_version = 3;
           UPDATE definitions SET ir = json_remove(ir, '$[2]') WHERE json_extract(ir, '$[2][0]') = 'Salt';`);
  assert.ok((db.prepare("SELECT count(*) AS n FROM definitions WHERE ir LIKE '%\"Salt\"%'").get() as { n: number }).n === 0);
  db.close();

  assert.throws(() => ucm("ls"), /hash format v3; this ucm uses v\d+\. Run `ucm migrate`/);
  const out = ucm("migrate");
  assert.match(out, /migrating hash format v3 → v\d+/);
  assert.match(out, /verified \d+ live definitions/);
  assert.ok(fs.existsSync(path.join(dir, ".ucm-v3-backup", "codebase.sqlite")), "the old codebase is kept");

  // salts are re-derived from where each definition was first added, so the same hashes come back
  assert.equal(ucm("ls"), names);
  assert.equal(ucm("history", "50"), history);
  assert.deepEqual(texts(), before, "definitions keep the names and source text they were written with");
  assert.match(ucm("branch"), /feature/);
  assert.equal(ucm("run", "state.probe").trim(), "false 9", "two maps are still two maps");
});
