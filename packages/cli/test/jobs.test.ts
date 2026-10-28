import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm jobs "));
const outbox = path.join(dir, "outbox.log");
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

function tcm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
function hashOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}
const lines = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8").trim().split("\n") : []);
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await cond()) return;
  throw new Error(`timed out; outbox:\n${lines().join("\n")}`);
};
/** POST a server function call, retried once on a keep-alive connection reset (see web.test.ts). */
const call = async (url: string, name: string, args: unknown[]): Promise<{ status: number; body: string }> => {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) };
  let res: Response;
  try {
    res = await fetch(new URL(`/__tcm/rpc/${hashOf(name)}`, url), init);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "ECONNRESET") throw e;
    res = await fetch(new URL(`/__tcm/rpc/${hashOf(name)}`, url), init);
  }
  return { status: res.status, body: await res.text() };
};

const SHOP = (version: string) => `// tcm: namespace shop
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { enqueue, enqueueAfter, every, request, runJobs } from "#tcm/server";

const OUTBOX = ${JSON.stringify(outbox)};
const tries = new Map<string, number>();

export async function sendWelcome(user: string): Promise<void> {
  appendFileSync(OUTBOX, "welcome " + user + " (${version})\\n");
}
export async function flaky(id: string): Promise<void> {
  const n = (tries.get(id) ?? 0) + 1;
  tries.set(id, n);
  if (n < 2) throw new Error("transient failure " + n);
  appendFileSync(OUTBOX, "flaky " + id + " ok after " + n + "\\n");
}
export async function signup(user: string): Promise<string> {
  request();
  return enqueue(sendWelcome, user);
}
export async function signupLater(user: string): Promise<string> {
  request();
  return enqueueAfter(3, sendWelcome, user);
}
export async function startFlaky(): Promise<string> {
  request();
  return enqueue(flaky, "x");
}
export async function enqueueInline(): Promise<string> {
  request();
  return enqueue(async () => {});
}
export const heartbeat = every("1s", async () => appendFileSync(OUTBOX, "tick\\n"));

export async function main() {
  const b = document.createElement("button");
  b.onclick = async () => console.log(await signup("ada"), await signupLater("grace"), await startFlaky(), await enqueueInline());
  document.body.append(b);
}

// jobs are testable inline, no server: runJobs() drains the queue
const ran: string[] = [];
export async function record(x: string): Promise<void> { ran.push(x); }
export const testJobsRunInline = async () => {
  enqueue(record, "a");
  enqueue(record, "b");
  assert.deepEqual(await runJobs(), { done: 2, failed: 0 });
  assert.deepEqual(ran, ["a", "b"]);
};
`;

test("background jobs: durable, retried, pinned to the code that enqueued them; schedules run once per slot", async () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  scratch(SHOP("v1"));
  tcm("add");
  assert.match(tcm("test", "shop"), /1 passed, 0 failed/, "runJobs() drains the queue inside tcm test");

  const child = spawn(process.execPath, [BIN, "start", "shop.main", "--port", "0"], { cwd: dir, env });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  await waitFor(() => /url\s+http:\/\/\S+/.test(out));
  const url = /url\s+(http:\/\/\S+)/.exec(out)![1]!;
  // printed once the worker is up, a moment after the url: wait for it rather than racing it
  await waitFor(() => /jobs\s+recurring: shop\.heartbeat \(1s\)/.test(out));

  // a server function returns at once; the work happens in the background
  assert.match((await call(url, "shop.signup", ["ada"])).body, /^"[\w-]{16}"$/);
  await waitFor(() => lines().includes("welcome ada (v1)"));

  // failures are retried with backoff
  await call(url, "shop.startFlaky", []);
  await waitFor(() => lines().includes("flaky x ok after 2"));

  // a job runs the code version that enqueued it, even if a deploy happens before it runs
  await call(url, "shop.signupLater", ["grace"]);
  scratch(SHOP("v2"));
  tcm("update");
  await waitFor(() => lines().includes("welcome grace (v1)"));
  // the new signup is callable once the server has rebuilt for the update
  await waitFor(async () => (await call(url, "shop.signup", ["linus"])).status === 200);
  await waitFor(() => lines().includes("welcome linus (v2)"));

  // jobs name their function by hash, so an inline function can't be enqueued
  const inline = await call(url, "shop.enqueueInline", []);
  assert.equal(inline.status, 500);
  assert.match(out, /enqueue\(\) needs a codebase function/);

  // recurring: one run per slot
  await waitFor(() => lines().filter((l) => l === "tick").length >= 2);
  const db = new DatabaseSync(path.join(dir, ".tcm", "data", "jobs.sqlite"), { readOnly: true });
  const dupes = db.prepare("SELECT count(*) AS n FROM (SELECT slot FROM jobs WHERE slot IS NOT NULL GROUP BY slot HAVING count(*) > 1)").get() as { n: number };
  db.close();
  assert.equal(dupes.n, 0);

  // tcm jobs: the queue, and acting on it
  const listing = tcm("jobs", "50");
  assert.match(listing, /done\s+flaky\s+2\/5/);
  assert.match(listing, /done\s+shop\.heartbeat/);
  const id = /^(\S{8})\s+done\s+sendWelcome/m.exec(listing)![1]!;
  assert.match(tcm("jobs", "retry", id), /queued again/);
  await waitFor(() => lines().filter((l) => l.startsWith("welcome")).length >= 4, 15000);
});
