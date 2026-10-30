import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { shortHash, type DefRecord } from "@tcm/core";
import type { Causal, Contribution, NameRow, Release } from "@tcm/store";
import { runStreaming } from "@tcm/loader";
import { Codebase, IDENT_PATH, type LockEntry } from "./codebase.ts";
import { diffNamespaces, printDiff, stateOf } from "./diff.ts";
import { mergeBranch } from "./merge.ts";
import { closeContribution, commentOn, mergeContribution, openContribution, reviewPage, viewContribution, type ContributionView } from "./contributions.ts";
import { bold, dim, green, red, yellow } from "./style.ts";


export type Output = (stream: "stdout" | "stderr", data: string) => void;

export interface BranchState {
  /** the branch's head causal */
  head: string;
  names: NameRow[];
}

export type NamespaceNode = { hash: string; body: string };
export type NewContribution = { title: string; description: string; source: string; target: string; author: string };

/** What one codebase can ask of another. */
export interface Remote {
  readonly label: string;
  /** which of these component hashes are absent */
  missing(components: string[]): Promise<string[]>;
  /** full components containing these definition hashes */
  get(hashes: string[]): Promise<DefRecord[]>;
  put(records: DefRecord[]): Promise<{ stored: number }>;
  /** its package lock: the versions (and tarball hashes) its code runs on */
  packages(): Promise<LockEntry[]>;
  /** lock entries for code about to be sent (before `put`, so it's verified on those versions) */
  putPackages(entries: LockEntry[]): Promise<void>;
  branch(name: string): Promise<BranchState | null>;
  /** move a branch to a causal it has, only if its head is still `expect` (null: the branch must not exist) */
  setBranch(name: string, head: string, expect: string | null, command: string): Promise<void>;
  /** every causal in a causal's history */
  ancestors(head: string): Promise<string[]>;
  missingCausals(hashes: string[]): Promise<string[]>;
  getCausals(hashes: string[]): Promise<Causal[]>;
  /** causals, parents before children, whose namespaces (and definitions) were sent first */
  putCausals(causals: Causal[]): Promise<void>;
  missingNamespaces(hashes: string[]): Promise<string[]>;
  getNamespaces(hashes: string[]): Promise<NamespaceNode[]>;
  putNamespaces(nodes: NamespaceNode[]): Promise<void>;
  releases(): Promise<Release[]>;
  /** releases whose history was sent first */
  putReleases(releases: Release[]): Promise<void>;
  /** contributions: branches proposed for merging, reviewed and merged there */
  contributions(all: boolean): Promise<Contribution[]>;
  contribution(id: number): Promise<ContributionView>;
  openContribution(c: NewContribution): Promise<{ id: number; created: boolean }>;
  comment(id: number, c: { author: string; body: string; about?: string | null }): Promise<void>;
  mergeContribution(id: number, author: string): Promise<{ mergedAs: string; todo: number }>;
  closeContribution(id: number, author: string, reopen?: boolean): Promise<void>;
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

  packages(): LockEntry[] {
    return this.cb.store.lockedPackages();
  }

  putPackages(entries: LockEntry[]) {
    this.cb.adoptPackages(entries);
  }

  branch(name: string): BranchState | null {
    if (!this.cb.store.hasBranch(name)) return null;
    return { head: this.cb.store.head(name), names: this.cb.store.names(name, true) };
  }

  setBranch(name: string, head: string, expect: string | null, command: string) {
    const current = this.cb.store.hasBranch(name) ? this.cb.store.head(name) : null;
    if (current !== expect) throw new ConflictError(`branch '${name}' changed since you last synced`);
    const c = this.cb.store.causal(head);
    if (!c) throw new Error(`history entry ${shortHash(head)} was not sent`);
    validNames(this.cb, this.cb.store.namespaceRows(c.namespace));
    this.cb.store.setHead(name, head, command);
    this.cb.refreshShim();
  }

