import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ucm sync "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const servers: ChildProcess[] = [];
after(() => servers.forEach((s) => s.kill()));

function codebase(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const ucm = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    if (r.status !== 0) throw new Error(`ucm ${args.join(" ")} exited ${r.status}:\n${out}`);
    return out;
  };
  const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
  ucm("init");
  return { dir, ucm, scratch };
}

/** Start `ucm serve` on a free port; resolves to its base URL. */
function startServer(dir: string, token: string): Promise<string> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0", "--token", token], { cwd: dir, env });
  servers.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const m = /url\s+(http:\/\/[\d.]+:\d+)/.exec(out);
      if (m) resolve(m[1]!);
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

test("pull, push and divergence between codebase directories", () => {
  const a = codebase("a");
  a.ucm("add");
  a.scratch(`// ucm: namespace lib\nimport { square } from "#codebase";\nexport const sumSquares = (xs: number[]) => xs.map(square).reduce((x, y) => x + y, 0);\n`);
  a.ucm("add");

  const b = codebase("b");
  fs.rmSync(path.join(b.dir, "scratch.ts"));
  b.ucm("remote", "add", "origin", a.dir);
  assert.match(b.ucm("pull"), /received 2 definition\(s\), verified by re-hashing[\s\S]*fast-forwarded main/);
  assert.equal(b.ucm("ls"), a.ucm("ls"), "same names, same hashes");

  b.scratch(`export const square = (x: number): number => x * x * x;\n`);
  b.ucm("update");
  assert.match(b.ucm("push"), /pushed origin\/main: 0 added, 2 changed/);
  assert.match(a.ucm("diff"), /edited\s+~ square[\s\S]*updated because a dependency changed[\s\S]*lib\.sumSquares/);

  a.scratch(`export const onlyInA = 1;\n`);
  a.ucm("add");
  b.scratch(`export const onlyInB = 2;\n`);
  b.ucm("add");
  assert.throws(() => b.ucm("push"), /has changes you don't have/);
  assert.match(b.ucm("pull"), /not fast-forwarded/);
  assert.match(b.ucm("diff", "main", "origin/main"), /added\s+\+ onlyInA[\s\S]*removed\s+- onlyInB/);
});

test("ucm serve: run --on sends missing code, streams output, and rejects tampered definitions", async () => {
  const server = codebase("server");
  const client = codebase("client");
  const url = await startServer(server.dir, "tok");
  client.scratch(`export const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
export const report = (n: string) => { console.log("cwd " + process.cwd()); return \`fib(\${n}) = \${fib(Number(n))}\`; };
`);
  client.ucm("add");
  client.ucm("remote", "add", "srv", url, "--token", "tok");
  const out = client.ucm("run", "report", "20", "--on", "srv");
  assert.match(out, /sent 2 definition\(s\)/);
  assert.match(out, new RegExp(`cwd ${fs.realpathSync(server.dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "ran in the server's codebase");
  assert.match(out, /fib\(20\) = 6765/);
  assert.doesNotMatch(client.ucm("run", "report", "5", "--on", "srv"), /sent/, "nothing to send the second time");

  client.ucm("remote", "add", "wrong", url, "--token", "nope");
  assert.throws(() => client.ucm("run", "report", "1", "--on", "wrong"), /missing or wrong token/);

  // fetch an honest record from the client, then try to slip altered source past the server under the same hash
  client.scratch(`export const greet = (name: string) => \`hello \${name}\`;\n`);
  client.ucm("add");
  const clientUrl = await startServer(client.dir, "tok2");
  const call = async (base: string, token: string, route: string, body: unknown) => {
    const res = await fetch(`${base}/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const branch = (await call(clientUrl, "tok2", "branch", { name: "main" })).body.branch;
  const greetHash = branch.names.find((n: { path: string }) => n.path === "greet").hash as string;
  const [rec] = (await call(clientUrl, "tok2", "get", { hashes: [greetHash] })).body.records;
  const evil = { ...rec, sourceText: rec.sourceText.replace("`hello ${name}`", '"pwned"') };
  const rejected = await call(url, "tok", "put", { records: [evil] });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /source does not match their hashes/);
  assert.deepEqual((await call(url, "tok", "put", { records: [rec] })).body, { stored: 1 });
});
