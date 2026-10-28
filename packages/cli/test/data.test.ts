import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm data "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

function tcm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
function hashOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
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
    `// tcm: namespace crm
import assert from "node:assert/strict";
import { table, request } from "#tcm/server";

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
    r = await fetch(new URL(`/__tcm/rpc/${hash}`, url), init);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "ECONNRESET") throw e;
    r = await fetch(new URL(`/__tcm/rpc/${hash}`, url), init);
  }
  return { status: r.status, body: await r.text() };
};

test("typed tables: writes are checked; changed row types are verified, migrated, or refused; old pages reload", async () => {
  tcm("init");
  crm({});
  tcm("add");
  assert.match(tcm("test", "crm"), /1 passed, 0 failed/);
  assert.match(tcm("view", "crm.users"), /runs on the server: it uses #tcm\/server \(table\)/);

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
  assert.match(tcm("data"), /users\s+2 row\(s\)/);

  // a compatible change: the stored rows still fit, so they just work
  crm({ field: `; plan?: "free" | "pro"`, value: `, plan: "pro" as const` });
  assert.match(tcm("update"), /table "users": 2 stored row\(s\) were written as an earlier type and still fit the new one/);
  await waitFor(async () => (await call(url, hashOf("crm.listUsers"), [])).body === `["ada","grace"]`);

  // an incompatible change: tcm says so at update time, and reads refuse rather than return the wrong shape
  crm({ field: `; plan?: "free" | "pro"; active: boolean`, value: `, plan: "pro" as const, active: true` });
  const update = tcm("update");
  assert.match(update, /table "users": 2 stored row\(s\) don't fit the new type, e\.g\. \S+: row\.active is missing/);
  assert.match(update, /reading them will fail until table\(\) gets a migrate function/);
  await waitFor(async () => (await call(url, hashOf("crm.listUsers"), [])).status === 500);
  await waitFor(() => /written as an older type and doesn't fit the current one \(row\.active is missing\)/.test(out));

  // with a migration: rows are upgraded as they're read, and the result is checked too
  crm({ field: `; plan?: "free" | "pro"; active: boolean`, opts: `, { migrate: (old: Omit<User, "active">) => ({ ...old, active: true }) }`, value: `, plan: "pro" as const, active: true` });
  assert.match(tcm("update"), /migrate takes them as they.re read \(or all now: tcm data migrate users\)/);
  await waitFor(async () => (await call(url, hashOf("crm.listUsers"), [])).body === `["ada","grace"]`);
  assert.doesNotMatch(tcm("data"), /written under \d+ row types/, "every row now has the current row type");

  // a page still on v1 reads rows written by newer code: 410, so it reloads instead of misreading them
  const stale = await call(url, v1List, []);
  assert.equal(stale.status, 410);
  assert.match(stale.body, /written by a newer version of this app; reload/);
});

test("a table without a row type explains how to declare one", () => {
  fs.writeFileSync(
    path.join(dir, "scratch.ts"),
    `// tcm: namespace loose
import assert from "node:assert/strict";
import { table } from "#tcm/server";
export const testUntyped = async () => {
  const t = table("anything");
  await assert.rejects(t.insert({}), /declare it at the top level with one, e\\.g\\. export const anything = table<Row>\\("anything"\\)/);
};
`,
  );
  tcm("add");
  assert.match(tcm("test", "loose"), /1 passed, 0 failed/);
});

test("migration chains, eager migration, renames, unique and indexed fields, atomic updates", () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tcm data2 "));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir2, encoding: "utf8", env });
    return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
  };
  const ok = (...args: string[]) => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
    return r.out;
  };
  ok("init");
  // rows an earlier app wrote under the table's old name, as two earlier row types (and one no step takes)
  fs.mkdirSync(path.join(dir2, ".tcm", "data"), { recursive: true });
  const store = new DatabaseSync(path.join(dir2, ".tcm", "data", "store.sqlite"));
  store.exec(`CREATE TABLE rows (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, schema_hash TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id));
    CREATE TABLE schemas (tbl TEXT NOT NULL, hash TEXT NOT NULL, schema TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY (tbl, hash));`);
  const seed = store.prepare("INSERT INTO rows VALUES ('memos', ?, ?, ?, ?)");
  seed.run("r1", JSON.stringify({ body: "first" }), "v1", 1);
  seed.run("r2", JSON.stringify({ text: "second", tags: ["x"] }), "v2", 2);
  seed.run("r3", JSON.stringify({ title: 3 }), "v1", 3);
  store.close();

  fs.writeFileSync(
    path.join(dir2, "scratch.ts"),
    `// tcm: namespace notes