  ancestors(head: string): string[] {
    return this.cb.store.ancestors(head);
  }
  missingCausals(hashes: string[]): string[] {
    return this.cb.store.missingCausals(hashes);
  }
  getCausals(hashes: string[]): Causal[] {
    return this.cb.store.getCausals(hashes);
  }
  putCausals(causals: Causal[]) {
    this.cb.store.putCausals(causals);
  }
  missingNamespaces(hashes: string[]): string[] {
    return this.cb.store.missingNamespaces(hashes);
  }
  getNamespaces(hashes: string[]): NamespaceNode[] {
    return this.cb.store.getNamespaces(hashes);
  }
  putNamespaces(nodes: NamespaceNode[]) {
    this.cb.store.putNamespaces(nodes);
  }
  releases(): Release[] {
    return this.cb.store.releases();
  }
  putReleases(releases: Release[]) {
    this.cb.store.transaction(() =>
      releases.forEach((r) =>
        this.cb.store.putRelease({ package: String(r.package), version: String(r.version), namespace: String(r.namespace), causal: String(r.causal), notes: String(r.notes), author: String(r.author), ts: Number(r.ts) }),
      ),
    );
  }
  contributions(all: boolean): Contribution[] {
    return this.cb.store.contributions(all ? undefined : "open");
  }
  contribution(id: number): ContributionView {
    return viewContribution(this.cb, id);
  }
  openContribution(c: NewContribution) {
    return openContribution(this.cb, c);
  }
  comment(id: number, c: { author: string; body: string; about?: string | null }) {
    commentOn(this.cb, id, c);
  }
  mergeContribution(id: number, author: string) {
    return mergeContribution(this.cb, id, author);
  }
  closeContribution(id: number, author: string, reopen = false) {
    closeContribution(this.cb, id, author, reopen);
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
  async packages() {
    return this.peer.packages();
  }
  async putPackages(e: LockEntry[]) {
    this.peer.putPackages(e);
  }
  async branch(n: string) {
    return this.peer.branch(n);
  }
  async setBranch(n: string, head: string, expect: string | null, command: string) {
    this.peer.setBranch(n, head, expect, command);
  }
  async ancestors(h: string) {
    return this.peer.ancestors(h);
  }
  async missingCausals(h: string[]) {
    return this.peer.missingCausals(h);
  }
  async getCausals(h: string[]) {
    return this.peer.getCausals(h);
  }
  async putCausals(c: Causal[]) {
    this.peer.putCausals(c);
  }
  async missingNamespaces(h: string[]) {
    return this.peer.missingNamespaces(h);
  }
  async getNamespaces(h: string[]) {
    return this.peer.getNamespaces(h);
  }
  async putNamespaces(n: NamespaceNode[]) {
    this.peer.putNamespaces(n);
  }
  async releases() {
    return this.peer.releases();
  }
  async putReleases(r: Release[]) {
    this.peer.putReleases(r);
  }
  async contributions(all: boolean) {
    return this.peer.contributions(all);
  }
  async contribution(id: number) {
    return this.peer.contribution(id);
  }
  async openContribution(c: NewContribution) {
    return this.peer.openContribution(c);
  }
  async comment(id: number, c: { author: string; body: string; about?: string | null }) {
    this.peer.comment(id, c);
  }
  async mergeContribution(id: number, author: string) {
    return this.peer.mergeContribution(id, author);
  }
  async closeContribution(id: number, author: string, reopen = false) {
    this.peer.closeContribution(id, author, reopen);
  }
  run(h: string, args: string[], out: Output) {
    return this.peer.run(h, args, out);
  }
}

/** A `tcm serve` server. */
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
  private post(route: string, body: unknown, retried = false): Promise<http.IncomingMessage> {
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
      req.on("error", (e: NodeJS.ErrnoException) => {
        // a kept-alive connection the server closed while this side was busy (verifying what it received):
        // the request never reached it, so it's sent again, once, on a new one
        if (req.reusedSocket && e.code === "ECONNRESET" && !retried) return void this.post(route, body, true).then(resolve, reject);
        reject(e instanceof ConflictError ? e : new Error(`cannot reach ${this.label}: ${e.message}`));
      });
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
  async packages() {
    return (await this.call<{ packages: LockEntry[] }>("packages", {})).packages;
  }
  async putPackages(entries: LockEntry[]) {
    await this.call("put-packages", { packages: entries });
  }
  async branch(name: string) {
    return (await this.call<{ branch: BranchState | null }>("branch", { name })).branch;
  }
  async setBranch(name: string, head: string, expect: string | null, command: string) {
    await this.call("set-branch", { name, head, expect, command });
  }
  async ancestors(head: string) {
    return (await this.call<{ causals: string[] }>("ancestors", { head })).causals;
  }
  async missingCausals(hashes: string[]) {
    return (await this.call<{ missing: string[] }>("missing-causals", { hashes })).missing;
  }
  async getCausals(hashes: string[]) {
    return (await this.call<{ causals: Causal[] }>("get-causals", { hashes })).causals;
  }
  async putCausals(causals: Causal[]) {
    await this.call("put-causals", { causals });
  }
  async missingNamespaces(hashes: string[]) {
    return (await this.call<{ missing: string[] }>("missing-namespaces", { hashes })).missing;
  }
  async getNamespaces(hashes: string[]) {
    return (await this.call<{ nodes: NamespaceNode[] }>("get-namespaces", { hashes })).nodes;
  }
  async putNamespaces(nodes: NamespaceNode[]) {
    await this.call("put-namespaces", { nodes });
  }
  async releases() {
    return (await this.call<{ releases: Release[] }>("releases", {})).releases;
  }
  async putReleases(releases: Release[]) {
    await this.call("put-releases", { releases });
  }
  async contributions(all: boolean) {
    return (await this.call<{ contributions: Contribution[] }>("contributions", { all })).contributions;
  }
  contribution(id: number) {
    return this.call<ContributionView>("contribution", { id });
  }
  openContribution(c: NewContribution) {
    return this.call<{ id: number; created: boolean }>("open-contribution", c);
  }
  async comment(id: number, c: { author: string; body: string; about?: string | null }) {
    await this.call("comment", { id, ...c });
  }
  mergeContribution(id: number, author: string) {
    return this.call<{ mergedAs: string; todo: number }>("merge-contribution", { id, author });
  }
  async closeContribution(id: number, author: string, reopen = false) {
    await this.call(reopen ? "reopen-contribution" : "close-contribution", { id, author });
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
  /** pinned SHA-256 certificate fingerprint for a `tcm serve --tls` server */
  fingerprint?: string;
}

export function addRemote(cb: Codebase, name: string, url: string, token?: string, fingerprint?: string) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid remote name '${name}'`);
  const resolved = /^https?:\/\//.test(url) ? url : path.resolve(url);
  if (fingerprint && !resolved.startsWith("https://")) throw new Error("--fingerprint needs an https:// URL");
  cb.store.setSetting(`remote.${name}`, JSON.stringify({ url: resolved, token, fingerprint } satisfies RemoteConfig));
}

/** The review page for a contribution on an HTTP remote (with the token in its fragment), if it is one. */
export function reviewUrl(cb: Codebase, remote: string, id?: number): string | undefined {
  const configured = cb.store.getSetting(`remote.${remote}`);
  if (!configured) return undefined;
  const c = JSON.parse(configured) as RemoteConfig;
  if (!c.url.startsWith("http")) return undefined;
  return `${c.url.replace(/\/$/, "")}/contributions${id === undefined ? "" : `/${id}`}${c.token ? `#token=${encodeURIComponent(c.token)}` : ""}`;
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
  if (/^https?:\/\//.test(spec)) return { remote: new HttpRemote(spec, process.env.TCM_TOKEN, process.env.TCM_FINGERPRINT) };
  return { remote: new DirectoryRemote(spec) };
}

// ---- push / pull / run --on ----------------------------------------------------------------------------

/** Send whatever the remote lacks of the components needed for `hashes`. */
async function sendClosure(cb: Codebase, remote: Remote, hashes: string[]): Promise<number> {
  const comps = [...cb.closureComponents(hashes)];
  const missing = await remote.missing(comps);
  const records = missing.flatMap((c) => cb.store.componentMembers(c));
  if (records.length) {
    // the versions the code runs on go first: the other side verifies it on them
    await remote.putPackages(cb.packagesUsedBy(records));
    await remote.put(records);
  }
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

/** `xs` in slices of `n`, so no request grows without bound. */
const chunks = <T>(xs: T[], n = 500): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Causals, parents before children. */
function oldestFirst(causals: Causal[]): Causal[] {
  const by = new Map(causals.map((c) => [c.hash, c]));
  const out: Causal[] = [];
  const done = new Set<string>();
  const visit = (c: Causal) => {
    if (done.has(c.hash)) return;
    done.add(c.hash);
    for (const p of c.parents) if (by.has(p)) visit(by.get(p)!);
    out.push(c);
  };
  causals.forEach(visit);
  return out;
}

/**
 * Send what the remote lacks of the history up to `head`: its causals, the namespace nodes they point at (a
 * node the remote has, it has everything under), and every definition those name. Returns definitions sent.
 */
async function sendHistory(cb: Codebase, remote: Remote, head: string): Promise<number> {
  const lacking: string[] = [];
  for (const c of chunks(cb.store.ancestors(head))) lacking.push(...(await remote.missingCausals(c)));
  if (!lacking.length) return 0;
  const causals = oldestFirst(cb.store.getCausals(lacking));
  const nodes: string[] = [];
  const named = new Set<string>();
  const seen = new Set<string>();
  for (let level = [...new Set(causals.map((c) => c.namespace))]; level.length; ) {
    level = level.filter((h) => !seen.has(h) && (seen.add(h), true));
    const missing: string[] = [];
    for (const c of chunks(level)) missing.push(...(await remote.missingNamespaces(c)));
    nodes.push(...missing);
    for (const n of missing) for (const d of cb.store.namespaceDefinitions(n)) named.add(d);
    level = missing.flatMap((n) => cb.store.namespaceChildren(n));
  }
  const sent = await sendClosure(cb, remote, [...named]);
  // children before the nodes that point at them
  for (const c of chunks(nodes.reverse())) await remote.putNamespaces(cb.store.getNamespaces(c));
  for (const c of chunks(causals)) await remote.putCausals(c);
  return sent;
}

/** Fetch what this codebase lacks of the remote's history up to `head`; returns definitions received. */
async function fetchHistory(cb: Codebase, remote: Remote, head: string): Promise<number> {
  const lacking = cb.store.missingCausals(await remote.ancestors(head));
  if (!lacking.length) return 0;
  const causals: Causal[] = [];
  for (const c of chunks(lacking)) causals.push(...(await remote.getCausals(c)));
  const nodes: NamespaceNode[] = [];
  const named = new Set<string>();
  for (let level = [...new Set(causals.map((c) => c.namespace))]; level.length; ) {
    const missing = cb.store.missingNamespaces(level).filter((h) => !nodes.some((n) => n.hash === h));
    const got: NamespaceNode[] = [];
    for (const c of chunks(missing)) got.push(...(await remote.getNamespaces(c)));
    if (got.length !== missing.length) throw new Error(`${remote.label} is missing part of its history`);
    nodes.push(...got);
    const bodies = got.map((n) => JSON.parse(n.body) as ["ns", [string, string[]][], [string, string][]]);
    for (const b of bodies) for (const [, hs] of b[1]) for (const d of hs) named.add(d);
    level = [...new Set(bodies.flatMap((b) => b[2].map(([, child]) => child)))];
  }
  const records = await fetchClosure(cb, remote, [...named]);
  // the versions their code runs on, then the code (verified on them), then the history naming it
  if (records.length) cb.adoptPackages(cb.packagesUsedBy(records, await remote.packages()));
  const { stored } = cb.receive(records);
  cb.store.putNamespaces(nodes);
  cb.store.putCausals(oldestFirst(causals));
  return stored;
}

const releaseKey = (r: Release) => `${r.package}@${r.version}`;
const differ = (remote: Remote, theirs: Release, mine: Release) =>
  new Error(`${remote.label} has a different ${releaseKey(mine)} (${shortHash(theirs.causal)}, here ${shortHash(mine.causal)}): a version names one release, for good`);

/** Send the releases the remote lacks, with their history. A release both have must be the same. */
async function sendReleases(cb: Codebase, remote: Remote): Promise<string[]> {
  const theirs = new Map((await remote.releases()).map((r) => [releaseKey(r), r]));
  const missing: Release[] = [];
  for (const r of cb.store.releases()) {
    const t = theirs.get(releaseKey(r));
    if (t && (t.causal !== r.causal || t.notes !== r.notes)) throw differ(remote, t, r);
    if (!t) missing.push(r);
  }
  for (const r of missing) await sendHistory(cb, remote, r.causal);
  if (missing.length) await remote.putReleases(missing);
  return missing.map(releaseKey).reverse();
}

/** Fetch the releases this codebase lacks, with their history. */
async function fetchReleases(cb: Codebase, remote: Remote): Promise<string[]> {
  const got: string[] = [];
  for (const r of (await remote.releases()).reverse()) {
    const mine = cb.store.release(r.package, r.version);
    if (mine && (mine.causal !== r.causal || mine.notes !== r.notes)) throw differ(remote, r, mine);
    if (mine) continue;
    await fetchHistory(cb, remote, r.causal);
    cb.store.putRelease(r);
    got.push(releaseKey(r));
  }
  return got;
}

export async function push(cb: Codebase, spec: string, remoteBranch: string | undefined, force: boolean) {
  const { remote, name } = openRemote(cb, spec);
  if (!name) throw new Error(`push needs a configured remote: \`tcm remote add <name> ${spec}\``);
  const branch = remoteBranch ?? cb.store.branch().name;
  const names = cb.store.names(undefined, true);
  const mine = cb.store.head();
  const theirs = await remote.branch(branch);
  // a push only moves the remote forward: its head must be in this branch's history (an empty branch, on a
  // fresh server, has nothing a push could lose)
  if (theirs && theirs.head !== mine && theirs.names.length && !cb.store.isAncestor(theirs.head, mine) && !force) {
    throw new Error(`${name}/${branch} has changes you don't have: \`tcm pull ${name}\` first (or --force to overwrite them)`);
  }
  const sent = await sendHistory(cb, remote, mine);
  if (theirs?.head !== mine) await remote.setBranch(branch, mine, theirs?.head ?? null, `push from ${os.hostname()}:${cb.lay.root}`);
  cb.store.setHead(`${name}/${branch}`, mine, `push ${name}`);
  const released = await sendReleases(cb, remote);
  if (released.length) console.log(`${green("released")} ${released.join(", ")} ${dim(`on ${name}`)}`);
  const d = theirs ? diffNamespaces(stateOf(theirs.names), stateOf(names), (h) => cb.store.getDef(h)!.ir) : undefined;
  const summary = d ? `${d.added.length} added, ${d.edited.length + d.propagated.length} changed, ${d.removed.length} removed, ${d.renamed.length} renamed` : `${names.length} names (new branch)`;
  console.log(theirs?.head === mine ? dim(`${name}/${branch} is up to date`) : `${green("pushed")} ${bold(`${name}/${branch}`)}: ${summary}; sent ${sent} definition(s)`);
}

