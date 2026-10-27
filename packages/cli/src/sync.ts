import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { shortHash, type DefRecord } from "@ucm/core";
import type { NameRow } from "@ucm/store";
import { runStreaming } from "@ucm/loader";
import { Codebase, IDENT_PATH } from "./codebase.ts";
import { diffNamespaces, printDiff, stateOf } from "./diff.ts";
import { mergeBranch, recordMergeBase } from "./merge.ts";
import { bold, dim, green, red, yellow } from "./style.ts";


export type Output = (stream: "stdout" | "stderr", data: string) => void;

export interface BranchState {
  stateHash: string;
  names: NameRow[];
}

/** What one codebase can ask of another. */
export interface Remote {
  readonly label: string;
  /** which of these component hashes are absent */
  missing(components: string[]): Promise<string[]>;
  /** full components containing these definition hashes */
  get(hashes: string[]): Promise<DefRecord[]>;
  put(records: DefRecord[]): Promise<{ stored: number }>;
  branch(name: string): Promise<BranchState | null>;
  /** replace a branch's names, only if its state is still `expect` (null: branch must not exist) */
  setBranch(name: string, names: NameRow[], expect: string | null, command: string): Promise<void>;
  run(hash: string, args: string[], out: Output): Promise<number>;
}

export class ConflictError extends Error {}

/** The serving side of the protocol, over a local codebase. */
export class Peer {
  readonly cb: Codebase;
  readonly allowRun: boolean;

  constructor(cb: Codebase, allowRun = true) {
    this.cb = cb;
    this.allowRun = allowRun;
  }

  missing(components: string[]): string[] {
    return components.filter((c) => this.cb.store.componentMembers(c).length === 0);
  }

  get(hashes: string[]): DefRecord[] {
    const comps = new Set<string>();
    for (const h of hashes) {
      const rec = this.cb.store.getDef(h);
      if (rec) comps.add(rec.componentHash);
    }
    return [...comps].flatMap((c) => this.cb.store.componentMembers(c));
  }

  put(records: DefRecord[]): { stored: number } {
    return this.cb.receive(records);
  }

  branch(name: string): BranchState | null {
    if (!this.cb.store.hasBranch(name)) return null;
    return { stateHash: this.cb.store.stateHash(name), names: this.cb.store.names(name) };
  }

  setBranch(name: string, names: NameRow[], expect: string | null, command: string) {
    const current = this.cb.store.hasBranch(name) ? this.cb.store.stateHash(name) : null;
    if (current !== expect) throw new ConflictError(`branch '${name}' changed since you last synced`);
    this.cb.store.setBranchNames(name, validNames(this.cb, names), command);
    this.cb.refreshShim();
  }

  run(hash: string, args: string[], out: Output): Promise<number> {
    if (!this.allowRun) throw new Error("this server does not run code (started with --no-run)");
    const rec = this.cb.store.getDef(hash);
    if (!rec) throw new Error(`no definition ${shortHash(hash)}; send it first`);
    if (rec.kind === "type") throw new Error(`${shortHash(hash)} is a type`);
    return runStreaming(hash, args, this.cb.source(), this.cb.lay, out);
  }
}

/** Names from another codebase: paths must be valid and every hash must already be stored here; kinds come from the local store. */
function validNames(cb: Codebase, names: NameRow[]): NameRow[] {
  return names.map((n) => {
    if (!IDENT_PATH.test(n.path)) throw new Error(`invalid name '${n.path}'`);
    const rec = cb.store.getDef(n.hash);
    if (!rec) throw new Error(`${n.path} refers to ${shortHash(n.hash)}, which was not sent`);
    return { path: n.path, hash: n.hash, kind: rec.kind };
  });
}

/** Another codebase directory on this machine. */
class DirectoryRemote implements Remote {
  readonly label: string;
  private peer: Peer;

  constructor(dir: string) {
    this.label = dir;
    this.peer = new Peer(Codebase.find(path.resolve(dir)));
  }

  async missing(c: string[]) {
    return this.peer.missing(c);
  }
  async get(h: string[]) {
    return this.peer.get(h);
  }
  async put(r: DefRecord[]) {
    return this.peer.put(r);
  }
  async branch(n: string) {
    return this.peer.branch(n);
  }
  async setBranch(n: string, names: NameRow[], expect: string | null, command: string) {
    this.peer.setBranch(n, names, expect, command);
  }
  run(h: string, args: string[], out: Output) {
    return this.peer.run(h, args, out);
  }
}

