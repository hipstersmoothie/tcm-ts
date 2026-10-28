import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
import { session, setSession, clearSession, HttpError, request, withRequest } from "#ucm/server";

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
}

// server functions are testable without a server: withRequest simulates the call
export const testLoginThenMe = async () => {
  const { setCookies } = await withRequest({}, () => login("ada", "lovelace"));
  const cookie = setCookies[0]!.split(";")[0]!.slice("ucm_session=".length);
  const who = await withRequest({ cookies: { ucm_session: decodeURIComponent(cookie) }, headers: { "x-client": "test" } }, () => me());
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

  const { url, output } = await serve("start", "auth.main");
  const jar = new Map<string, string>();
  const anon = await call(url, "auth.me", [], jar);
  assert.equal(anon.status, 401);
  assert.match(anon.body, /sign in first/);
  assert.equal((await call(url, "auth.login", ["ada", "nope"], jar)).status, 401);

  const login = await call(url, "auth.login", ["ada", "lovelace"], jar);
  assert.equal(login.status, 200);
  assert.match(login.setCookie[0]!, /^ucm_session=[^;]+; Path=\/; SameSite=Lax; Max-Age=\d+; HttpOnly$/);
  assert.equal((await call(url, "auth.me", [], jar, { "x-client": "test" })).body, `"ada via test"`);

  // a forged session (same signature, different user) is no session
  const [payload, mac] = jar.get("ucm_session")!.split(".");
  const data = JSON.parse(Buffer.from(payload!, "base64url").toString());
  data.d.user = "admin";
  const forged = new Map([["ucm_session", `${Buffer.from(JSON.stringify(data)).toString("base64url")}.${mac}`]]);
  assert.equal((await call(url, "auth.me", [], forged)).status, 401);

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
});
