// Sync between codebases: pull and push between directories, and `tcm serve` for running code remotely.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import tls from "node:tls";
import { okIn, plainEnv, tcmBin, tempDir, withChildren } from "./harness.ts";

type Keep = <C extends ChildProcess>(c: C) => C;

function codebase(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
  tcm("init");
  return { dir, tcm, scratch };
}

/** Start `tcm serve` on a free port; resolves to its base URL (and certificate fingerprint with --tls). */
function startServer(keep: Keep, dir: string, token: string, ...extra: string[]): Promise<string> {
  return startServerInfo(keep, dir, token, ...extra).then((i) => i.url);
}

function startServerInfo(keep: Keep, dir: string, token: string, ...extra: string[]): Promise<{ url: string; fingerprint?: string }> {
  const child = keep(spawn(process.execPath, [tcmBin(), "serve", "--port", "0", "--token", token, ...extra], { cwd: dir, env: plainEnv() }));
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const m = /url\s+(https?:\/\/[\d.]+:\d+)/.exec(out);
      const fp = /sha256 ([0-9A-F:]+)/.exec(out)?.[1];
      if (m && (!extra.includes("--tls") || fp)) resolve({ url: m[1]!, fingerprint: fp });
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

/** pull, push and divergence between codebase directories */
export const testPullPushDivergence = () => {
  const root = tempDir("sync");
  const a = codebase(root, "a");
  a.tcm("add");
  a.scratch(`// tcm: namespace lib\nimport { square } from "#codebase";\nexport const sumSquares = (xs: number[]) => xs.map(square).reduce((x, y) => x + y, 0);\n`);
  a.tcm("add");

  const b = codebase(root, "b");
  fs.rmSync(path.join(b.dir, "scratch.ts"));
  b.tcm("remote", "add", "origin", a.dir);
  assert.match(b.tcm("pull"), /received 2 definition\(s\), verified by re-hashing[\s\S]*fast-forwarded main/);
  assert.equal(b.tcm("ls"), a.tcm("ls"), "same names, same hashes");

  b.scratch(`export const square = (x: number): number => x * x * x;\n`);
  b.tcm("update");
  assert.match(b.tcm("push"), /pushed origin\/main: 0 added, 2 changed/);
  assert.match(a.tcm("diff"), /edited\s+~ square[\s\S]*updated because a dependency changed[\s\S]*lib\.sumSquares/);

  a.scratch(`export const onlyInA = 1;\n`);
  a.tcm("add");
  b.scratch(`export const onlyInB = 2;\n`);
  b.tcm("add");
  assert.throws(() => b.tcm("push"), /has changes you don't have/);
  // pulling merges the remote's changes with ours; pushing then publishes the merge
  assert.match(b.tcm("pull"), /merged origin\/main into main[\s\S]*\+ onlyInA[\s\S]*merged cleanly/);
  assert.match(b.tcm("ls"), /onlyInA[\s\S]*onlyInB/);
  assert.match(b.tcm("push"), /pushed origin\/main/);
  assert.match(a.tcm("ls"), /onlyInA[\s\S]*onlyInB/);
};

/** tcm serve: run --on sends missing code, streams output, and rejects tampered definitions */
export const testServeRunOn = () =>
  withChildren(async (keep) => {
    const root = tempDir("sync");
    const server = codebase(root, "server");
    const client = codebase(root, "client");
    const url = await startServer(keep, server.dir, "tok");
    client.scratch(`export const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
export const report = (n: string) => { console.log("cwd " + process.cwd()); return \`fib(\${n}) = \${fib(Number(n))}\`; };
`);
    client.tcm("add");
    client.tcm("remote", "add", "srv", url, "--token", "tok");
    const out = client.tcm("run", "report", "20", "--on", "srv");
    assert.match(out, /sent 2 definition\(s\)/);
    assert.match(out, new RegExp(`cwd ${fs.realpathSync(server.dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "ran in the server's codebase");
    assert.match(out, /fib\(20\) = 6765/);
    assert.doesNotMatch(client.tcm("run", "report", "5", "--on", "srv"), /sent/, "nothing to send the second time");

    client.tcm("remote", "add", "wrong", url, "--token", "nope");
    assert.throws(() => client.tcm("run", "report", "1", "--on", "wrong"), /missing or wrong token/);

    // fetch an honest record from the client, then try to slip altered source past the server under the same hash
    client.scratch(`export const greet = (name: string) => \`hello \${name}\`;\n`);
    client.tcm("add");
    const clientUrl = await startServer(keep, client.dir, "tok2");
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

/** tcm serve --tls: clients pin the certificate and never send the token to an impostor */
export const testServeTlsPinning = () =>
  withChildren(async (keep) => {
    const root = tempDir("sync");
    const server = codebase(root, "tls-server");
    const client = codebase(root, "tls-client");
    client.tcm("add");
    const { url, fingerprint } = await startServerInfo(keep, server.dir, "tlstok", "--tls");
    assert.match(url, /^https:/);
    client.tcm("remote", "add", "s", url, "--token", "tlstok", "--fingerprint", fingerprint!);
    assert.match(client.tcm("run", "square", "7", "--on", "s"), /^49$/m);

    // an impostor with a different certificate: the handshake completes, but no request bytes may follow
    const other = codebase(root, "impostor");
    spawnSync(process.execPath, [tcmBin(), "serve", "--tls", "--port", "1"], { cwd: other.dir, env: plainEnv(), timeout: 5000 }); // creates other/.tcm/tls
    const received: Buffer[] = [];
    const impostor = tls.createServer(
      { cert: fs.readFileSync(path.join(other.dir, ".tcm/tls/cert.pem")), key: fs.readFileSync(path.join(other.dir, ".tcm/tls/key.pem")) },
      (socket) => socket.on("data", (d) => received.push(d)),
    );
    try {
      await new Promise<void>((r) => impostor.listen(0, "127.0.0.1", r));
      const port = (impostor.address() as { port: number }).port;
      client.tcm("remote", "add", "fake", `https://127.0.0.1:${port}`, "--token", "tlstok", "--fingerprint", fingerprint!);
      // run the client asynchronously: the impostor lives in this process and must keep serving the handshake
      const attempt = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = keep(spawn(process.execPath, [tcmBin(), "run", "square", "7", "--on", "fake"], { cwd: client.dir, env: plainEnv() }));
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      });
      assert.equal(attempt.code, 1);
      assert.match(attempt.out, /fingerprint mismatch[\s\S]*refusing to send the token/);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      impostor.close();
    }
    assert.equal(Buffer.concat(received).length, 0, "nothing, not even headers, reached the impostor");

    assert.throws(() => server.tcm("serve", "--host", "0.0.0.0", "--port", "0"), /without TLS would send the token in clear text/);
  });