/** A `ucm serve` server. */
/** Normalize `AB:cd:…` / `abcd…` fingerprints for comparison. */
const normalizeFingerprint = (f: string) => f.replace(/:/g, "").toUpperCase();

class HttpRemote implements Remote {
  readonly label: string;
  private url: URL;
  private token: string | undefined;
  private fingerprint: string | undefined;

  constructor(url: string, token?: string, fingerprint?: string) {
    this.label = url;
    this.url = new URL(url.endsWith("/") ? url : url + "/");
    this.token = token;
    this.fingerprint = fingerprint && normalizeFingerprint(fingerprint);
    if (this.fingerprint && this.url.protocol !== "https:") throw new Error(`a certificate fingerprint needs an https:// URL (${url})`);
  }

  /**
   * POST and resolve with the response stream. With a pinned fingerprint the server's certificate is checked
   * as soon as TLS is up, before any of the request (including the token) is written.
   */
  private post(route: string, body: unknown): Promise<http.IncomingMessage> {
    const target = new URL(route, this.url);
    const payload = JSON.stringify(body);
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
    return new Promise((resolve, reject) => {
      const tls = target.protocol === "https:";
      const req = (tls ? https : http).request(target, { method: "POST", headers, ...(tls && this.fingerprint ? { rejectUnauthorized: false } : {}) }, (res) => {
        if ((res.statusCode ?? 500) < 300) return resolve(res);
        let text = "";
        res.setEncoding("utf8").on("data", (d: string) => (text += d)).on("end", () => {
          const msg = ((): string => {
            try {
              return (JSON.parse(text) as { error?: string }).error ?? res.statusMessage ?? "error";
            } catch {
              return res.statusMessage ?? "error";
            }
          })();
          reject(res.statusCode === 409 ? new ConflictError(msg) : new Error(`${this.label}: ${msg}`));
        });
      });
      req.on("error", (e) => reject(e instanceof ConflictError ? e : new Error(`cannot reach ${this.label}: ${e.message}`)));
      // a server that accepts and then stalls must not hang the client; `run` may legitimately be quiet for long
      if (route !== "run") req.setTimeout(60_000, () => req.destroy(new Error("no response for 60s")));
      const send = () => req.end(payload);
      if (!tls || !this.fingerprint) return send();
      req.on("socket", (socket) => {
        const check = () => {
          const got = (socket as TLSSocket).getPeerCertificate().fingerprint256 ?? "";
          if (normalizeFingerprint(got) === this.fingerprint) send();
          else req.destroy(new Error(`certificate fingerprint mismatch (got ${got}); refusing to send the token`));
        };
        if ((socket as TLSSocket).encrypted && !(socket as TLSSocket).connecting && (socket as TLSSocket).getPeerCertificate().fingerprint256) check();
        else socket.once("secureConnect", check);
      });
    });
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    const res = await this.post(route, body);
    let text = "";
    for await (const chunk of res) text += chunk;
    return JSON.parse(text) as T;
  }

  async missing(components: string[]) {
    return (await this.call<{ missing: string[] }>("missing", { components })).missing;
  }
  async get(hashes: string[]) {
    return (await this.call<{ records: DefRecord[] }>("get", { hashes })).records;
  }
  put(records: DefRecord[]) {
    return this.call<{ stored: number }>("put", { records });
  }
  async branch(name: string) {
    return (await this.call<{ branch: BranchState | null }>("branch", { name })).branch;
  }
  async setBranch(name: string, names: NameRow[], expect: string | null, command: string) {
    await this.call("set-branch", { name, names, expect, command });
  }

  /** Output streams back as NDJSON: `{"o":"stdout","d":"..."}` lines, then `{"exit":0}`. */
  async run(hash: string, args: string[], out: Output) {
    const res = await this.post("run", { hash, args });
    let buf = "";
    let exit = 1;
    const handle = (line: string) => {
      if (!line) return;
      const msg = JSON.parse(line) as { o?: "stdout" | "stderr"; d?: string; exit?: number; error?: string };
      if (msg.o) out(msg.o, msg.d ?? "");
      if (msg.error) out("stderr", `${msg.error}\n`);
      if (msg.exit !== undefined) exit = msg.exit;
    };
    res.setEncoding("utf8");
    for await (const chunk of res) {
      buf += chunk as string;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      lines.forEach(handle);
    }
    handle(buf);
    return exit;
  }
}