export async function pull(cb: Codebase, spec: string, remoteBranch: string | undefined) {
  const { remote, name } = openRemote(cb, spec);
  if (!name) throw new Error(`pull needs a configured remote: \`tcm remote add <name> ${spec}\``);
  const branch = remoteBranch ?? cb.store.branch().name;
  const theirs = await remote.branch(branch);
  if (!theirs) throw new Error(`${name} has no branch '${branch}'`);
  const stored = await fetchHistory(cb, remote, theirs.head);
  const tracking = `${name}/${branch}`;
  cb.store.setHead(tracking, theirs.head, `pull ${name}`);
  if (stored) console.log(dim(`received ${stored} definition(s), verified by re-hashing`));
  const released = await fetchReleases(cb, remote);
  if (released.length) console.log(dim(`received release(s) ${released.join(", ")}`));

  const local = cb.store.branch().name;
  const mine = cb.store.head();
  if (cb.store.isAncestor(theirs.head, mine)) {
    return console.log(dim(mine === theirs.head ? `${local} is up to date with ${tracking}` : `${local} already has everything in ${tracking}; \`tcm push ${name}\` publishes what's new here`));
  }
  if (!cb.store.isAncestor(mine, theirs.head)) {
    // both sides changed since they last shared history: merge theirs in; `push` then publishes the result
    mergeBranch(cb, tracking, `pull ${name} (merge)`);
    console.log(dim(`  \`tcm push ${name}\` to publish the merge`));
    return;
  }
  const before = stateOf(cb.store.names(undefined, true));
  cb.store.setHead(local, theirs.head, `pull ${name}`);
  cb.refreshShim();
  const after = stateOf(cb.store.names(undefined, true));
  printDiff(cb, diffNamespaces(before, after, (h) => cb.store.getDef(h)!.ir), before, after, `fast-forwarded ${local} to ${tracking}`);
}

