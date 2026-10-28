import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CHROME, pageText } from "./browser.ts";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucm server "));
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
function hashOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".ucm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}

async function serve(...args: string[]): Promise<{ url: string; output: () => string }> {
  const child = spawn(process.execPath, [BIN, ...args, "--port", "0"], { cwd: dir, env });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  for (const end = Date.now() + 30000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const m = /url\s+(http:\/\/\S+)/.exec(out);
    if (m) return { url: m[1]!, output: () => out };
  }
  throw new Error(`no url:\n${out}`);
}

/** POST to a server function, carrying cookies like a browser would. */
async function call(url: string, name: string, args: unknown[], jar: Map<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(new URL(`/__ucm/rpc/${hashOf(name)}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
    body: JSON.stringify(args),
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const [k, v] = kv!.split("=");
    if (/Max-Age=0/.test(c)) jar.delete(k!);
    else jar.set(k!, v!);
  }
  return { status: res.status, body: await res.text(), setCookie: res.headers.getSetCookie() };
}

const AUTH = `// ucm: namespace auth
import assert from "node:assert/strict";
import { session, setSession, clearSession, revokeSessions, rateLimit, HttpError, request, withRequest } from "#ucm/server";

const USERS: Record<string, string> = { ada: "lovelace" };

export async function login(name: string, password: string): Promise<string> {
  if (USERS[name] !== password) throw new HttpError(401, "wrong name or password");
  setSession({ user: name });
  return name;
}
export async function me(): Promise<string> {
  const user = session().user;
  if (typeof user !== "string") throw new HttpError(401, "sign in first");
  return user + " via " + (request().headers.get("x-client") ?? "?");
}
export async function logout(): Promise<void> {
  clearSession();
}
export async function signOutEverywhere(): Promise<number> {
  const user = session().user;
  return revokeSessions((s) => s.user === user);
}
export async function ping(): Promise<string> {
  rateLimit("ping:" + request().ip, { max: 2, per: 60 });
  return "pong";
}
/** Streams to the browser; the request context lasts as long as the stream. */
export async function* ticks(n: number): AsyncGenerator<string> {
  const who = session().user ?? "anon";
  for (let i = 1; i <= n; i++) {
    await new Promise((r) => setTimeout(r, 20));
    yield i + ":" + who;
  }
}
export async function crash(): Promise<number> {
  if (request()) throw new Error("db password is hunter2");
  return 0;
}
export async function main() {
  const button = (label: string, run: () => Promise<unknown>) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => (document.title = String(await run()));
    document.body.append(b);
  };
  button("log in", () => login("ada", "lovelace"));
  button("who am I", () => me());
  button("log out", () => logout());
  button("crash", () => crash());
  button("sign out everywhere", () => signOutEverywhere());
  button("ping", () => ping());
  button("ticks", async () => {
    const got: string[] = [];
    for await (const t of ticks(3)) got.push(t);
    return got.join(",");
  });
}

/** In a real browser: log in, then iterate a server-side stream with for-await. */
export async function streamApp() {
  await login("ada", "lovelace");
  const got: string[] = [];
  for await (const t of ticks(3)) got.push(t);
  document.querySelector("#app")!.textContent = got.join(",");
}

// plain HTTP endpoints, routed by name (served with --http auth.api)
// ucm: path auth.api.health
export const health = (req: Request) => ({ ok: true, method: req.method });
// ucm: path auth.api.hooks.payment
export async function paymentHook(req: Request): Promise<Response> {
  const event = (await req.json()) as { type: string };
  return new Response(JSON.stringify({ received: event.type }), { status: 202, headers: { "x-handled-by": "ucm" } });
}

// server functions are testable without a server: withRequest simulates the call
export const testLoginThenMe = async () => {
  const { setCookies } = await withRequest({}, () => login("ada", "lovelace"));
  const sid = setCookies[0]!.split(";")[0]!.slice("ucm_sid=".length);
  const who = await withRequest({ cookies: { ucm_sid: decodeURIComponent(sid) }, headers: { "x-client": "test" } }, () => me());
  assert.equal(who.value, "ada via test");
};
export const testWrongPassword = async () => {
  await assert.rejects(withRequest({}, () => login("ada", "nope")), (e: { status?: number }) => e.status === 401);
};
`;

test("server functions: request context, sessions, deliberate and hidden errors, CSRF", async () => {
  ucm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  scratch(AUTH);
  ucm("add");
  assert.match(ucm("view", "auth.me"), /runs on the server: it uses #ucm\/server \(session\)/);
  assert.match(ucm("test", "auth"), /2 passed, 0 failed/, "withRequest runs server functions in tests, no network");

  const { url, output } = await serve("start", "auth.main", "--http", "auth.api");
  const jar = new Map<string, string>();
  const anon = await call(url, "auth.me", [], jar);
  assert.equal(anon.status, 401);
  assert.match(anon.body, /sign in first/);
  assert.equal((await call(url, "auth.login", ["ada", "nope"], jar)).status, 401);

  const login = await call(url, "auth.login", ["ada", "lovelace"], jar);
  assert.equal(login.status, 200);
  assert.match(login.setCookie[0]!, /^ucm_sid=[^;]+; Path=\/; SameSite=Lax; Max-Age=\d+; HttpOnly$/);
  assert.equal((await call(url, "auth.me", [], jar, { "x-client": "test" })).body, `"ada via test"`);
  assert.ok(fs.existsSync(path.join(dir, ".ucm", "data", "sessions.sqlite")), "session data lives server-side, apart from the codebase");
  assert.match(fs.readFileSync(path.join(dir, ".ucm", ".gitignore"), "utf8"), /^data\/$[\s\S]*^secret$/m, "app data and secrets are never committed");

  // the cookie is only an id: a made-up one is no session
  assert.equal((await call(url, "auth.me", [], new Map([["ucm_sid", "made-up-session-id"]]))).status, 401);

  // revocation: sign in on a second device, sign out everywhere from it; the first device is signed out too
  const phone = new Map<string, string>();
  await call(url, "auth.login", ["ada", "lovelace"], phone);
  assert.match((await call(url, "auth.signOutEverywhere", [], phone)).body, /^[1-9]\d*$/);
  assert.equal((await call(url, "auth.me", [], jar)).status, 401, "the laptop's session was revoked");
  await call(url, "auth.login", ["ada", "lovelace"], jar);

  // rate limits: a 429 with Retry-After once the window is full
  assert.equal((await call(url, "auth.ping", [], jar)).status, 200);
  assert.equal((await call(url, "auth.ping", [], jar)).status, 200);
  const limited = await fetch(new URL(`/__ucm/rpc/${hashOf("auth.ping")}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: "[]" });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);

  // streaming: chunks as they're produced, with the caller's session; stopping early stops the server side
  const stream = await fetch(new URL(`/__ucm/rpc/${hashOf("auth.ticks")}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ucm_sid=${jar.get("ucm_sid")}` },
    body: "[3]",
  });
  assert.equal(stream.headers.get("content-type"), "application/x-ndjson");
  assert.equal(await stream.text(), ['{"v":"1:ada"}', '{"v":"2:ada"}', '{"v":"3:ada"}', '{"done":true}', ""].join("\n"));
  const ctl = new AbortController();
  const partial = await fetch(new URL(`/__ucm/rpc/${hashOf("auth.ticks")}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: "[50]", signal: ctl.signal });
  const reader = partial.body!.getReader();
  await reader.read();
  ctl.abort();
  for (const end = Date.now() + 5000; Date.now() < end && !/auth\.ticks stream \d+ chunk\(s\), \d+ms, stopped by the client/.test(output()); ) await new Promise((r) => setTimeout(r, 50));
  assert.match(output(), /auth\.ticks stream \d+ chunk\(s\), \d+ms, stopped by the client/);

  // plain HTTP endpoints: routes are names
  assert.deepEqual(await (await fetch(new URL("/api/health", url))).json(), { ok: true, method: "GET" });
  const hook = await fetch(new URL("/api/hooks/payment", url), { method: "POST", headers: { "content-type": "application/json" }, body: '{"type":"invoice.paid"}' });
  assert.equal(hook.status, 202);
  assert.equal(hook.headers.get("x-handled-by"), "ucm");
  assert.deepEqual(await hook.json(), { received: "invoice.paid" });
  assert.equal((await fetch(new URL("/api/nope", url))).status, 404);
  ucm("mv", "auth.api.health", "auth.api.status");
  assert.equal((await fetch(new URL("/api/status", url))).status, 200, "renaming moves the URL, no restart");
  assert.equal((await fetch(new URL("/api/health", url))).status, 404);

  // in production, unexpected errors are logged on the server and hidden from the browser
  const crash = await call(url, "auth.crash", [], jar);
  assert.equal(crash.status, 500);
  assert.match(crash.body, /"internal error"/);
  assert.doesNotMatch(crash.body, /hunter2/);
  assert.match(output(), /auth\.crash failed: Error: db password is hunter2/);

  // CSRF: no plain form posts, no cross-site calls
  const form = await fetch(new URL(`/__ucm/rpc/${hashOf("auth.me")}`, url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
  assert.equal(form.status, 415);
  assert.equal((await call(url, "auth.me", [], jar, { "sec-fetch-site": "cross-site" })).status, 403);

  await call(url, "auth.logout", [], jar);
  assert.equal((await call(url, "auth.me", [], jar)).status, 401, "logging out clears the session");

  // ucm dev shows unexpected errors in full, to the developer
  const devServer = await serve("dev", "auth.main");
  for (const end = Date.now() + 15000; Date.now() < end && !/server\s+\d+ function/.test(devServer.output()); ) await new Promise((r) => setTimeout(r, 100));
  const devCrash = await fetch(new URL(`/__ucm/rpc/${hashOf("auth.crash")}`, devServer.url), { method: "POST", headers: { "content-type": "application/json" }, body: "[]" });
  assert.match(await devCrash.text(), /hunter2/, "dev shows the real error");

  if (CHROME) {
    const live = await serve("dev", "auth.streamApp");
    const text = await pageText(live.url, "#app", (t) => t.split(",").length === 3);
    assert.equal(text, "1:ada,2:ada,3:ada", "a real browser streams a server generator, with the session");
  }
});