// ---- remotes configuration -----------------------------------------------------------------------------

interface RemoteConfig {
  url: string;
  token?: string;
  /** pinned SHA-256 certificate fingerprint for a `ucm serve --tls` server */
  fingerprint?: string;
}

export function addRemote(cb: Codebase, name: string, url: string, token?: string, fingerprint?: string) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid remote name '${name}'`);
  const resolved = /^https?:\/\//.test(url) ? url : path.resolve(url);
  if (fingerprint && !resolved.startsWith("https://")) throw new Error("--fingerprint needs an https:// URL");
  cb.store.setSetting(`remote.${name}`, JSON.stringify({ url: resolved, token, fingerprint } satisfies RemoteConfig));
}

export function listRemotes(cb: Codebase): [string, RemoteConfig][] {
  return cb.store.settings("remote.").map(([k, v]) => [k.slice("remote.".length), JSON.parse(v) as RemoteConfig]);
}

/** A configured remote name, an http(s) URL, or a path to another codebase. */
export function openRemote(cb: Codebase, spec: string): { remote: Remote; name?: string } {
  const configured = cb.store.getSetting(`remote.${spec}`);
  if (configured) {
    const c = JSON.parse(configured) as RemoteConfig;
    return { remote: c.url.startsWith("http") ? new HttpRemote(c.url, c.token, c.fingerprint) : new DirectoryRemote(c.url), name: spec };
  }
  if (/^https?:\/\//.test(spec)) return { remote: new HttpRemote(spec, process.env.UCM_TOKEN, process.env.UCM_FINGERPRINT) };
  return { remote: new DirectoryRemote(spec) };
}

// ---- push / pull / run --on ----------------------------------------------------------------------------

/** Send whatever the remote lacks of the components needed for `hashes`. */
async function sendClosure(cb: Codebase, remote: Remote, hashes: string[]): Promise<number> {
  const comps = [...cb.closureComponents(hashes)];
  const missing = await remote.missing(comps);
  const records = missing.flatMap((c) => cb.store.componentMembers(c));
  if (records.length) await remote.put(records);
  return records.length;
}

/** Fetch the components needed for `hashes` that we lack, following dependencies until the closure is complete. */
async function fetchClosure(cb: Codebase, remote: Remote, hashes: string[]): Promise<DefRecord[]> {
  const got = new Map<string, DefRecord>();
  let want = [...new Set(hashes)].filter((h) => !cb.store.hasDef(h));
  while (want.length) {
    for (const r of await remote.get(want)) got.set(r.hash, r);
    const absent = want.filter((h) => !got.has(h));
    if (absent.length) throw new Error(`${remote.label} does not have ${absent.map((h) => shortHash(h)).join(", ")}`);
    // the sender's dependency lists only steer fetching; `receive` recomputes them
    want = [...new Set([...got.values()].flatMap((r) => r.deps.filter((d) => d.ref.startsWith("#")).map((d) => d.ref.slice(1))))].filter(
      (h) => !cb.store.hasDef(h) && !got.has(h),
    );
  }
  return [...got.values()];
}

const syncKey = (remote: string, branch: string) => `sync.${remote}.${branch}`;

export async function push(cb: Codebase, spec: string, remoteBranch: string | undefined, force: boolean) {
  const { remote, name } = openRemote(cb, spec);
  if (!name) throw new Error(`push needs a configured remote: \`ucm remote add <name> ${spec}\``);
  const branch = remoteBranch ?? cb.store.branch().name;
  const names = cb.store.names();
  const mine = cb.store.stateHash();
  const sent = await sendClosure(cb, remote, names.map((n) => n.hash));
  const theirs = await remote.branch(branch);
  const lastSynced = cb.store.getSetting(syncKey(name, branch));
  // an empty remote branch (a fresh server) has nothing a push could overwrite
  if (theirs && theirs.names.length && theirs.stateHash !== mine && theirs.stateHash !== lastSynced && !force) {
    throw new Error(`${name}/${branch} has changes you don't have: \`ucm pull ${name}\` first (or --force to overwrite them)`);
  }
  if (theirs?.stateHash !== mine) await remote.setBranch(branch, names, theirs?.stateHash ?? null, `push from ${os.hostname()}:${cb.lay.root}`);
  cb.store.setSetting(syncKey(name, branch), mine);
  cb.store.setBranchNames(`${name}/${branch}`, names, `push ${name}`);
  recordMergeBase(cb, cb.store.branch().name, `${name}/${branch}`);
  const d = theirs ? diffNamespaces(stateOf(theirs.names), stateOf(names), (h) => cb.store.getDef(h)!.ir) : undefined;
  const summary = d ? `${d.added.length} added, ${d.edited.length + d.propagated.length} changed, ${d.removed.length} removed, ${d.renamed.length} renamed` : `${names.length} names (new branch)`;
  console.log(theirs?.stateHash === mine ? dim(`${name}/${branch} is up to date`) : `${green("pushed")} ${bold(`${name}/${branch}`)}: ${summary}; sent ${sent} definition(s)`);
}

