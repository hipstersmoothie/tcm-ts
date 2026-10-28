import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm data "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
function hashOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".ucm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await cond()) return;
  throw new Error("timed out waiting");
};

/** The crm app, with the User type and table options varying by step. */
const crm = (o: { field?: string; opts?: string; value?: string }) =>
  fs.writeFileSync(
    path.join(dir, "scratch.ts"),
    `// ucm: namespace crm
import assert from "node:assert/strict";
import { table, request } from "#ucm/server";

export type User = { name: string; email: string; joined: Date${o.field ?? ""} };
export const users = table<User>("users"${o.opts ?? ""});

export async function addUser(name: string, email: string): Promise<string> {
  request();
  return users.insert({ name, email, joined: new Date(0)${o.value ?? ""} });
}
export async function listUsers(): Promise<string[]> {
  request();
  return (await users.find()).map((r) => r.value.name);
}
export async function badInsert(): Promise<string> {
  request();
  return users.insert({ name: "x" } as unknown as User);
}
export async function main() {
  document.body.textContent = [await addUser("ada", "a@x"), await listUsers(), await badInsert()].join();
}

// tables work in tests too, in memory
export const testTablesInMemory = async () => {
  const id = await users.insert({ name: "t", email: "t@x", joined: new Date(5)${o.value ?? ""} });
  assert.equal((await users.get(id))?.joined.getTime(), 5, "dates come back as dates");
  assert.equal((await users.find({ name: "t" })).length, 1);
  await assert.rejects(users.put("bad", { name: 1 } as unknown as User), /table "users": value\\.name should be a string/);
};
`,
  );

/** POST a server function call, retried once on a keep-alive connection reset (see web.test.ts). */
const call = async (url: string, hash: string, args: unknown[]): Promise<{ status: number; body: string }> => {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) };
  let r: Response;
  try {
    r = await fetch(new URL(`/__ucm/rpc/${hash}`, url), init);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "ECONNRESET") throw e;
    r = await fetch(new URL(`/__ucm/rpc/${hash}`, url), init);
  }
  return { status: r.status, body: await r.text() };
};

test("typed tables: writes are checked; changed row types are verified, migrated, or refused; old pages reload", async () => {
  ucm("init");
  crm({});
  ucm("add");
  assert.match(ucm("test", "crm"), /1 passed, 0 failed/);
  assert.match(ucm("view", "crm.users"), /runs on the server: it uses #ucm\/server \(table\)/);

  const child = spawn(process.execPath, [BIN, "start", "crm.main", "--port", "0"], { cwd: dir, env });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  await waitFor(() => /url\s+http:\/\/\S+/.test(out));
  const url = /url\s+(http:\/\/\S+)/.exec(out)![1]!;

  await call(url, hashOf("crm.addUser"), ["ada", "ada@x"]);
  await call(url, hashOf("crm.addUser"), ["grace", "grace@x"]);
  const v1List = hashOf("crm.listUsers");
  assert.equal((await call(url, v1List, [])).body, `["ada","grace"]`);
  assert.equal((await call(url, hashOf("crm.badInsert"), [])).status, 500);
  await waitFor(() => /table "users": value\.email is missing/.test(out));
  assert.match(ucm("data"), /users\s+2 row\(s\)/);

  // a compatible change: the stored rows still fit, so they just work
  crm({ field: `; plan?: "free" | "pro"`, value: `, plan: "pro" as const` });
  assert.match(ucm("update"), /table "users": 2 stored row\(s\) were written as an earlier type and still fit the new one/);
  await waitFor(async () => (await call(url, hashOf("crm.listUsers"), [])).body === `["ada","grace"]`);

  // an incompatible change: ucm says so at update time, and reads refuse rather than return the wrong shape
  crm({ field: `; plan?: "free" | "pro"; active: boolean`, value: `, plan: "pro" as const, active: true` });
  const update = ucm("update");
  assert.match(update, /table "users": 2 stored row\(s\) don't fit the new type, e\.g\. \S+: row\.active is missing/);
  assert.match(update, /reading them will fail until table\(\) gets a migrate function/);
  await waitFor(async () => (await call(url, hashOf("crm.listUsers"), [])).status === 500);
  await waitFor(() => /written as an older type and doesn't fit the current one \(row\.active is missing\)/.test(out));

  // with a migration: rows are upgraded as they're read, and the result is checked too
  crm({ field: `; plan?: "free" | "pro"; active: boolean`, opts: `, { migrate: (old: Omit<User, "active">) => ({ ...old, active: true }) }`, value: `, plan: "pro" as const, active: true` });
  assert.match(ucm("update"), /they'll go through migrate\(\) when read/);
  await waitFor(async () => (await call(url, hashOf("crm.listUsers"), [])).body === `["ada","grace"]`);
  assert.doesNotMatch(ucm("data"), /written under \d+ row types/, "every row now has the current row type");

  // a page still on v1 reads rows written by newer code: 410, so it reloads instead of misreading them
  const stale = await call(url, v1List, []);
  assert.equal(stale.status, 410);
  assert.match(stale.body, /written by a newer version of this app; reload/);
});

test("a table without a row type explains how to declare one", () => {
  fs.writeFileSync(
    path.join(dir, "scratch.ts"),
    `// ucm: namespace loose
import assert from "node:assert/strict";
import { table } from "#ucm/server";
export const testUntyped = async () => {
  const t = table("anything");
  await assert.rejects(t.insert({}), /declare it at the top level with one, e\\.g\\. export const anything = table<Row>\\("anything"\\)/);
};
`,
  );
  ucm("add");
  assert.match(ucm("test", "loose"), /1 passed, 0 failed/);
});