import assert from "node:assert/strict";
import { table } from "#tcm/server";

export type Note = { text: string; tags: string[]; pinned: boolean; at: number };
export function fromV1(old: { body: string }) {
  return { text: old.body, tags: [] as string[] };
}
export function fromV2(old: { text: string; tags: string[] }): Note {
  return { ...old, pinned: false, at: 0 };
}
export const notes = table<Note>("notes", { migrate: [fromV1, fromV2], unique: ["text"], index: ["pinned"], renamedFrom: "memos" });

// (tests share one in-memory store: this one's rows are tagged "f", and only it stores pinned rows)
export const testFindOptions = async () => {
  for (const [text, at] of [["c", 3], ["a", 1], ["b", 2]] as const) await notes.insert({ text, tags: ["f"], pinned: at > 1, at });
  // a non-scalar condition is compared in JS; a scalar one is a SQL query (with the index)
  assert.deepEqual((await notes.find({ tags: ["f"] }, { orderBy: "at" })).map((r) => r.value.text), ["a", "b", "c"]);
  assert.deepEqual((await notes.find({ pinned: true }, { orderBy: "at", desc: true, limit: 1 })).map((r) => r.value.text), ["c"]);
  assert.deepEqual((await notes.find({ tags: ["f"] }, { orderBy: "text", offset: 1 })).map((r) => r.value.text), ["b", "c"]);
  assert.equal((await notes.findOne({ text: "b" }))?.value.at, 2);
  assert.equal(await notes.findOne({ text: "zzz" }), undefined);
  assert.equal(await notes.count({ pinned: true }), 2);
};
export const testUnique = async () => {
  const id = await notes.insert({ text: "only once", tags: [], pinned: false, at: 0 });
  await assert.rejects(notes.insert({ text: "only once", tags: [], pinned: true, at: 1 }), (e: Error & { status?: number }) => e.status === 409 && /another row \\(\\S+\\) already has text = "only once"/.test(e.message));
  await notes.put(id, { text: "only once", tags: ["kept"], pinned: false, at: 0 }); // replacing itself is fine
  assert.deepEqual((await notes.get(id))?.tags, ["kept"]);
};
export const testAtomicUpdate = async () => {
  const id = await notes.insert({ text: "counter", tags: [], pinned: false, at: 0 });
  await Promise.all([1, 2, 3].map(() => notes.update(id, (n) => ({ ...n, at: n.at + 1 }))));
  assert.equal((await notes.get(id))?.at, 3);
  assert.equal(await notes.update("missing", (n) => n), undefined);
  await assert.rejects(notes.update(id, (async (n: Note) => n) as unknown as (n: Note) => Note), /must return the new value, not a promise/);
};
`,
  );
  const added = ok("add");
  assert.match(added, /table "notes": renamed from "memos"; its 3 row\(s\) move over when the table is first used/);
  assert.match(added, /table "notes": 1 stored row\(s\) fit neither the new type nor any migrate step's parameter type, e\.g\. r3/);
  assert.match(ok("test", "notes"), /3 passed, 0 failed/);

  // eagerly: r1 goes through both steps, r2 through the second; r3 fits no step and says why
  const first = run("data", "migrate", "notes");
  assert.equal(first.status, 1);
  assert.match(first.out, /table "notes": 3 row\(s\): 0 already current, 2 migrated, 0 still fit as stored/);
  assert.match(first.out, /r3: .*no migrate step takes \(step 1 \(fromV1\): row\.body is missing; step 2 \(fromV2\): row\.text is missing\)/);

  const db = new DatabaseSync(path.join(dir2, ".tcm", "data", "store.sqlite"));
  db.prepare("DELETE FROM rows WHERE id = 'r3'").run();
  const rows = db.prepare("SELECT tbl, id, data FROM rows ORDER BY id").all() as { tbl: string; id: string; data: string }[];
  assert.deepEqual(rows.map((r) => [r.tbl, r.id, JSON.parse(r.data)]), [
    ["notes", "r1", { text: "first", tags: [], pinned: false, at: 0 }],
    ["notes", "r2", { text: "second", tags: ["x"], pinned: false, at: 0 }],
  ]);
  // the declared fields are indexed, and find's queries use them
  // index names are stored in the data file, so they keep the prefix from before ucm-ts became tcm
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ucm_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(indexes, ["ucm_index_notes__pinned", `ucm_unique_notes__text`]);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM rows WHERE tbl = 'notes' AND schema_hash = ? AND json_extract(data, '$."pinned"') = ?`).all("h", 1) as { detail: string }[];
  assert.match(plan.map((p) => p.detail).join("\n"), /USING INDEX ucm_index_notes__pinned/);
  db.close();

  const second = ok("data", "migrate", "notes");
  assert.match(second, /2 row\(s\): 2 already current/);
  assert.match(second, /every row now has the current row type, so migrate has nothing left to do: you can remove it from table\("notes"\)/);
  assert.match(ok("data"), /notes\s+2 row\(s\)$/m);
});