export async function pull(cb: Codebase, spec: string, remoteBranch: string | undefined) {
  const { remote, name } = openRemote(cb, spec);
  if (!name) throw new Error(`pull needs a configured remote: \`ucm remote add <name> ${spec}\``);
  const branch = remoteBranch ?? cb.store.branch().name;
  const theirs = await remote.branch(branch);
  if (!theirs) throw new Error(`${name} has no branch '${branch}'`);
  const records = await fetchClosure(cb, remote, theirs.names.map((n) => n.hash));
  const { stored } = cb.receive(records);
  const tracking = `${name}/${branch}`;
  cb.store.setBranchNames(tracking, theirs.names, `pull ${name}`);
  if (stored) console.log(dim(`received ${stored} definition(s), verified by re-hashing`));

  const local = cb.store.branch().name;
  const mine = cb.store.stateHash();
  const lastSynced = cb.store.getSetting(syncKey(name, branch));
  if (mine === theirs.stateHash) {
    cb.store.setSetting(syncKey(name, branch), mine);
    recordMergeBase(cb, local, tracking);
    return console.log(dim(`${local} is up to date with ${tracking}`));
  }
  if (cb.store.names().length && mine !== lastSynced) {
    // both sides changed since the last sync: merge the remote's state in; `push` then publishes the result
    mergeBranch(cb, tracking, `pull ${name} (merge)`);
    cb.store.setSetting(syncKey(name, branch), theirs.stateHash);
    console.log(dim(`  \`ucm push ${name}\` to publish the merge`));
    return;
  }
  const before = stateOf(cb.store.names());
  cb.store.setBranchNames(local, theirs.names, `pull ${name}`);
  cb.store.setSetting(syncKey(name, branch), theirs.stateHash);
  recordMergeBase(cb, local, tracking);
  cb.refreshShim();
  const after = stateOf(cb.store.names());
  printDiff(cb, diffNamespaces(before, after, (h) => cb.store.getDef(h)!.ir), before, after, `fast-forwarded ${local} to ${tracking}`);
}

export async function runOn(cb: Codebase, spec: string, hash: string, args: string[]): Promise<number> {
  const { remote } = openRemote(cb, spec);
  const sent = await sendClosure(cb, remote, [hash]);
  if (sent) process.stderr.write(dim(`sent ${sent} definition(s) to ${remote.label}\n`));
  return remote.run(hash, args, (s, d) => (s === "stdout" ? process.stdout : process.stderr).write(d));
}

// ---- server --------------------------------------------------------------------------------------------

export interface ServeOptions {
  host: string;
  port: number;
  token: string;
  allowRun: boolean;
  tls?: { cert: string; key: string };
}

const isLoopback = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.");

/**
 * The certificate and key for `ucm serve --tls`: given files, or a self-signed pair created once with openssl
 * and kept in `.ucm/tls/`. Clients pin it by fingerprint.
 */
