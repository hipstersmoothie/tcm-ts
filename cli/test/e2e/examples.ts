// The examples in examples/: each is built by its setup script, passes its tests, and runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CHROME, hydrated, pageText, withPage } from "../browser.ts";
import { plainEnv, tcmBin, tempDir, withChildren } from "./harness.ts";
import { POLLS } from "../../../fixtures.ts";
import { NOTES } from "../../../fixtures.ts";
import { GEOMETRY } from "../../../fixtures.ts";

type Keep = <C extends ChildProcess>(c: C) => C;

const env = (): NodeJS.ProcessEnv => ({ ...plainEnv(), TCM_BIN: tcmBin() });

const hashOf = (name: string, root: string) => {
  const db = new DatabaseSync(path.join(root, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
};

/** Start `tcm start <app>` in `cwd` on a free port; resolves with its URL. */
async function startApp(keep: Keep, cwd: string, app: string): Promise<string> {
  const child = keep(spawn(process.execPath, [tcmBin(), "start", app, "--port", "0"], { cwd, env: env() }));
  let log = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (log += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (log += d));
  for (const end = Date.now() + 60000; !/url\s+http/.test(log) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  const url = /url\s+(http:\/\/\S+)/.exec(log)?.[1];
  assert.ok(url, log);
  return url!;
}

/** the polls example builds, passes its tests, and runs in a browser */
export const testPollsExample = async () => {
  if (!CHROME) return console.log("skipped: no Chrome");
  const dir = path.join(tempDir("examples"), "polls");
  const setup = spawnSync(path.join(exampleDir(POLLS), "setup.sh"), [dir], { env: env(), encoding: "utf8" });
  const out = (setup.stdout + setup.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(setup.status, 0, out);
  assert.match(out, /4 passed, 0 failed/);
  assert.ok(fs.existsSync(path.join(dir, "scratch.ts")) && !fs.existsSync(path.join(dir, "server.ts")), "only the playground is left as a file");

  await withChildren(async (keep) => {
    const child = keep(spawn(process.execPath, [tcmBin(), "start", "polls.main", "--port", "0"], { cwd: dir, env: env() }));
    let log = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (log += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (log += d));
    for (const end = Date.now() + 60000; !/url\s+http/.test(log) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
    const url = /url\s+(http:\/\/\S+)/.exec(log)?.[1];
    assert.ok(url, log);

    const call = async (name: string, args: unknown[]) => {
      const r = await fetch(new URL(`/__tcm/rpc/${hashOf(name, dir)}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
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
}

/** the notes example: React server components with no directives, in a browser */
export const testNotesExample = async () => {
  if (!CHROME) return console.log("skipped: no Chrome");
  const notesDir = path.join(tempDir("examples"), "notes");
  const setup = spawnSync(path.join(exampleDir(NOTES), "setup.sh"), [notesDir], { env: env(), encoding: "utf8" });
  const out = (setup.stdout + setup.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(setup.status, 0, out);
  assert.match(out, /8 passed, 0 failed/);
  assert.doesNotMatch(out, /warning/, "the example's docs link only to what exists");
  const tcm = (...args: string[]) => spawnSync(process.execPath, [tcmBin(), ...args], { cwd: notesDir, env: env(), encoding: "utf8" }).stdout;
  assert.match(tcm("view", "notes.NoteList"), /renders on the server: it is an async component; the browser fetches its rendered tree by hash/);
  assert.match(tcm("view", "notes.NoteEditor"), /renders in the browser: it uses useState/);
  assert.match(tcm("view", "notes.Markdown"), /renders anywhere/);

  await withChildren(async (keep) => {
    const url = await startApp(keep, notesDir, "notes.App");
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
  });
  // what the browser received: no server code
  const assets = path.join(notesDir, ".tcm", "apps", hashOf("notes.App", notesDir), "assets");
  const shipped = fs.readdirSync(assets).map((f) => fs.readFileSync(path.join(assets, f), "utf8")).join("\n");
  for (const secret of ["orderBy", "store.sqlite", "that note was deleted"]) assert.ok(!shipped.includes(secret), `${secret} must not reach the browser`);
}

/** the geometry example: two packages, their releases, a contribution, and what's next */
export const testGeometryExample = () => {
  const root = path.join(tempDir("examples"), "geometry");
  const built = spawnSync(path.join(exampleDir(GEOMETRY), "setup.sh"), [root], { env: env(), encoding: "utf8" });
  const out = (built.stdout + built.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(built.status, 0, out);
  const tcm = (...args: string[]) => {
    const r = spawnSync(process.execPath, [tcmBin(), ...args], { cwd: root, env: env(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  };
  // versions the changes called for: additions (1.1), a new case of a union (2.0)
  assert.match(tcm("releases"), /^atlas {2}atlas\n {2}1\.1\.0 .* Round trips\.\n {2}1\.0\.0 [\s\S]*^geo {2}geo\n {2}2\.0\.0 [\s\S]* {2}1\.1\.0 [\s\S]* {2}1\.0\.0 /m);
  const log = tcm("changelog", "geo");
  assert.match(log, /## 2\.0\.0 .*\n\nHexagons![\s\S]*### Breaking changes\n\n- `geo\.Shape` has a new case: `"hexagon"`\n\n### Contributions\n\n- #1 Hexagons \(ada\)/);
  assert.match(log, /## 1\.1\.0[\s\S]*### Added\n\n- `geo\.perimeter`[\s\S]*### Extended\n\n- `geo\.distance` takes a new optional parameter: `digits`/);
  // what's next, and its draft
  assert.match(tcm("release", "check", "geo"), /geo's next release: 2\.1\.0 \(after 2\.0\.0\): additions/);
  assert.match(fs.readFileSync(path.join(root, "release-geo.md"), "utf8"), /^## 2\.1\.0 [\s\S]*- `geo\.midpoint`/);
  // atlas 1.1 uses geo 1.1's definitions: it depends on the oldest geo with them
  tcm("pack", "atlas@1.1.0");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".tcm", "pack", "atlas", "package.json"), "utf8")).dependencies, { geo: "^1.1.0" });
  assert.match(tcm("contribution", "--all"), /#1 +merged +Hexagons/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, ".vscode", "settings.json"), "utf8"))["tcm.path"], "the editor runs the same tcm");
  assert.match(tcm("check"), /⧩ 10/);
}

/**
 * An example's files, as the codebase keeps them, written to a directory of their own: its setup script runs from
 * there. By path in the example.
 */
export function exampleDir(files: Record<string, string>): string {
  const dir = tempDir("example");
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
  return dir;
}