test("transactions: all or nothing, isolated from other requests, savepoints, jobs on commit", () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "tcm data3 "));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir3, encoding: "utf8", env });
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
    return out;
  };
  run("init");
  fs.writeFileSync(
    path.join(dir3, "scratch.ts"),
    `// tcm: namespace bank
import assert from "node:assert/strict";
import { table, transaction, enqueue, runJobs } from "#tcm/server";

export type Account = { owner: string; balance: number };
export const accounts = table<Account>("accounts");
const tick = () => new Promise((r) => setTimeout(r, 20));

export async function transfer(from: string, to: string, amount: number): Promise<void> {
  await transaction(async () => {
    const a = (await accounts.get(from))!;
    const b = (await accounts.get(to))!;
    await accounts.put(from, { ...a, balance: a.balance - amount });
    await tick(); // halfway: nobody else may see this
    if (a.balance < amount) throw new Error("insufficient funds");
    await accounts.put(to, { ...b, balance: b.balance + amount });
  });
}
const balances = async (...ids: string[]) => Promise.all(ids.map(async (id) => (await accounts.get(id))?.balance));
const open = async (id: string, balance: number) => accounts.put(id, { owner: id, balance });

export const testCommitAndRollback = async () => {
  await open("a", 100);
  await open("b", 0);
  await transfer("a", "b", 30);
  assert.deepEqual(await balances("a", "b"), [70, 30]);
  await assert.rejects(transfer("a", "b", 500), /insufficient funds/);
  assert.deepEqual(await balances("a", "b"), [70, 30], "the debit was rolled back");
};

export const testIsolation = async () => {
  await open("c", 50);
  await open("d", 50);
  // started while the transfer is halfway: waits, then sees all of it
  const moving = transfer("c", "d", 10);
  await new Promise((r) => setTimeout(r, 5));
  const seen = await accounts.find();
  await moving;
  const sum = seen.filter((r) => r.id === "c" || r.id === "d").reduce((n, r) => n + r.value.balance, 0);
  assert.equal(sum, 100, "never a debit without its credit");
  assert.deepEqual(await balances("c", "d"), [40, 60]);
};

export const testSavepoints = async () => {
  await open("e", 1);
  await transaction(async () => {
    await accounts.update("e", (x) => ({ ...x, balance: 2 }));
    await assert.rejects(
      transaction(async () => {
        await accounts.put("e", { owner: "e", balance: 99 });
        throw new Error("inner fails");
      }),
      /inner fails/,
    );
    assert.equal((await accounts.get("e"))?.balance, 2, "only the inner writes were undone");
  });
  assert.equal((await accounts.get("e"))?.balance, 2);
};

const sent: string[] = [];
export async function notify(who: string): Promise<void> {
  sent.push(who);
}
export const testJobsOnCommit = async () => {
  await assert.rejects(transaction(async () => {
    enqueue(notify, "rolled back");
    throw new Error("no");
  }));
  await transaction(async () => {
    enqueue(notify, "committed");
  });
  await runJobs({ all: true });
  assert.deepEqual(sent, ["committed"]);
};
`,
  );
  run("add");
  assert.match(run("test", "bank"), /4 passed, 0 failed/);
  assert.match(run("view", "bank.transfer"), /runs on the server: it uses #tcm\/server/);
});