export function tlsMaterial(cb: Codebase, cert?: string, key?: string): { cert: string; key: string } {
  if (cert || key) {
    if (!cert || !key) throw new Error("--tls-cert and --tls-key go together");
    return { cert: fs.readFileSync(cert, "utf8"), key: fs.readFileSync(key, "utf8") };
  }
  const dir = path.join(cb.lay.ucmDir, "tls");
  const [c, k] = [path.join(dir, "cert.pem"), path.join(dir, "key.pem")];
  if (!fs.existsSync(c) || !fs.existsSync(k)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", k, "-out", c, "-days", "825", "-subj", "/CN=ucm serve"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`could not create a certificate with openssl (${r.error?.message ?? r.stderr.trim()}); pass --tls-cert and --tls-key`);
    fs.chmodSync(k, 0o600);
  }
  return { cert: fs.readFileSync(c, "utf8"), key: fs.readFileSync(k, "utf8") };
}

/**
 * Serve this codebase to other ucm instances. Clients can store definitions, move branch names and — unless
 * `allowRun` is false — run code here, so the server requires a bearer token and listens on localhost by default.
 */
export function serve(cb: Codebase, opts: ServeOptions, insecure = false): http.Server {
  if (!isLoopback(opts.host) && !opts.tls && !insecure) {
    throw new Error(`serving on ${opts.host} without TLS would send the token in clear text: add --tls (or --insecure on a network you trust)`);
  }
  const peer = new Peer(cb, opts.allowRun);
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorized = (req: http.IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const LIMIT = 64 * 1024 * 1024;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req)) return reply(401, { error: "missing or wrong token" });
    if (req.method !== "POST") return reply(405, { error: "use POST" });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > LIMIT) return reply(413, { error: "request too large" });
      chunks.push(c as Buffer);
    }
    let body: Record<string, any>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return reply(400, { error: "invalid JSON" });
    }
    const route = req.url?.replace(/^\//, "");
    try {
      switch (route) {
        case "missing":
          return reply(200, { missing: peer.missing(body.components ?? []) });
        case "get":
          return reply(200, { records: peer.get(body.hashes ?? []) });
        case "put": {
          const r = peer.put(body.records ?? []);
          console.log(dim(`received ${r.stored} definition(s)`));
          return reply(200, r);
        }
        case "branch":
          return reply(200, { branch: peer.branch(String(body.name)) });
        case "set-branch":
          peer.setBranch(String(body.name), body.names ?? [], body.expect ?? null, String(body.command ?? "remote"));
          console.log(`${green("updated")} branch ${bold(String(body.name))} ${dim(`(${body.command})`)}`);
          return reply(200, { ok: true });
        case "run": {
          const hash = String(body.hash);
          const args = Array.isArray(body.args) ? body.args.map(String) : [];
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          const send = (msg: unknown) => res.write(JSON.stringify(msg) + "\n");
          console.log(dim(`running ${shortHash(hash)} ${args.join(" ")}`));
          try {
            send({ exit: await peer.run(hash, args, (o, d) => send({ o, d })) });
          } catch (e) {
            send({ error: (e as Error).message, exit: 1 });
          }
          return res.end();
        }
        default:
          return reply(404, { error: `unknown route '${route}'` });
      }
    } catch (e) {
      if (!res.headersSent) reply(e instanceof ConflictError ? 409 : 400, { error: (e as Error).message });
    }
  };
  const server = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : http.createServer(handler);
  const fingerprint = opts.tls && new X509Certificate(opts.tls.cert).fingerprint256;
  const scheme = opts.tls ? "https" : "http";
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address() as { port: number };
    console.log(`${bold("ucm serve")} ${cb.lay.root}`);
    console.log(`  url    ${scheme}://${opts.host}:${port}`);
    if (fingerprint) console.log(`  cert   sha256 ${fingerprint}`);
    console.log(`  token  ${opts.token}`);
    console.log(`  run    ${opts.allowRun ? yellow("enabled: clients with the token can execute code here") : "disabled"}`);
    if (!isLoopback(opts.host)) console.log(opts.tls ? yellow("  listening beyond localhost") : red("  warning: listening beyond localhost without TLS"));
    const pin = fingerprint ? ` --fingerprint ${fingerprint}` : "";
    console.log(dim(`\n  on another machine: ucm remote add <name> ${scheme}://<this-host>:${port} --token ${opts.token}${pin}`));
  });
  return server;
}

export function newToken(): string {
  return randomBytes(18).toString("base64url");
}
