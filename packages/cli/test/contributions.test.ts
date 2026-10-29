import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROME, withPage } from "./browser.ts";

// Contributions, as on Unison Share: a branch proposed for merging, reviewed as a diff of definitions,
// commented on, and merged on the remote by history; with a review page on `tcm serve`.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm contributions ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TCM_AUTHOR: "ada" };
const servers: ChildProcess[] = [];
after(() => servers.forEach((s) => s.kill()));

function codebase(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
    return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
  };
  const tcm = (...args: string[]) => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} (in ${name}) exited ${r.status}:\n${r.out}`);
    return r.out;
  };
  const write = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
  tcm("init");
  return { dir, run, tcm, write };
}

const LIB = `// tcm: namespace lib\nexport const square = (x: number): number => x * x;\nexport const sumSquares = (xs: number[]): number => xs.map(square).reduce((a, b) => a + b, 0);\n`;

test("contribute, review, comment and merge; conflicts are refused until the branch takes the target in", () => {
  const server = codebase("server");
  server.write(LIB);
  server.tcm("add");
  const me = codebase("me");
  me.tcm("remote", "add", "origin", server.dir);
  me.tcm("pull");

  // contributing needs a branch
  assert.match(me.run("contribute").out, /this is main: make a branch for the change/);
  me.tcm("branch", "faster");
  me.tcm("switch", "faster");
  me.write(`// tcm: namespace lib\nexport const square = (x: number): number => x ** 2;\nexport const cube = (x: number): number => x ** 3;\n`);
  me.tcm("update");
  assert.match(me.tcm("contribute", "--title", "Faster squares", "--description", "Uses ** now."), /opened contribution #1 on origin\n {2}review: tcm contribution view 1/);
  assert.match(me.tcm("contribution"), /#1 +open +Faster squares +faster → main · ada/);

  // reviewed as definitions: the edit, what followed it, what's new
  const view = me.tcm("contribution", "view", "1");
  assert.match(view, /#1 Faster squares {2}open\n {2}faster → main · opened by ada/);
  assert.match(view, /Uses \*\* now\./);
  assert.match(view, /✓ merges as a fast-forward/);
  assert.match(view, /edited\n {4}~ lib\.square[\s\S]*- export const square = \(x: number\): number => x \* x\n {6}\+ export const square = \(x: number\): number => x \*\* 2/);
  assert.match(view, /updated because a dependency changed \(code unchanged\)\n {4}~ lib\.sumSquares/);
  assert.match(view, /added\n {4}\+ lib\.cube/);

  me.tcm("contribution", "comment", "1", "Nice.", "Cube too?", "--about", "lib.cube");
  assert.match(me.tcm("contribution", "view", "1"), /Comments\n {2}ada \S+ \S+ on lib\.cube\n {4}Nice\. Cube too\?/);

  // pushing again updates the same contribution
  me.write(`// tcm: namespace lib\nexport const cube = (x: number): number => x * x * x;\n`);
  me.tcm("update");
  assert.match(me.tcm("contribute"), /updated contribution #1/);

  // merged on the remote, by history: pulling it back is a fast-forward
  assert.match(me.tcm("contribution", "merge", "1"), /merged #1 on origin as #\w{8}/);
  assert.equal(server.tcm("run", "lib.cube", "3").trim(), "27");
  me.tcm("switch", "main");
  assert.match(me.tcm("pull"), /fast-forwarded main to origin\/main/);
  assert.match(me.tcm("contribution", "--all"), /#1 +merged +Faster squares/);
  assert.match(me.tcm("contribution", "view", "1"), /merged into main as #\w{8}[\s\S]*\+ lib\.cube/);
  assert.match(me.run("contribution", "merge", "1").out, /#1 is merged/);

  // two contributions change the same definition: the second conflicts once the first is in
  me.tcm("branch", "a");
  me.tcm("branch", "b");
  me.tcm("switch", "a");
  me.write(`// tcm: namespace lib\nexport const square = (x: number): number => Math.pow(x, 2);\n`);
  me.tcm("update");
  me.tcm("contribute", "--title", "pow");
  me.tcm("switch", "b");
  me.write(`// tcm: namespace lib\nexport const square = (x: number): number => x * x * 1;\n`);
  me.tcm("update");
  me.tcm("contribute", "--title", "times one");
  me.tcm("contribution", "merge", "2");
  assert.match(me.tcm("contribution", "view", "3"), /✗ conflicts with main in lib\.square/);
  const refused = me.run("contribution", "merge", "3");
  assert.equal(refused.status, 1);
  assert.match(refused.out, /#3 conflicts with main in lib\.square: merge main into b \(`tcm pull <remote> main` on that branch\)/);

  // the contributor brings main in, settles the conflict, pushes; now it merges
  me.run("pull", "origin", "main");
  const [first] = [...me.tcm("ls", "lib.square").matchAll(/#([a-z2-7]{8})/g)].map((m) => m[1]);
  me.tcm("resolve", "lib.square", `#${first}`);
  assert.match(me.tcm("contribute", "--title", "times one"), /updated contribution #3/);
  assert.match(me.tcm("contribution", "view", "3"), /✓ merges as a fast-forward/);
  me.tcm("contribution", "close", "3");
  assert.match(me.tcm("contribution", "--all"), /#3 +closed/);
  me.tcm("contribution", "reopen", "3");
  assert.match(me.tcm("contribution", "merge", "3"), /merged #3/);
});

/** Start `tcm serve` on a free port; resolves to its base URL. */
function startServer(dir: string, token: string): Promise<string> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0", "--token", token], { cwd: dir, env });
  servers.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const m = /url\s+(https?:\/\/[\d.]+:\d+)/.exec(out);
      if (m) resolve(m[1]!);
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

test("the review page on tcm serve", { skip: !CHROME && "no Chrome" }, async () => {
  const server = codebase("served");
  server.write(LIB);
  server.tcm("add");
  const url = await startServer(server.dir, "tok");
  const me = codebase("reviewer");
  me.tcm("remote", "add", "origin", url, "--token", "tok");
  me.tcm("pull");
  me.tcm("branch", "cubes");
  me.tcm("switch", "cubes");
  me.write(`// tcm: namespace lib\nexport const cube = (x: number): number => x ** 3;\n`);
  me.tcm("add");
  const out = me.tcm("contribute", "--title", "Cubes <3");
  const link = /review: tcm contribution view 1 · (\S+)/.exec(out)![1]!;
  assert.equal(link, `${url}/contributions/1#token=tok`);

  // the page itself holds nothing: without the token, there's no data to see
  const html = await (await fetch(`${url}/contributions/1`)).text();
  assert.doesNotMatch(html, /Cubes/);
  assert.equal((await fetch(`${url}/contributions`, { method: "POST", body: "{}" })).status, 401);

  await withPage(link, async (page) => {
    const text = await page.waitFor<string>(`document.querySelector("pre.diff")?.textContent ?? ""`, (t) => /lib\.cube/.test(t));
    assert.match(text, /added\n {4}\+ lib\.cube/);
    assert.match(await page.evaluate<string>(`document.querySelector("h1").textContent`), /#1 Cubes <3open/, "titles are text, not HTML");
    assert.equal(await page.evaluate(`location.hash`), "", "the token leaves the address bar");
    await page.evaluate(`(() => {
      const f = document.getElementById("comment");
      f.body.value = "Looks right";
      f.author.value = "grace";
      f.about.value = "lib.cube";
      f.requestSubmit();
    })()`);
    await page.waitFor<string>(`document.querySelector(".comment")?.textContent ?? ""`, (t) => /grace.*on lib\.cube.*Looks right/s.test(t));
    await page.evaluate(`document.getElementById("merge").click()`);
    await page.waitFor<string>(`document.querySelector("h1")?.textContent ?? ""`, (t) => /merged$/.test(t));
    assert.deepEqual(page.errors, []);
  });
  assert.match(me.tcm("contribution", "view", "1"), /merged into main[\s\S]*grace \S+ \S+ on lib\.cube\n {4}Looks right/);
  assert.equal(server.tcm("run", "lib.cube", "2").trim(), "8");
});
