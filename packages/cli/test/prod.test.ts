import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm prod "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);

/** fetch, retried once on a keep-alive connection reset (see web.test.ts). */
async function get(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "ECONNRESET") throw e;
    return fetch(url, init);
  }
}

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await cond()) return;
  throw new Error("timed out waiting");
};

/** What a browser tab loads: the page's script, and the server function hash that script calls. */
async function loadTab(url: string) {
  const page = await (await get(url)).text();
  const asset = /\/_app\/[a-z2-7]{52}\/assets\/[^"]+\.js/.exec(page)![0];
  const js = await (await get(new URL(asset, url))).text();
  return { asset, endpoint: /[`"']([a-z2-7]{52})[`"']/.exec(js)![1]!, js };
}

const call = async (url: string, hash: string, args: unknown[]) => {
  const r = await get(new URL(`/__ucm/rpc/${hash}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  return { status: r.status, body: await r.text() };
};

test("ucm build / start: deploy and roll back by moving a name; open tabs keep working", async () => {
  ucm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  scratch(`// ucm: namespace app
import { hostname } from "node:os";
export async function greeting(name: string): Promise<string> { return "hello " + name + " from " + hostname(); }
export async function main() { document.querySelector("#app")!.textContent = await greeting("ada"); }
`);
  ucm("add");
  assert.match(ucm("build", "app.main"), /built app\.main/);

  const child = spawn(process.execPath, [BIN, "start", "app.main", "--port", "0"], { cwd: dir, env });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  await waitFor(() => /url\s+http:\/\/\S+/.test(out));
  const url = /url\s+(http:\/\/\S+)/.exec(out)![1]!;

  // v1, as an open tab sees it
  const v1 = await loadTab(url);
  assert.ok(!v1.js.includes("hostname"), "server code isn't in the production bundle");
  assert.equal((await call(url, v1.endpoint, ["ada"])).body, `"hello ada from ${os.hostname()}"`);

  // public endpoints check their arguments against the parameter types
  const bad = await call(url, v1.endpoint, [42]);
  assert.equal(bad.status, 400);
  assert.match(bad.body, /argument `name` should be a string, got number 42/);
  assert.match((await call(url, v1.endpoint, ["ada", "extra"])).body, /expected at most 1 argument/);

  // deploy: update the server function; the server builds and switches by itself
  // (still using Node, so it stays on the server; without hostname() it would move into the browser bundle)
  scratch(`// ucm: namespace app\nimport { hostname } from "node:os";\nexport async function greeting(name: string): Promise<string> { return "hi " + name + " (v2 on " + hostname() + ")"; }\n`);
  ucm("update");
  await waitFor(() => /deployed app\.main/.test(out));
  const v2 = await loadTab(url);
  assert.notEqual(v2.asset, v1.asset);
  assert.equal((await call(url, v2.endpoint, ["ada"])).body, `"hi ada (v2 on ${os.hostname()})"`);

  // the tab opened before the deploy keeps working against the code it was built with
  assert.equal((await get(new URL(v1.asset, url))).status, 200);
  assert.equal((await call(url, v1.endpoint, ["ada"])).body, `"hello ada from ${os.hostname()}"`);

  // roll back by moving the names back: the v1 build is reused
  const before = /^\s*(\d+)\s.*app\.greeting.*update scratch\.ts/m.exec(ucm("history", "50"))![1]!;
  ucm("reset", String(Number(before) - 1));
  await waitFor(async () => (await loadTab(url)).asset === v1.asset);
});
