import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CHROME, pageText } from "./browser.ts";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const SETUP = fileURLToPath(new URL("../../../examples/polls/setup.sh", import.meta.url));
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ucm examples ")), "polls");
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", UCM_BIN: BIN };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

const hashOf = (name: string) => {
  const db = new DatabaseSync(path.join(dir, ".ucm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
};

test("the polls example builds, passes its tests, and runs in a browser", { skip: !CHROME && "no Chrome" }, async () => {
  const setup = spawnSync(SETUP, [dir], { env, encoding: "utf8" });
  const out = (setup.stdout + setup.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(setup.status, 0, out);
  assert.match(out, /4 passed, 0 failed/);
  assert.ok(fs.existsSync(path.join(dir, "scratch.ts")) && !fs.existsSync(path.join(dir, "server.ts")), "only the playground is left as a file");

  const child = spawn(process.execPath, [BIN, "start", "polls.main", "--port", "0"], { cwd: dir, env });
  children.push(child);
  let log = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (log += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (log += d));
  for (const end = Date.now() + 60000; !/url\s+http/.test(log) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  const url = /url\s+(http:\/\/\S+)/.exec(log)?.[1];
  assert.ok(url, log);

  const call = async (name: string, args: unknown[]) => {
    const r = await fetch(new URL(`/__ucm/rpc/${hashOf(name)}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const id = await call("polls.createPoll", ["Tabs or spaces?", ["tabs", "spaces"], 5]);
  await call("polls.vote", [id, 0]);

  // the page lists the poll and streams its tally from the server
  const text = await pageText(url!, "main", (t) => /tabs is ahead/.test(t));
  assert.match(text, /Tabs or spaces\?/);
  assert.match(text, /tabs\s+█+\s+100% \(1\)/);
});
