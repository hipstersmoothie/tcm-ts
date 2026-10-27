import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm web "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

function ucm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
/** The full hash a name points to (`ucm ls` shows short ones). */
function hashOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".ucm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}

/** Start `ucm dev`; resolves with its URL and a way to wait for more output. */
function startDev(app: string): Promise<{ url: string; output: () => string }> {
  const child = spawn(process.execPath, [BIN, "dev", app, "--port", "0"], { cwd: dir, env });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const m = /url\s+(http:\/\/\S+)/.exec(out);
      if (m) {
        clearInterval(t);
        resolve({ url: m[1]!, output: () => out });
      }
    }, 50);
    child.on("exit", (code) => reject(new Error(`ucm dev exited ${code}:\n${out}`)));
  });
}

/**
 * fetch, retried once when a pooled keep-alive connection is reset: the server may close an idle socket just as
 * it is reused, which happens when a loaded machine stretches the gaps between requests. Browsers retry these too.
 */
async function get(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "ECONNRESET") throw e;
    return fetch(url, init);
  }
}

/**
 * Every module a browser would load for the app, following imports from the entry. While Vite's dependency
 * optimizer is still scanning it can answer with a non-200 (a real browser recovers via Vite's client), so a
 * crawl that meets one starts over.
 */
async function crawl(url: string, attempts = 6): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [new URL("/entry.ts", url).href];
  while (queue.length) {
    const u = queue.pop()!;
    if (seen.has(u)) continue;
    const res = await get(u);
    if (res.status !== 200) {
      if (attempts <= 1) throw new Error(`${u}: ${res.status}`);
      await new Promise((r) => setTimeout(r, 500));
      return crawl(url, attempts - 1);
    }
    const text = await res.text();
    seen.set(u, text);
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) if (/^[./]/.test(m[1]!)) queue.push(new URL(m[1]!, u).href);
  }
  return seen;
}

/** The page after its scripts ran, from headless Chrome; retried, since a loaded machine can cut a snapshot short. */
function renderedPage(url: string, expect: RegExp): string {
  let dom = "";
  for (let i = 0; i < 3 && !expect.test(dom); i++) {
    dom = spawnSync(CHROME!, ["--headless=new", "--disable-gpu", "--no-first-run", "--virtual-time-budget=8000", "--dump-dom", url], { encoding: "utf8" }).stdout;
  }
  return dom;
}

const waitFor = async (cond: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (cond()) return;
  throw new Error("timed out waiting");
};

const rpc = (url: string, hash: string, args: unknown[]) =>
  get(new URL(`/__ucm/rpc/${hash}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }).then(async (r) => ({ status: r.status, body: await r.text() }));

test("ucm dev: placement is inferred, server code never reaches the browser, calls cross by hash", async () => {
  ucm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  scratch(`// ucm: namespace app
import { readFileSync } from "node:fs";
const visits = new Map<string, number>();
export async function lineCount(): Promise<number> { return readFileSync(${JSON.stringify(fileURLToPath(import.meta.url))}, "utf8").split("\\n").length; }
export async function visit(who: string): Promise<{ who: string; n: number; pid: number; at: Date }> {
  const n = (visits.get(who) ?? 0) + 1;
  visits.set(who, n);
  return { who, n, pid: process.pid, at: new Date(0) };
}
export const render = (lines: number, n: number) => \`lines \${lines}, visit \${n}\`;
export async function main() {
  const v = await visit("ada");
  document.querySelector("#app")!.textContent = render(await lineCount(), v.n);
}
`);
  ucm("add");
  assert.match(ucm("view", "app.lineCount"), /runs on the server: it uses node:fs; browser code calls it by hash/);
  assert.match(ucm("view", "app.main"), /runs in the browser: it uses document/);
  assert.match(ucm("view", "app.render"), /runs anywhere/);

  const { url, output } = await startDev("app.main");
  assert.match(output(), /server\s+2 function\(s\) the browser calls by hash: app\.(visit|lineCount)/);

  // what the browser receives: the browser half, and stubs in place of the server half
  const modules = await crawl(url);
  const shipped = [...modules.values()].join("\n");
  for (const secret of ["readFileSync", "node:fs", "process.pid", "visits.set"]) assert.ok(!shipped.includes(secret), `${secret} must not reach the browser`);
  assert.ok([...modules.keys()].some((u) => u.includes("ucm-stub")), "server components arrive as stubs");
  assert.ok(shipped.includes("lines ${lines}"), "browser code is shipped as code");

  // the endpoints: exactly the server functions the app calls; state stays on the server
  const first = await rpc(url, hashOf("app.visit"), ["ada"]);
  const second = await rpc(url, hashOf("app.visit"), ["ada"]);
  assert.equal(first.status, 200);
  assert.match(second.body, /"n":2/);
  assert.match(first.body, /"at":\{"\$d":"1970-01-01T00:00:00.000Z"\}/, "dates cross as dates");
  assert.equal((await rpc(url, hashOf("app.render"), [1, 2])).status, 403, "browser code is not an endpoint");

  if (CHROME) {
    // the visit count depends on how often the headless page reloads; that it came from the server is what matters
    const expect = /<div id="app">lines \d+, visit \d+<\/div>/;
    assert.match(renderedPage(url, expect), expect, "the app ran in a real browser and called the server");
  }

  // an update in another process reloads the app
  scratch(`// ucm: namespace app\nexport const render = (lines: number, n: number) => \`\${lines} lines (visit \${n})\`;\n`);
  ucm("update");
  const updated = hashOf("app.main");
  let entry = "";
  for (const end = Date.now() + 8000; Date.now() < end && !entry.includes(updated); await new Promise((r) => setTimeout(r, 150))) {
    entry = await (await get(new URL("/entry.ts", url))).text();
  }
  assert.ok(entry.includes(updated), "the entry now imports the updated app");
  assert.match(output(), /reloaded app\.main/);
  if (CHROME) {
    const expect = /<div id="app">\d+ lines \(visit \d+\)<\/div>/;
    assert.match(renderedPage(url, expect), expect, "the reloaded app renders with the updated code");
  }

  // a synchronous server function can't be called across the network; the error names it
  scratch(`// ucm: namespace app
import { hostname } from "node:os";
export const machine = () => hostname();
export async function main() { document.body.textContent = machine(); }
`);
  ucm("update");
  await waitFor(() => /calls app\.machine, which runs on the server .* isn't async/.test(output()));
  assert.match(output(), /Make app\.machine async\./);
});
