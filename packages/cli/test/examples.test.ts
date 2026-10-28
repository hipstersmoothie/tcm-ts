import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CHROME, hydrated, pageText, withPage } from "./browser.ts";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const SETUP = fileURLToPath(new URL("../../../examples/polls/setup.sh", import.meta.url));
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tcm examples ")), "polls");
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TCM_BIN: BIN };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

const hashOf = (name: string, root = dir) => {
  const db = new DatabaseSync(path.join(root, ".tcm", "codebase.sqlite"), { readOnly: true });
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
    const r = await fetch(new URL(`/__tcm/rpc/${hashOf(name)}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
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

/** Start `tcm start <app>` in `cwd` on a free port; resolves with its URL. */
async function startApp(cwd: string, app: string): Promise<string> {
  const child = spawn(process.execPath, [BIN, "start", app, "--port", "0"], { cwd, env });
  children.push(child);
  let log = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (log += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (log += d));
  for (const end = Date.now() + 60000; !/url\s+http/.test(log) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  const url = /url\s+(http:\/\/\S+)/.exec(log)?.[1];
  assert.ok(url, log);
  return url!;
}

test("the notes example: React server components with no directives, in a browser", { skip: !CHROME && "no Chrome" }, async () => {
  const notesDir = path.join(path.dirname(dir), "notes");
  const setup = spawnSync(fileURLToPath(new URL("../../../examples/notes/setup.sh", import.meta.url)), [notesDir], { env, encoding: "utf8" });
  const out = (setup.stdout + setup.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(setup.status, 0, out);
  assert.match(out, /8 passed, 0 failed/);
  assert.doesNotMatch(out, /warning/, "the example's docs link only to what exists");
  const tcm = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: notesDir, env, encoding: "utf8" }).stdout;
  assert.match(tcm("view", "notes.NoteList"), /renders on the server: it is an async component; the browser fetches its rendered tree by hash/);
  assert.match(tcm("view", "notes.NoteEditor"), /renders in the browser: it uses useState/);
  assert.match(tcm("view", "notes.Markdown"), /renders anywhere/);

  const url = await startApp(notesDir, "notes.App");
  const text = (sel: string) => `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`;
  const click = (sel: string, label: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`;
  const type = (sel: string, v: string) =>
    `(() => { const i = document.querySelector(${JSON.stringify(sel)}); const proto = i instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; ` +
    `Object.getOwnPropertyDescriptor(proto, "value").set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`;
  // the first paint is rendered on the server: the sidebar's server component included
  const html = await (await fetch(url, { headers: { accept: "text/html" } })).text();
  assert.match(html, /<div id="app"><div class="notes">.*No notes yet/s);
  assert.match(html, /var __TCM_TREES__ = /, "with the trees it was made from, for hydration");
  await withPage(url, async (p) => {
    // the sidebar is a server component; the button in it is a browser component it sent by hash
    assert.match(await p.waitFor<string>(text("aside"), (t) => /add sample notes/.test(t ?? "")), /No notes yet/);
    assert.ok(await hydrated(p), "the browser takes over the server-rendered page");
    await p.evaluate(click("aside button", "add sample notes"));
    // the server function call makes the server components fetch their trees again
    assert.match(await p.waitFor<string>(text("aside"), (t) => /Groceries/.test(t ?? "")), /How this app works/);
    await p.evaluate(click(".entry strong", "Groceries"));
    assert.match(await p.waitFor<string>(text("main"), (t) => /last changed/.test(t ?? "")), /eggs \(a dozen\)/);
    await p.evaluate(click("main button", "edit"));
    await p.waitFor<string>(text("main"), (t) => /save/.test(t ?? ""));
    await p.evaluate(type("textarea", "- **bread**\n- milk"));
    // the editor's preview is the same Markdown component, rendered in the browser as you type
    assert.match(await p.waitFor<string>(`document.querySelector(".preview")?.innerHTML ?? ""`, (t) => /<strong>bread/.test(t ?? "")), /<li><strong>bread<\/strong><\/li>/);
    await p.evaluate(click("main button", "save"));
    assert.match(await p.waitFor<string>(text("aside"), (t) => /bread milk/.test(t ?? "")), /Groceries/);
    await p.evaluate(type(".search", "bread"));
    assert.doesNotMatch(await p.waitFor<string>(text(".list"), (t) => !/Markdown/.test(t ?? "")), /Markdown/);
    assert.deepEqual(p.errors, [], "no errors, hydration mismatches included");
  });
  // what the browser received: no server code
  const assets = path.join(notesDir, ".tcm", "apps", hashOf("notes.App", notesDir), "assets");
  const shipped = fs.readdirSync(assets).map((f) => fs.readFileSync(path.join(assets, f), "utf8")).join("\n");
  for (const secret of ["orderBy", "store.sqlite", "that note was deleted"]) assert.ok(!shipped.includes(secret), `${secret} must not reach the browser`);
});