/** Push this branch to a remote and open (or update) a contribution of it into `to` there. */
export async function contribute(cb: Codebase, spec: string, o: { to: string; as?: string; title?: string; description?: string; author: string }): Promise<{ id: number; created: boolean }> {
  const source = o.as ?? cb.store.branch().name;
  if (source === o.to) throw new Error(`this is ${o.to}: make a branch for the change (\`tcm branch <name>\`, \`tcm switch <name>\`), or push it under another name with --as <name>`);
  await push(cb, spec, source, false);
  const { remote } = openRemote(cb, spec);
  return remote.openContribution({ title: o.title ?? source, description: o.description ?? "", source, target: o.to, author: o.author });
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
  /** a directory GET requests are answered from (a docs site), beside the codebase's routes */
  site?: string;
  /** whether to print the token (one made up for this run; not one the caller gave) */
  showToken?: boolean;
}

const SITE_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Answer a GET from a static site's directory: `/` and directories by their index.html, `/a` by a.html too. */
function serveSite(root: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const base = path.resolve(root);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://site").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(base, `.${pathname}`);
  // (nothing outside it)
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
  if (!fs.existsSync(file)) {
    const missing = path.join(base, "404.html");
    res.writeHead(404, { "content-type": SITE_TYPES[".html"]! });
    res.end(fs.existsSync(missing) ? fs.readFileSync(missing) : "not found");
    return;
  }
  res.writeHead(200, { "content-type": SITE_TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
}

const isLoopback = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.");

/**
 * The certificate and key for `tcm serve --tls`: given files, or a self-signed pair created once with openssl
 * and kept in `.tcm/tls/`. Clients pin it by fingerprint.
 */
export function tlsMaterial(cb: Codebase, cert?: string, key?: string): { cert: string; key: string } {
  if (cert || key) {
    if (!cert || !key) throw new Error("--tls-cert and --tls-key go together");
    return { cert: fs.readFileSync(cert, "utf8"), key: fs.readFileSync(key, "utf8") };
  }
  const dir = path.join(cb.lay.tcmDir, "tls");
  const [c, k] = [path.join(dir, "cert.pem"), path.join(dir, "key.pem")];
  if (!fs.existsSync(c) || !fs.existsSync(k)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", k, "-out", c, "-days", "825", "-subj", "/CN=tcm serve"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`could not create a certificate with openssl (${r.error?.message ?? r.stderr.trim()}); pass --tls-cert and --tls-key`);
    fs.chmodSync(k, 0o600);
  }
  return { cert: fs.readFileSync(c, "utf8"), key: fs.readFileSync(k, "utf8") };
}

/**
 * Serve this codebase to other tcm instances. Clients can store definitions, move branch names and — unless
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
    // the review page holds no data (it calls the routes below with the token from its URL's fragment)
    if (req.method === "GET" && /^\/contributions(\/\d+)?\/?$/.test(req.url?.split("?")[0] ?? "")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      return res.end(reviewPage());
    }
    // the site, to anyone: it's what the server publishes (docs), not the codebase
    if (opts.site && (req.method === "GET" || req.method === "HEAD")) return serveSite(opts.site, req, res);
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
        case "packages":
          return reply(200, { packages: peer.packages() });
        case "put-packages":
          peer.putPackages(body.packages ?? []);
          return reply(200, {});
        case "branch":
          return reply(200, { branch: peer.branch(String(body.name)) });
        case "set-branch":
          peer.setBranch(String(body.name), String(body.head), body.expect ?? null, String(body.command ?? "remote"));
          console.log(`${green("updated")} branch ${bold(String(body.name))} ${dim(`(${body.command})`)}`);
          return reply(200, { ok: true });
        case "ancestors":
          return reply(200, { causals: peer.ancestors(String(body.head)) });
        case "missing-causals":
          return reply(200, { missing: peer.missingCausals(body.hashes ?? []) });
        case "get-causals":
          return reply(200, { causals: peer.getCausals(body.hashes ?? []) });
        case "put-causals":
          peer.putCausals(body.causals ?? []);
          return reply(200, {});
        case "missing-namespaces":
          return reply(200, { missing: peer.missingNamespaces(body.hashes ?? []) });
        case "get-namespaces":
          return reply(200, { nodes: peer.getNamespaces(body.hashes ?? []) });
        case "put-namespaces":
          peer.putNamespaces(body.nodes ?? []);
          return reply(200, {});
        case "releases":
          return reply(200, { releases: peer.releases() });
        case "put-releases":
          peer.putReleases(body.releases ?? []);
          for (const r of body.releases ?? []) console.log(`${green("released")} ${bold(`${r.package}@${r.version}`)}`);
          return reply(200, {});
        case "contributions":
          return reply(200, { contributions: peer.contributions(!!body.all) });
        case "contribution":
          return reply(200, peer.contribution(Number(body.id)));
        case "open-contribution": {
          const r = peer.openContribution({ title: String(body.title ?? ""), description: String(body.description ?? ""), source: String(body.source), target: String(body.target), author: String(body.author ?? "") });
          console.log(`${green(r.created ? "opened" : "updated")} contribution #${r.id} ${dim(`(${body.source} → ${body.target})`)}`);
          return reply(200, r);
        }
        case "comment":
          peer.comment(Number(body.id), { author: String(body.author ?? ""), body: String(body.body ?? ""), about: body.about ? String(body.about) : null });
          return reply(200, {});
        case "merge-contribution": {
          const r = peer.mergeContribution(Number(body.id), String(body.author ?? ""));
          console.log(`${green("merged")} contribution #${body.id} ${dim(`as ${shortHash(r.mergedAs)}`)}`);
          return reply(200, r);
        }
        case "close-contribution":
        case "reopen-contribution":
          peer.closeContribution(Number(body.id), String(body.author ?? ""), route === "reopen-contribution");
          return reply(200, {});
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
  // idle connections stay open longer than a client takes between requests (re-hashing what it received), and
  // than a proxy in front of it expects (Railway's, say)
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const fingerprint = opts.tls && new X509Certificate(opts.tls.cert).fingerprint256;
  const scheme = opts.tls ? "https" : "http";
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address() as { port: number };
    console.log(`${bold("tcm serve")} ${cb.lay.root}`);
    console.log(`  url    ${scheme}://${opts.host}:${port}`);
    if (fingerprint) console.log(`  cert   sha256 ${fingerprint}`);
    console.log(`  token  ${opts.showToken === false ? dim("(as given)") : opts.token}`);
    if (opts.site) console.log(`  site   ${opts.site}`);
    console.log(`  run    ${opts.allowRun ? yellow("enabled: clients with the token can execute code here") : "disabled"}`);
    if (!isLoopback(opts.host)) console.log(opts.tls ? yellow("  listening beyond localhost") : red("  warning: listening beyond localhost without TLS"));
    const pin = fingerprint ? ` --fingerprint ${fingerprint}` : "";
    console.log(dim(`\n  on another machine: tcm remote add <name> ${scheme}://<this-host>:${port} --token ${opts.showToken === false ? "<token>" : opts.token}${pin}`));
  });
  return server;
}

export function newToken(): string {
  return randomBytes(18).toString("base64url");
}
