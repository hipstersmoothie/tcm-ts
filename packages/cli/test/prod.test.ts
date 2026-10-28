import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm prod "));
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
  const r = await get(new URL(`/__tcm/rpc/${hash}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  return { status: r.status, body: await r.text() };
};

test("tcm build / start: deploy and roll back by moving a name; open tabs keep working", async () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  scratch(`// tcm: namespace app
import { hostname } from "node:os";
export async function greeting(name: string): Promise<string> { return "hello " + name + " from " + hostname(); }
export async function main() { document.querySelector("#app")!.textContent = await greeting("ada"); }
`);
  tcm("add");
  assert.match(tcm("build", "app.main"), /built app\.main/);

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
  scratch(`// tcm: namespace app\nimport { hostname } from "node:os";\nexport async function greeting(name: string): Promise<string> { return "hi " + name + " (v2 on " + hostname() + ")"; }\n`);
  tcm("update");
  await waitFor(() => /deployed app\.main/.test(out));
  const v2 = await loadTab(url);
  assert.notEqual(v2.asset, v1.asset);
  assert.equal((await call(url, v2.endpoint, ["ada"])).body, `"hi ada (v2 on ${os.hostname()})"`);

  // the tab opened before the deploy keeps working against the code it was built with
  assert.equal((await get(new URL(v1.asset, url))).status, 200);
  assert.equal((await call(url, v1.endpoint, ["ada"])).body, `"hello ada from ${os.hostname()}"`);

  // roll back by moving the names back: the v1 build is reused
  const before = /^\s*(\d+)\s.*app\.greeting.*update scratch\.ts/m.exec(tcm("history", "50"))![1]!;
  tcm("reset", String(Number(before) - 1));
  await waitFor(async () => (await loadTab(url)).asset === v1.asset);

  // pruning: keep only the current build; a tab still on the removed v2 build is told to reload (410)
  const apps = tcm("apps");
  assert.equal(apps.trim().split("\n").length, 2, "both builds are listed");
  assert.match(apps, new RegExp(`\\* app\\.main\\s+#${v1.asset.split("/")[2]!.slice(0, 8)}`), "the rolled-back-to build is current");
  assert.match(tcm("apps", "prune", "--keep", "0"), /removed 1 build/);
  await waitFor(async () => (await call(url, v2.endpoint, ["ada"])).status === 410);
  assert.equal((await get(new URL(v2.asset, url))).status, 404);
  assert.equal((await call(url, v1.endpoint, ["ada"])).status, 200, "the current build is untouched");
});

test("the browser runtime reloads a page whose build was retired", async () => {
  const { browserRuntime } = await import("../src/web.ts");
  let reloads = 0;
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, location: g.location };
  g.location = { reload: () => reloads++ };
  g.fetch = async () => new Response(JSON.stringify({ name: "OutdatedError", message: "gone" }), { status: 410 });
  try {
    const mod = (await import("data:text/javascript," + encodeURIComponent(browserRuntime()))) as { remote: (h: string, n: string, c: boolean) => () => Promise<unknown> };
    const call = mod.remote("a".repeat(52), "greeting", true)();
    const settled = await Promise.race([call.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 100))]);
    assert.equal(reloads, 1, "the page reloads itself onto the current build");
    assert.equal(settled, "pending", "and the stale call never resolves with stale data");
  } finally {
    Object.assign(g, saved);
    delete g.__tcmReloading;
  }
});

test("module-level state is placed by who uses it, and split state is flagged", () => {
  scratch(`// tcm: namespace st
import { hostname } from "node:os";
export const visits = new Map<string, number>();
export const recent: string[] = [];
export const shared = { hits: 0 };
export const frozen = { a: 1 } as const;
export async function whoami(name: string): Promise<string> { visits.set(name, 1); shared.hits++; return hostname() + String(frozen.a); }
export async function app() { recent.push("x"); shared.hits++; document.title = await whoami("ada"); }
`);
  tcm("add");
  const out = tcm("build", "st.app");
  assert.match(out, /state\s+st\.visits on the server, shared by every client/);
  assert.match(out, /state\s+st\.recent in the browser, one copy per tab/);
  assert.match(out, /warning\s+st\.shared is used by both browser and server code/);
  assert.doesNotMatch(out, /st\.frozen/, "an `as const` value isn't mutable state");
});

test("tcm push deploys: a running `tcm start` on the other side builds and switches", async () => {
  const server = fs.mkdtempSync(path.join(os.tmpdir(), "tcm deploy-server "));
  const laptop = fs.mkdtempSync(path.join(os.tmpdir(), "tcm deploy-laptop "));
  const at = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} in ${cwd}: ${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  at(server, "init");
  at(laptop, "init");
  const app = (version: string) =>
    fs.writeFileSync(
      path.join(laptop, "scratch.ts"),
      `// tcm: namespace web
import { hostname } from "node:os";
export async function hello(): Promise<string> { return "${version} " + hostname(); }
export async function main() { document.body.textContent = await hello(); }
`,
    );
  app("v1");
  at(laptop, "add");
  at(laptop, "remote", "add", "prod", server);
  assert.match(at(laptop, "push", "prod"), /pushed prod\/main/, "a fresh server's empty branch can be pushed to");

  const child = spawn(process.execPath, [BIN, "start", "web.main", "--port", "0"], { cwd: server, env });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  await waitFor(() => /url\s+http:\/\/\S+/.test(out));
  const url = /url\s+(http:\/\/\S+)/.exec(out)![1]!;
  const v1 = await loadTab(url);
  assert.match((await call(url, v1.endpoint, [])).body, /^"v1 /);

  app("v2");
  at(laptop, "update");
  assert.match(at(laptop, "push", "prod"), /sent \d+ definition/);
  await waitFor(() => /deployed web\.main/.test(out));
  const v2 = await loadTab(url);
  assert.match((await call(url, v2.endpoint, [])).body, /^"v2 /);
  assert.match((await call(url, v1.endpoint, [])).body, /^"v1 /, "tabs opened before the push keep working");
});
