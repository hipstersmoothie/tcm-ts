import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { shortHash, type DefRecord } from "@ucm/core";
import type { NameRow } from "@ucm/store";
import { runStreaming } from "@ucm/loader";
import { Codebase, IDENT_PATH } from "./codebase.ts";
import { diffNamespaces, printDiff, stateOf } from "./diff.ts";
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
class HttpRemote implements Remote {
  readonly label: string;
  private url: string;
  private token: string | undefined;

  constructor(url: string, token?: string) {
    this.label = url;
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async post(route: string, body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`cannot reach ${this.url}: ${(e as Error).cause ?? (e as Error).message}`);
    }
    if (res.ok) return res;
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
    if (res.status === 409) throw new ConflictError(msg);
    throw new Error(`${this.url}: ${msg}`);
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    return (await (await this.post(route, body)).json()) as T;
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
    const decoder = new TextDecoder();
    let buf = "";
    let exit = 1;
    const handle = (line: string) => {
      if (!line) return;
      const msg = JSON.parse(line) as { o?: "stdout" | "stderr"; d?: string; exit?: number; error?: string };
      if (msg.o) out(msg.o, msg.d ?? "");
      if (msg.error) out("stderr", `${msg.error}\n`);
      if (msg.exit !== undefined) exit = msg.exit;
    };
    for await (const chunk of res.body!) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
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
}

export function addRemote(cb: Codebase, name: string, url: string, token?: string) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid remote name '${name}'`);
  const resolved = /^https?:\/\//.test(url) ? url : path.resolve(url);
  cb.store.setSetting(`remote.${name}`, JSON.stringify({ url: resolved, token } satisfies RemoteConfig));
}

export function listRemotes(cb: Codebase): [string, RemoteConfig][] {
  return cb.store.settings("remote.").map(([k, v]) => [k.slice("remote.".length), JSON.parse(v) as RemoteConfig]);
}

/** A configured remote name, an http(s) URL, or a path to another codebase. */
export function openRemote(cb: Codebase, spec: string): { remote: Remote; name?: string } {
  const configured = cb.store.getSetting(`remote.${spec}`);
  if (configured) {
    const c = JSON.parse(configured) as RemoteConfig;
    return { remote: c.url.startsWith("http") ? new HttpRemote(c.url, c.token) : new DirectoryRemote(c.url), name: spec };
  }
  if (/^https?:\/\//.test(spec)) return { remote: new HttpRemote(spec, process.env.UCM_TOKEN) };
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
  if (theirs && theirs.stateHash !== mine && theirs.stateHash !== lastSynced && !force) {
    throw new Error(`${name}/${branch} has changes you don't have: \`ucm pull ${name}\` first (or --force to overwrite them)`);
  }
  if (theirs?.stateHash !== mine) await remote.setBranch(branch, names, theirs?.stateHash ?? null, `push from ${os.hostname()}:${cb.lay.root}`);
  cb.store.setSetting(syncKey(name, branch), mine);
  cb.store.setBranchNames(`${name}/${branch}`, names, `push ${name}`);
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
    return console.log(dim(`${local} is up to date with ${tracking}`));
  }
  if (cb.store.names().length && mine !== lastSynced) {
    console.log(`${yellow("not fast-forwarded:")} ${bold(local)} has changes since it last synced with ${tracking}.`);
    console.log(dim(`  review with \`ucm diff ${local} ${tracking}\` (merging is not supported yet)`));
    return;
  }
  const before = stateOf(cb.store.names());
  cb.store.setBranchNames(local, theirs.names, `pull ${name}`);
  cb.store.setSetting(syncKey(name, branch), theirs.stateHash);
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
}

/**
 * Serve this codebase to other ucm instances. Clients can store definitions, move branch names and — unless
 * `allowRun` is false — run code here, so the server requires a bearer token and listens on localhost by default.
 */
export function serve(cb: Codebase, opts: ServeOptions): http.Server {
  const peer = new Peer(cb, opts.allowRun);
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorized = (req: http.IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const LIMIT = 64 * 1024 * 1024;

  const server = http.createServer(async (req, res) => {
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
  });
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address() as { port: number };
    console.log(`${bold("ucm serve")} ${cb.lay.root}`);
    console.log(`  url    http://${opts.host}:${port}`);
    console.log(`  token  ${opts.token}`);
    console.log(`  run    ${opts.allowRun ? yellow("enabled: clients with the token can execute code here") : "disabled"}`);
    if (opts.host !== "127.0.0.1" && opts.host !== "localhost") console.log(red("  warning: listening beyond localhost"));
    console.log(dim(`\n  on another machine: ucm remote add <name> http://<this-host>:${port} --token ${opts.token}`));
  });
  return server;
}

export function newToken(): string {
  return randomBytes(18).toString("base64url");
}
