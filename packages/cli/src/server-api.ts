// `#tcm/server`: what a server function can know about the call it's serving.
//
//   import { request, session, setSession, HttpError } from "#tcm/server";
//
//   export async function me(): Promise<string> {
//     const user = session().user;
//     if (typeof user !== "string") throw new HttpError(401, "sign in first");
//     return user;
//   }
//
// Using anything from here makes a definition need the server (placement is inferred, not annotated). Each call
// runs inside its HTTP request's context (AsyncLocalStorage), so these work at any depth of the call.
//
// The API is written as one factory whose own source text becomes `.tcm/cache/tcm-server.js` (with types in
// `tcm-server.d.ts`): server functions, test runners and the RPC host all import that file, so they share one
// instance per process wherever tcm itself runs from (its source, a built package, or a codebase's cache).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { codecSource, decode, encode } from "./codec.ts";
import { checkValue, schemaCheckerSource } from "@tcm/core";

export function createServerApi(deps: {
  AsyncLocalStorage: typeof AsyncLocalStorage;
  randomBytes: typeof randomBytes;
  DatabaseSync: typeof DatabaseSync;
  encode: typeof encode;
  decode: typeof decode;
  checkValue: typeof checkValue;
}) {
  /** A random id people may type: base64url, never starting with `-` (a command line would read it as a flag). */
  const typedId = (bytes: number): string => {
    let id: string;
    do id = deps.randomBytes(bytes).toString("base64url");
    while (id.startsWith("-"));
    return id;
  };
  interface ServerRequest {
    method: string;
    url: string;
    headers: Headers;
    cookies: Record<string, string>;
    ip: string | undefined;
    signal: AbortSignal;
  }
  interface CookieOptions {
    maxAge?: number;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }
  interface CallContext {
    /** absent in a background job */
    request?: ServerRequest;
    setCookies: string[];
    secure: boolean;
    /** where app data (sessions) lives; in memory when absent (tests) */
    dataDir?: string;
  }
  const storage = new deps.AsyncLocalStorage<CallContext>();
  const SESSION_COOKIE = "tcm_sid";

  const context = (what: string): CallContext => {
    const c = storage.getStore();
    if (!c) throw new Error(`${what} only works inside a server function called from the browser (tcm dev / tcm start)`);
    return c;
  };

  /** A failure meant for the caller: its status and message reach the browser (other errors are hidden in production). */
  class HttpError extends Error {
    readonly status: number;
    /** seconds, sent as Retry-After (429s from rateLimit set it) */
    readonly retryAfter?: number;
    constructor(status: number, message: string, opts: { retryAfter?: number } = {}) {
      super(message);
      this.name = "HttpError";
      this.status = status;
      if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
    }
  }

  const inRequest = (what: string): CallContext & { request: ServerRequest } => {
    const c = context(what);
    if (!c.request) throw new Error(`${what} needs a request, and background jobs don't have one`);
    return c as CallContext & { request: ServerRequest };
  };
  const request = (): ServerRequest => inRequest("request()").request;
  const cookie = (name: string): string | undefined => inRequest("cookie()").request.cookies[name];

  const setCookie = (name: string, value: string, opts: CookieOptions = {}) => {
    const c = inRequest("setCookie()");
    if (!/^[\w!#$%&'*+.^`|~-]+$/.test(name)) throw new Error(`invalid cookie name '${name}'`);
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, `SameSite=${opts.sameSite ?? "Lax"}`];
    if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    if (opts.httpOnly ?? true) parts.push("HttpOnly");
    if (opts.secure ?? c.secure) parts.push("Secure");
    c.setCookies.push(parts.join("; "));
  };
  const deleteCookie = (name: string, opts: { path?: string } = {}) => setCookie(name, "", { ...opts, maxAge: 0 });

  // Sessions: the cookie holds only an unguessable id; the data lives server-side, so sessions can be revoked.
  const stores = new Map<string, InstanceType<typeof DatabaseSync>>();
  const store = (c: CallContext) => {
    const file = c.dataDir ? `${c.dataDir}/sessions.sqlite` : ":memory:";
    let db = stores.get(file);
    if (!db) {
      db = new deps.DatabaseSync(file);
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)");
      stores.set(file, db);
    }
    return db;
  };
  const sessionRow = (c: CallContext) => {
    const id = c.request?.cookies[SESSION_COOKIE];
    if (!id) return undefined;
    const row = store(c).prepare("SELECT data, expires FROM sessions WHERE id = ?").get(id) as { data: string; expires: number } | undefined;
    if (!row || row.expires <= Date.now()) return undefined;
    return { id, data: JSON.parse(row.data) as Record<string, unknown> };
  };
  const session = (): Record<string, unknown> => sessionRow(context("session()"))?.data ?? {};
  const setSession = (data: Record<string, unknown>, maxAge = 30 * 24 * 3600) => {
    const c = inRequest("setSession()");
    const db = store(c);
    // a fresh id every time (e.g. at login), so an id planted before login is worthless after it
    const old = sessionRow(c);
    if (old) db.prepare("DELETE FROM sessions WHERE id = ?").run(old.id);
    const id = deps.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (id, data, expires) VALUES (?, ?, ?)").run(id, JSON.stringify(data), Date.now() + maxAge * 1000);
    db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    c.request.cookies[SESSION_COOKIE] = id;
    setCookie(SESSION_COOKIE, id, { maxAge });
  };
  const clearSession = () => {
    const c = inRequest("clearSession()");
    const old = sessionRow(c);
    if (old) store(c).prepare("DELETE FROM sessions WHERE id = ?").run(old.id);
    delete c.request.cookies[SESSION_COOKIE];
    deleteCookie(SESSION_COOKIE);
  };
  const revokeSessions = (match: (data: Record<string, unknown>) => boolean): number => {
    const db = store(context("revokeSessions()"));
    let n = 0;
    for (const row of db.prepare("SELECT id, data FROM sessions").all() as { id: string; data: string }[]) {
      if (!match(JSON.parse(row.data) as Record<string, unknown>)) continue;
      db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      n++;
    }
    return n;
  };

  // rate limits: a sliding window per key, in this process's memory
  const windows = new Map<string, number[]>();
  const rateLimit = (key: string, opts: { max: number; per: number }) => {
    const now = Date.now();
    const since = now - opts.per * 1000;
    const hits = (windows.get(key) ?? []).filter((t) => t > since);
    if (hits.length >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((hits[0]! - since) / 1000));
      windows.set(key, hits);
      throw new HttpError(429, `too many attempts; try again in ${retryAfter}s`, { retryAfter });
    }
    hits.push(now);
    windows.set(key, hits);
    if (windows.size > 10_000) for (const [k, v] of windows) if (!v.some((t) => t > since)) windows.delete(k);
  };

  const parseCookies = (header: string | null): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // ignore malformed cookies
      }
    }
    return out;
  };

  // ---- background jobs and schedules ------------------------------------------------------------------------
  // Jobs live in .tcm/data/jobs.sqlite and name their function by hash, so a job runs the exact code version that
  // enqueued it, even across deploys. A claim is one atomic UPDATE with a lease, so several processes can work
  // the same queue; a scheduled slot is claimed by a unique key, so it runs once however many servers there are.
  const HASH_MARK = Symbol.for("tcm.hash");
  const JOB_MARK = Symbol.for("tcm.job");
  type Fn = (...args: unknown[]) => unknown;
  interface JobRow {
    id: string;
    fn_hash: string;
    fn_name: string;
    args: string;
    run_at: number;
    attempts: number;
    max_attempts: number;
    status: string;
  }
  let hostDataDir: string | undefined;
  const memoryFns = new Map<string, Fn>();
  const jobDbs = new Map<string, InstanceType<typeof DatabaseSync>>();
  const jobsDb = (dataDir: string | undefined) => {
    const file = dataDir ? `${dataDir}/jobs.sqlite` : ":memory:";
    let db = jobDbs.get(file);
    if (!db) {
      db = new deps.DatabaseSync(file);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, fn_hash TEXT NOT NULL, fn_name TEXT NOT NULL, args TEXT NOT NULL,
          run_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
          status TEXT NOT NULL, lease_until INTEGER, last_error TEXT, created INTEGER NOT NULL, finished INTEGER,
          slot TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, run_at);
        CREATE TABLE IF NOT EXISTS schedules (name TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);`);
      jobDbs.set(file, db);
    }
    return db;
  };
  const dataDirNow = () => storage.getStore()?.dataDir ?? hostDataDir;

  const enqueueAt = (runAt: number, fn: Fn, args: unknown[], opts: { attempts?: number; slot?: string; name?: string; hash?: string } = {}): string => {
    if (typeof fn !== "function") throw new TypeError("enqueue() needs a function");
    const dataDir = dataDirNow();
    const hash = opts.hash ?? (fn as unknown as Record<symbol, string | undefined>)[HASH_MARK];
    if (dataDir && !hash) throw new Error(`enqueue() needs a codebase function (a top-level definition, so it can be found by hash), not an inline one`);
    const id = typedId(12);
    const encoded = deps.encode(args, `arguments to ${fn.name || "the job"}`);
    const insert = () => {
      const r = jobsDb(dataDir)
        .prepare("INSERT OR IGNORE INTO jobs (id, fn_hash, fn_name, args, run_at, max_attempts, status, created, slot) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
        .run(id, hash ?? "", opts.name ?? (fn.name || "anonymous"), encoded, runAt, opts.attempts ?? 5, Date.now(), opts.slot ?? null);
      if (r.changes && !dataDir) memoryFns.set(id, fn);
      return r.changes > 0;
    };
    // inside a transaction, the job is part of it: queued if it commits, never if it rolls back
    const t = openTxn();
    if (t && !opts.slot) {
      t.afterCommit.push(insert);
      return id;
    }
    return insert() ? id : "";
  };
  /** Run `fn(...args)` in the background, soon; returns the job's id. Arguments must be plain data. */
  const enqueue = (fn: Fn, ...args: unknown[]) => enqueueAt(Date.now(), fn, args);
  /** Run `fn(...args)` in the background after `seconds`. */
  const enqueueAfter = (seconds: number, fn: Fn, ...args: unknown[]) => enqueueAt(Date.now() + seconds * 1000, fn, args);

  // schedules: "30s" / "15m" / "2h" / "1d" intervals, or five-field cron ("0 3 * * *", UTC)
  const INTERVAL = /^(\d+)(s|m|h|d)$/;
  const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const cronField = (spec: string, min: number, max: number): Set<number> => {
    const out = new Set<number>();
    for (const part of spec.split(",")) {
      const [range, stepText] = part.split("/") as [string, string | undefined];
      const step = stepText === undefined ? 1 : Number(stepText);
      const [lo, hi] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), stepText === undefined ? Number(range) : max];
      if (![lo, hi, step].every((n) => Number.isInteger(n)) || lo! < min || hi! > max || step < 1) throw new Error(`bad cron field '${spec}'`);
      for (let v = lo!; v <= hi!; v += step) out.add(v);
    }
    return out;
  };
  const parseSchedule = (spec: string) => {
    const m = INTERVAL.exec(spec);
    if (m) return { every: Number(m[1]) * UNITS[m[2]!]! };
    const f = spec.trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`schedule '${spec}': use an interval like "15m" or five cron fields like "0 3 * * *"`);
    return { cron: [cronField(f[0]!, 0, 59), cronField(f[1]!, 0, 23), cronField(f[2]!, 1, 31), cronField(f[3]!, 1, 12), cronField(f[4]!, 0, 6)] };
  };
  /** The scheduled slot at or before `now`, if one is due (intervals always; cron only in the minute it names). */
  const dueSlot = (spec: ReturnType<typeof parseSchedule>, now: number): number | undefined => {
    if (spec.every) return Math.floor(now / spec.every) * spec.every;
    const d = new Date(Math.floor(now / 60_000) * 60_000);
    const [mi, h, dom, mo, dow] = spec.cron!;
    return mi!.has(d.getUTCMinutes()) && h!.has(d.getUTCHours()) && dom!.has(d.getUTCDate()) && mo!.has(d.getUTCMonth() + 1) && dow!.has(d.getUTCDay()) ? d.getTime() : undefined;
  };
  /** A recurring job: export it from the app's namespace and `tcm start` / `tcm dev` run it on schedule. */
  const every = (spec: string, fn: Fn) => {
    parseSchedule(spec);
    if (typeof fn !== "function") throw new TypeError("every() needs a function");
    return { [JOB_MARK]: true, spec, fn };
  };

  const backoff = (attempt: number) => Math.min(3600, 2 ** attempt) * 1000;
  const finish = (db: InstanceType<typeof DatabaseSync>, row: JobRow, error: unknown) => {
    if (error === undefined) {
      db.prepare("UPDATE jobs SET status = 'done', finished = ?, lease_until = NULL WHERE id = ?").run(Date.now(), row.id);
      return "done";
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (row.attempts >= row.max_attempts) {
      db.prepare("UPDATE jobs SET status = 'failed', finished = ?, last_error = ?, lease_until = NULL WHERE id = ?").run(Date.now(), message, row.id);
      return "failed";
    }
    db.prepare("UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, lease_until = NULL WHERE id = ?").run(Date.now() + backoff(row.attempts), message, row.id);
    return "retrying";
  };
  const runJob = async (fn: Fn, row: JobRow, dataDir: string | undefined) => {
    const ctx: CallContext = { setCookies: [], secure: false, dataDir };
    try {
      await storage.run(ctx, async () => fn(...(deps.decode(row.args) as unknown[])));
      return undefined;
    } catch (e) {
      return e ?? new Error("the job threw undefined");
    }
  };

  /** For tests: run the queued jobs that are due (all of them with `{ all: true }`), inline. */
  const runJobs = async (opts: { all?: boolean } = {}): Promise<{ done: number; failed: number }> => {
    const db = jobsDb(dataDirNow());
    let done = 0;
    let failed = 0;
    for (;;) {
      const row = db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 1").get(opts.all ? Number.MAX_SAFE_INTEGER : Date.now()) as JobRow | undefined;
      if (!row) return { done, failed };
      db.prepare("UPDATE jobs SET attempts = attempts + 1, status = 'running' WHERE id = ?").run(row.id);
      row.attempts++;
      const fn = memoryFns.get(row.id);
      const outcome = fn ? finish(db, row, await runJob(fn, row, dataDirNow())) : finish(db, { ...row, attempts: row.max_attempts }, new Error("no function for this job in memory"));
      if (outcome === "done") done++;
      else if (outcome === "failed") failed++;
    }
  };

  /** For the host: work the queue in .tcm/data, `concurrency` jobs at a time, loading functions by hash. */
  const startWorker = (opts: { dataDir: string; load: (hash: string) => Promise<Fn>; log: (line: string) => void; concurrency?: number }) => {
    hostDataDir = opts.dataDir;
    const db = jobsDb(opts.dataDir);
    const claim = db.prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?
       WHERE id = (SELECT id FROM jobs WHERE (status = 'queued' AND run_at <= ?) OR (status = 'running' AND lease_until < ?) ORDER BY run_at LIMIT 1)
       RETURNING *`,
    );
    let running = 0;
    let stopped = false;
    const tick = () => {
      while (!stopped && running < (opts.concurrency ?? 4)) {
        const now = Date.now();
        const row = claim.get(now + 10 * 60_000, now, now) as JobRow | undefined;
        if (!row) return;
        running++;
        const started = performance.now();
        (async () => {
          let error: unknown;
          try {
            error = await runJob(await opts.load(row.fn_hash), row, opts.dataDir);
          } catch (e) {
            error = e;
          }
          const outcome = finish(db, row, error);
          const ms = Math.round(performance.now() - started);
          opts.log(`job ${row.fn_name} ${outcome}${outcome === "done" ? "" : ` (attempt ${row.attempts}/${row.max_attempts}: ${String((error as Error)?.message ?? error).split("\n")[0]})`} ${ms}ms`);
        })().finally(() => {
          running--;
          tick();
        });
      }
    };
    const timer = setInterval(tick, 250);
    tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  };

  /**
   * For the host: the recurring jobs found in the app's namespace; replaces the previous set. `hash` is the schedule
   * definition's: its function may be inline, so a run records "the fn of schedule <hash>" (pinned all the same).
   */
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  const setSchedules = (opts: { dataDir: string; jobs: { name: string; spec: string; fn: Fn; hash: string }[]; log?: (line: string) => void }) => {
    hostDataDir = opts.dataDir;
    const db = jobsDb(opts.dataDir);
    const jobs = opts.jobs.map((j) => ({ ...j, parsed: parseSchedule(j.spec) }));
    for (const j of jobs) db.prepare("INSERT OR IGNORE INTO schedules (name, first_seen) VALUES (?, ?)").run(j.name, Date.now());
    const tick = () => {
      const now = Date.now();
      for (const j of jobs) {
        // one broken schedule must never take the server down
        try {
          const slot = dueSlot(j.parsed, now);
          const first = (db.prepare("SELECT first_seen FROM schedules WHERE name = ?").get(j.name) as { first_seen: number }).first_seen;
          // only slots since the schedule first appeared: a new schedule doesn't fire at once, a restart catches up
          if (slot === undefined || slot < first) continue;
          enqueueAt(slot, j.fn, [], { slot: `${j.name}@${slot}`, name: j.name, hash: `${j.hash}#fn` });
        } catch (e) {
          opts.log?.(`schedule ${j.name}: ${(e as Error).message}`);
        }
      }
    };
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = setInterval(tick, 1000);
    tick();
  };

  // ---- tables: typed, durable rows in .tcm/data/store.sqlite ----------------------------------------------------
  // The row type is erased at runtime, but tcm knows it where the table is declared and attaches its schema (with a
  // hash) to the table value. Every write is checked against it and records the schema it was written with. A read
  // of a row written under another schema checks that it still fits, else migrates it, else refuses: stored data
  // never silently disagrees with the code reading it. Rows from newer code mean the caller is a stale page (410).
  const SCHEMA_MARK = Symbol.for("tcm.schema");
  /** for the CLI (`tcm data migrate`): bring every stored row up to the current row type now */
  const MIGRATE_ALL = Symbol.for("tcm.migrateAll");
  type Db = InstanceType<typeof DatabaseSync>;
  type Checked = { s: Parameters<typeof checkValue>[0]; defs: Parameters<typeof checkValue>[3] };
  interface RowSchema extends Checked {
    name?: string;
    hash: string;
    /** each migrate step's parameter type, in order */
    steps?: Checked[];
  }
  type Row = { id: string; data: string; schema_hash: string; updated: number };
  type Step = (old: unknown) => unknown;
  interface TableOptions {
    migrate?: Step | Step[];
    unique?: string[];
    index?: string[];
    renamedFrom?: string;
  }
  interface FindOptions {
    orderBy?: string;
    desc?: boolean;
    limit?: number;
    offset?: number;
  }
  const TABLE_NAME = /^[\w.-]+$/;
  const FIELD = /^[A-Za-z_$][\w$]*$/;
  // a row field as SQL (indexes are on exactly this expression). Table names and fields are validated, so they can
  // be inlined, which a partial index needs in order to be usable.
  const fieldSql = (f: string) => `json_extract(data, '$."${f}"')`;
  const isScalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  // what json_extract gives for a stored value: scalars as themselves (true as 1), anything else as its JSON text
  const sqlValue = (v: unknown) => (typeof v === "boolean" ? Number(v) : isScalar(v) ? v : deps.encode(v)) as string | number | null;
  const sortKey = (v: unknown): [number, number | string] =>
    v === undefined || v === null ? [0, 0] : typeof v === "number" ? [1, v] : v instanceof Date ? [2, v.getTime()] : typeof v === "string" ? [3, v] : [4, deps.encode(v)];
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [sortKey(a), sortKey(b)];
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
  };
  const dataDbs = new Map<string, Db>();
  const dataDb = (dataDir: string | undefined): Db => {
    const file = dataDir ? `${dataDir}/store.sqlite` : ":memory:";
    let db = dataDbs.get(file);
    if (!db) {
      db = new deps.DatabaseSync(file);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, schema_hash TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id));
        CREATE TABLE IF NOT EXISTS schemas (tbl TEXT NOT NULL, hash TEXT NOT NULL, schema TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY (tbl, hash));
        CREATE INDEX IF NOT EXISTS rows_by_schema ON rows (tbl, schema_hash);`);
      dataDbs.set(file, db);
    }
    return db;
  };

  // ---- transactions: one connection is shared by every request, so a transaction must own it ------------------
  // A transaction holds a lock on the store for its whole (async) duration: table calls made inside it run in it,
  // and table calls from anywhere else wait until it commits or rolls back. Every table call takes the same lock
  // briefly, so nothing reads uncommitted rows or writes into someone else's transaction. Holding is tracked with
  // AsyncLocalStorage, and a hold ends when its call does: a timer started inside fires as an outsider.
  type Hold = { key: object; open: boolean; parent?: Hold };
  const holds = new deps.AsyncLocalStorage<Hold>();
  const tails = new Map<object, Promise<void>>();
  const holding = (key: object) => {
    for (let h = holds.getStore(); h; h = h.parent) if (h.key === key && h.open) return true;
    return false;
  };
  /** Run `fn` with `key` (a store, or a transaction for its nested ones) to itself; reentrant. */
  const exclusive = async <R>(key: object, fn: () => R | Promise<R>): Promise<R> => {
    if (holding(key)) return fn();
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    const hold: Hold = { key, open: true, parent: holds.getStore() };
    try {
      return await holds.run(hold, fn);
    } finally {
      hold.open = false;
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
  type Txn = { db: InstanceType<typeof DatabaseSync>; open: boolean; afterCommit: (() => void)[] };
  const txns = new deps.AsyncLocalStorage<Txn>();
  const openTxn = () => {
    const t = txns.getStore();
    return t?.open ? t : undefined;
  };
  let savepoints = 0;
  /**
   * Run `fn` as one transaction over every table: all its writes happen, or (if it throws) none do. Jobs it
   * enqueues are queued when it commits and dropped if it rolls back. Nested transactions are savepoints.
   */
  const transaction = async <R>(fn: () => R | Promise<R>): Promise<R> => {
    const db = dataDb(dataDirNow());
    const outer = openTxn();
    if (outer && outer.db === db) {
      // a savepoint: its failure undoes only its own writes. Nested ones take turns (savepoints are a stack).
      return exclusive(outer, async () => {
        const name = `tcm_tx_${++savepoints}`;
        const inner: Txn = { db, open: true, afterCommit: [] };
        db.exec(`SAVEPOINT ${name}`);
        try {
          const r = await txns.run(inner, fn);
          db.exec(`RELEASE ${name}`);
          outer.afterCommit.push(...inner.afterCommit);
          return r;
        } catch (e) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          throw e;
        } finally {
          inner.open = false;
        }
      });
    }
    return exclusive(db, async () => {
      const t: Txn = { db, open: true, afterCommit: [] };
      db.exec("BEGIN IMMEDIATE");
      let r: R;
      try {
        r = await txns.run(t, fn);
        db.exec("COMMIT");
      } catch (e) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw e;
      } finally {
        t.open = false;
      }
      for (const f of t.afterCommit) f();
      return r;
    });
  };

  class Table<T> {
    readonly name: string;
    readonly #steps: Step[];
    readonly #unique: string[];
    readonly #index: string[];
    readonly #renamedFrom?: string;
    #prepared?: Db;
    constructor(name: string, opts: TableOptions = {}) {
      if (!TABLE_NAME.test(name)) throw new Error(`invalid table name '${name}'`);
      this.name = name;
      this.#steps = opts.migrate === undefined ? [] : Array.isArray(opts.migrate) ? opts.migrate : [opts.migrate];
      if (this.#steps.some((f) => typeof f !== "function")) throw new TypeError(`table "${name}": migrate is a function, or an array of them`);
      this.#unique = opts.unique ?? [];
      this.#index = opts.index ?? [];
      for (const f of [...this.#unique, ...this.#index]) if (!FIELD.test(f)) throw new Error(`table "${name}": can't index '${f}': fields are plain names`);
      if (opts.renamedFrom !== undefined && (!TABLE_NAME.test(opts.renamedFrom) || opts.renamedFrom === name)) throw new Error(`table "${name}": invalid renamedFrom '${opts.renamedFrom}'`);
      this.#renamedFrom = opts.renamedFrom;
    }
    #schema(): RowSchema {
      const s = (this as unknown as Record<symbol, RowSchema | undefined>)[SCHEMA_MARK];
      if (!s) throw new Error(`table "${this.name}" doesn't know its row type: declare it at the top level with one, e.g. export const ${this.name} = table<Row>("${this.name}")`);
      return s;
    }
    #db(): Db {
      const db = dataDb(dataDirNow());
      if (this.#prepared !== db) {
        const s = this.#schema();
        db.prepare("INSERT OR IGNORE INTO schemas (tbl, hash, schema, first_seen) VALUES (?, ?, ?, ?)").run(this.name, s.hash, JSON.stringify({ s: s.s, defs: s.defs }), Date.now());
        const id = (f: string, kind: string) => `tcm_${kind}_${this.name.replace(/[^A-Za-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}__${f}`;
        for (const f of this.#index) db.exec(`CREATE INDEX IF NOT EXISTS "${id(f, "index")}" ON rows (${fieldSql(f)}) WHERE tbl = '${this.name}'`);
        for (const f of this.#unique) {
          try {
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${id(f, "unique")}" ON rows (${fieldSql(f)}) WHERE tbl = '${this.name}'`);
          } catch {
            const dup = db.prepare(`SELECT ${fieldSql(f)} AS v, count(*) AS n FROM rows WHERE tbl = '${this.name}' GROUP BY v HAVING n > 1 LIMIT 1`).get() as { v: unknown; n: number } | undefined;
            throw new Error(`table "${this.name}": can't make ${f} unique: ${dup ? `${dup.n} stored rows have ${f} = ${JSON.stringify(dup.v)}` : "stored rows share values"}`);
          }
        }
        this.#prepared = db;
      }
      // rows still under the old name move over: all of them the first time, and any an older build writes since
      const old = this.#renamedFrom;
      if (old && db.prepare("SELECT 1 FROM rows WHERE tbl = ? LIMIT 1").get(old)) {
        this.#atomically(db, () => {
          db.prepare("INSERT OR IGNORE INTO schemas (tbl, hash, schema, first_seen) SELECT ?, hash, schema, first_seen FROM schemas WHERE tbl = ?").run(this.name, old);
          db.prepare("UPDATE OR IGNORE rows SET tbl = ? WHERE tbl = ?").run(this.name, old);
        });
      }
      return db;
    }
    /** A table call: it waits for any transaction it isn't part of (see `exclusive`). */
    #op<R>(fn: (db: Db) => Promise<R>): Promise<R> {
      return exclusive(dataDb(dataDirNow()), () => fn(this.#db()));
    }
    #atomically<R>(db: Db, fn: () => R): R {
      if (db.isTransaction) {
        db.exec("SAVEPOINT tcm_atomic");
        try {
          const r = fn();
          db.exec("RELEASE tcm_atomic");
          return r;
        } catch (e) {
          db.exec("ROLLBACK TO tcm_atomic");
          db.exec("RELEASE tcm_atomic");
          throw e;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    #check(value: unknown, what: string) {
      const s = this.#schema();
      const bad = deps.checkValue(s.s, value, what, s.defs);
      if (bad) throw new TypeError(`table "${this.name}": ${bad}`);
    }
    #fits(value: unknown): boolean {
      const s = this.#schema();
      return deps.checkValue(s.s, value, "row", s.defs) === undefined;
    }
    #write(db: Db, id: string, value: unknown) {
      // an upsert on the id only: a clash on a unique field is an error, never a silent replacement of the other row
      try {
        db.prepare(
          "INSERT INTO rows (tbl, id, data, schema_hash, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tbl, id) DO UPDATE SET data = excluded.data, schema_hash = excluded.schema_hash, updated = excluded.updated",
        ).run(this.name, id, deps.encode(value, `a ${this.name} row`), this.#schema().hash, Date.now());
      } catch (e) {
        if (!/UNIQUE constraint failed/.test(String((e as Error)?.message))) throw e;
        for (const f of this.#unique) {
          const v = (value as Record<string, unknown>)[f];
          const other = db.prepare(`SELECT id FROM rows WHERE tbl = '${this.name}' AND ${fieldSql(f)} = ? AND id != ?`).get(sqlValue(v), id) as { id: string } | undefined;
          if (other) throw new HttpError(409, `table "${this.name}": another row (${other.id}) already has ${f} = ${JSON.stringify(v)}`);
        }
        throw e;
      }
    }
    /** Run a value written as an older type through the migrate steps: each takes the values its parameter type fits. */
    async #migrate(value: unknown, id: string): Promise<unknown> {
      const params = this.#schema().steps ?? [];
      const refusal = (i: number, v: unknown) => (params[i] ? deps.checkValue(params[i]!.s, v, "row", params[i]!.defs) : undefined);
      let v = value;
      for (let from = 0; ; ) {
        let i = from;
        while (i < this.#steps.length && refusal(i, v) !== undefined) i++;
        if (i === this.#steps.length) {
          if (from > 0) return v; // the caller checks the result against the row type
          const why = this.#steps.map((f, j) => `step ${j + 1}${f.name ? ` (${f.name})` : ""}: ${refusal(j, v)}`);
          throw new Error(`table "${this.name}": row ${id} was written as an older type that no migrate step takes (${why.join("; ")})`);
        }
        v = await this.#steps[i]!(v);
        from = i + 1;
        if (this.#fits(v)) return v;
      }
    }
    async #read(db: Db, row: Row): Promise<T> {
      const s = this.#schema();
      const value = deps.decode(row.data);
      if (row.schema_hash === s.hash) return value as T;
      // written under another schema: fine if it still fits, otherwise migrate it (and store the result)
      if (this.#fits(value)) return value as T;
      const seen = db.prepare("SELECT hash, first_seen FROM schemas WHERE tbl = ? AND hash IN (?, ?)").all(this.name, row.schema_hash, s.hash) as { hash: string; first_seen: number }[];
      const firstSeen = (h: string) => seen.find((x) => x.hash === h)?.first_seen ?? 0;
      if (firstSeen(row.schema_hash) > firstSeen(s.hash)) {
        throw new HttpError(410, `table "${this.name}": row ${row.id} was written by a newer version of this app; reload for the current version`);
      }
      if (!this.#steps.length) {
        throw new Error(`table "${this.name}": row ${row.id} was written as an older type and doesn't fit the current one (${deps.checkValue(s.s, value, "row", s.defs)}). Give table() a migrate function: table<Row>("${this.name}", { migrate: (old) => ... })`);
      }
      const next = await this.#migrate(value, row.id);
      this.#check(next, `migrated row ${row.id}`);
      db.prepare("UPDATE rows SET data = ?, schema_hash = ? WHERE tbl = ? AND id = ? AND schema_hash = ?").run(deps.encode(next), s.hash, this.name, row.id, row.schema_hash);
      return next as T;
    }
    /** Rows not written as the current row type: they must be read (maybe migrated) before they can be compared. */
    #stale(db: Db): Row[] {
      const h = this.#schema().hash;
      return db.prepare("SELECT id, data, schema_hash, updated FROM rows WHERE tbl = ? AND (schema_hash < ? OR schema_hash > ?)").all(this.name, h, h) as Row[];
    }
    /** Store `value` under `id`, replacing what was there; it must fit the row type. */
    async put(id: string, value: T): Promise<void> {
      this.#check(value, "value");
      return this.#op(async (db) => this.#write(db, id, value));
    }
    /** Store a new row; returns its id. */
    async insert(value: T): Promise<string> {
      const id = typedId(9);
      await this.put(id, value);
      return id;
    }
    async get(id: string): Promise<T | undefined> {
      return this.#op(async (db) => {
      const row = db.prepare("SELECT id, data, schema_hash, updated FROM rows WHERE tbl = ? AND id = ?").get(this.name, id) as Row | undefined;
      return row ? this.#read(db, row) : undefined;
      });
    }
    async delete(id: string): Promise<boolean> {
      return this.#op(async (db) => db.prepare("DELETE FROM rows WHERE tbl = ? AND id = ?").run(this.name, id).changes > 0);
    }
    /**
     * Change one row atomically: `fn` gets its current value and returns the new one, synchronously, so nothing
     * can write in between. Returns the new value, or undefined if there's no such row.
     */
    async update(id: string, fn: (current: T) => T): Promise<T | undefined> {
      return this.#op(async (db) => {
      for (;;) {
        // bring the row up to the current type first: migrating may be async
        if ((await this.get(id)) === undefined) return undefined;
        const r = this.#atomically(db, () => {
          const row = db.prepare("SELECT data FROM rows WHERE tbl = ? AND id = ?").get(this.name, id) as { data: string } | undefined;
          if (!row) return { done: true, value: undefined };
          const current = deps.decode(row.data);
          if (!this.#fits(current)) return { done: false, value: undefined }; // rewritten as another type meanwhile: again
          const next = fn(current as T);
          if (typeof (next as { then?: unknown } | undefined)?.then === "function") {
            throw new TypeError(`table "${this.name}": update()'s function must return the new value, not a promise (it runs while the row is locked)`);
          }
          this.#check(next, "value");
          this.#write(db, id, next);
          return { done: true, value: next };
        });
        if (r.done) return r.value;
      }
      });
    }
    /**
     * Rows whose fields equal `where`'s (all rows if omitted), oldest first or by `orderBy`. Fields in the table's
     * `index` or `unique` lists are looked up by index.
     */
    async find(where: Partial<T> = {}, opts: FindOptions = {}): Promise<{ id: string; value: T }[]> {
      return this.#op(async (db) => {
      const entries = Object.entries(where as Record<string, unknown>);
      for (const f of [...entries.map(([k]) => k), ...(opts.orderBy ? [opts.orderBy] : [])]) if (!FIELD.test(f)) throw new Error(`table "${this.name}": no field '${f}'`);
      const wanted = entries.map(([k, v]) => [k, deps.encode(v)] as const);
      const matches = (v: unknown) => wanted.every(([k, x]) => deps.encode((v as Record<string, unknown>)[k]) === x);
      const whole = (n: number | undefined) => (n === undefined ? undefined : Math.max(0, Math.floor(n)));
      const limit = whole(opts.limit);
      const offset = whole(opts.offset) ?? 0;
      const stale = this.#stale(db);
      const scalar = entries.filter(([, v]) => isScalar(v));
      // with every row current and every condition expressible in SQL, SQLite does all of it (with indexes)
      const pushdown = !stale.length && scalar.length === entries.length;
      const order = opts.orderBy ? `${fieldSql(opts.orderBy)} ${opts.desc ? "DESC" : "ASC"}, ` : "";
      const page = pushdown && limit !== undefined ? ` LIMIT ${limit} OFFSET ${offset}` : "";
      const sql = `SELECT id, data, schema_hash, updated FROM rows WHERE tbl = '${this.name}' AND schema_hash = ?${scalar.map(([k]) => ` AND ${fieldSql(k)} = ?`).join("")} ORDER BY ${order}updated, id${page}`;
      const out: { id: string; value: T; updated: number }[] = [];
      for (const row of db.prepare(sql).all(this.#schema().hash, ...scalar.map(([, v]) => sqlValue(v))) as Row[]) {
        const value = deps.decode(row.data);
        if (matches(value)) out.push({ id: row.id, value: value as T, updated: row.updated });
      }
      if (pushdown) return out.map(({ id, value }) => ({ id, value }));
      for (const row of stale) {
        const value = await this.#read(db, row);
        if (matches(value)) out.push({ id: row.id, value, updated: row.updated });
      }
      const by = opts.orderBy;
      const field = (r: { value: T }) => (r.value as Record<string, unknown>)[by!];
      out.sort((a, b) => (by ? compare(field(a), field(b)) * (opts.desc ? -1 : 1) : 0) || a.updated - b.updated || (a.id < b.id ? -1 : 1));
      return out.slice(offset, limit === undefined ? undefined : offset + limit).map(({ id, value }) => ({ id, value }));
      });
    }
    /** The first row `find` would return, or undefined. */
    async findOne(where: Partial<T> = {}, opts: Omit<FindOptions, "limit"> = {}): Promise<{ id: string; value: T } | undefined> {
      return (await this.find(where, { ...opts, limit: 1 }))[0];
    }
    async count(where: Partial<T> = {}): Promise<number> {
      return this.#op(async (db) => {
      const entries = Object.entries(where as Record<string, unknown>);
      if (this.#stale(db).length || !entries.every(([k, v]) => FIELD.test(k) && isScalar(v))) return (await this.find(where)).length;
      const sql = `SELECT count(*) AS n FROM rows WHERE tbl = '${this.name}' AND schema_hash = ?${entries.map(([k]) => ` AND ${fieldSql(k)} = ?`).join("")}`;
      return (db.prepare(sql).get(this.#schema().hash, ...entries.map(([, v]) => sqlValue(v))) as { n: number }).n;
      });
    }
    /** Read every row written as another type now, storing it as the current one (rows that fit are just restamped). */
    async [MIGRATE_ALL](): Promise<{ total: number; restamped: number; migrated: number; newer: number; failed: { id: string; why: string }[] }> {
      return this.#op(async (db) => {
      const s = this.#schema();
      const total = (db.prepare("SELECT count(*) AS n FROM rows WHERE tbl = ?").get(this.name) as { n: number }).n;
      const r = { total, restamped: 0, migrated: 0, newer: 0, failed: [] as { id: string; why: string }[] };
      for (const row of this.#stale(db)) {
        if (this.#fits(deps.decode(row.data))) {
          db.prepare("UPDATE rows SET schema_hash = ? WHERE tbl = ? AND id = ? AND schema_hash = ?").run(s.hash, this.name, row.id, row.schema_hash);
          r.restamped++;
          continue;
        }
        try {
          await this.#read(db, row);
          r.migrated++;
        } catch (e) {
          if (e instanceof HttpError && e.status === 410) r.newer++;
          else r.failed.push({ id: row.id, why: (e as Error)?.message ?? String(e) });
        }
      }
      return r;
      });
    }
  }
  /** A typed, durable table: `export const users = table<User>("users")`. */
  const table = <T>(name: string, opts?: TableOptions) => new Table<T>(name, opts);

  /** For the host: the Set-Cookie headers the current call has produced so far (a stream sends them up front). */
  const pendingCookies = (): string[] => storage.getStore()?.setCookies ?? [];

  /** For the host: run one call inside its request's context; reports the Set-Cookie headers it produced. */
  const withCall = async <T>(
    call: { method: string; url: string; headers: Record<string, string | string[] | undefined>; ip: string | undefined; signal: AbortSignal },
    opts: { secure: boolean; dataDir?: string },
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T; setCookies: string[] } | { ok: false; error: unknown; setCookies: string[] }> => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(call.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const ctx: CallContext = {
      request: { method: call.method, url: call.url, headers, cookies: parseCookies(headers.get("cookie")), ip: call.ip, signal: call.signal },
      setCookies: [],
      secure: opts.secure,
      dataDir: opts.dataDir,
    };
    try {
      return { ok: true, value: await storage.run(ctx, fn), setCookies: ctx.setCookies };
    } catch (error) {
      return { ok: false, error, setCookies: ctx.setCookies };
    }
  };

  /** Run `fn` as if answering a request: for tests of server functions (`tcm test`), no network involved. */
  const withRequest = async <T>(
    init: { method?: string; url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; ip?: string },
    fn: () => T | Promise<T>,
  ): Promise<{ value: T; setCookies: string[] }> => {
    const cookieHeader = Object.entries(init.cookies ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const headers = { ...(init.headers ?? {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) };
    const r = await withCall(
      { method: init.method ?? "POST", url: init.url ?? "/", headers, ip: init.ip ?? "127.0.0.1", signal: new AbortController().signal },
      { secure: false },
      async () => fn(),
    );
    if (!r.ok) throw r.error;
    return { value: r.value, setCookies: r.setCookies };
  };

  return {
    HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, revokeSessions, rateLimit,
    enqueue, enqueueAfter, every, runJobs, table, transaction, withCall, withRequest, pendingCookies, startWorker, setSchedules,
  };
}

/** Types of `#tcm/server`, for editors and the checker (the runtime is generated from createServerApi above). */
const DECLARATIONS = `// generated by tcm — do not edit
export interface ServerRequest {
  method: string;
  url: string;
  headers: Headers;
  cookies: Record<string, string>;
  /** the client's address, as the socket sees it */
  ip: string | undefined;
  /** aborted when the client disconnects, so long work can stop early */
  signal: AbortSignal;
}
export interface CookieOptions {
  maxAge?: number;
  path?: string;
  /** default true: not readable by browser scripts */
  httpOnly?: boolean;
  /** default true when served over TLS */
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
/** A failure meant for the caller: its status and message reach the browser (other errors are hidden in production). */
export declare class HttpError extends Error {
  readonly status: number;
  /** seconds, sent as Retry-After */
  readonly retryAfter?: number;
  constructor(status: number, message: string, opts?: { retryAfter?: number });
}
/** The HTTP request this server function is answering. */
export declare function request(): ServerRequest;
export declare function cookie(name: string): string | undefined;
export declare function setCookie(name: string, value: string, opts?: CookieOptions): void;
export declare function deleteCookie(name: string, opts?: { path?: string }): void;
/** The caller's session data (empty if none, expired or revoked). */
export declare function session(): Record<string, unknown>;
/**
 * Start a new session with this data for \`maxAge\` seconds (default 30 days). The data is stored server-side
 * (.tcm/data/sessions.sqlite); the cookie holds only a fresh, unguessable id.
 */
export declare function setSession(data: Record<string, unknown>, maxAge?: number): void;
export declare function clearSession(): void;
/** End every session whose data matches, e.g. \`revokeSessions((s) => s.user === "ada")\`; returns how many. */
export declare function revokeSessions(match: (data: Record<string, unknown>) => boolean): number;
/** Allow \`max\` calls per \`per\` seconds for \`key\` (e.g. "login:" + request().ip); beyond that, throws a 429. */
export declare function rateLimit(key: string, opts: { max: number; per: number }): void;
/**
 * Run \`fn(...args)\` in the background, soon, with retries (5 attempts, exponential backoff); returns the job id.
 * \`fn\` must be a codebase function: the job records its hash, so it runs the code version that enqueued it.
 * Arguments must be plain data.
 */
export declare function enqueue<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): string;
/** Like enqueue, after \`seconds\`. */
export declare function enqueueAfter<A extends unknown[]>(seconds: number, fn: (...args: A) => unknown, ...args: A): string;
export interface RecurringJob {
  readonly spec: string;
  readonly fn: () => unknown;
}
/**
 * A recurring job: \`export const nightly = every("0 3 * * *", cleanup)\` (five cron fields, UTC) or an interval
 * like \`every("15m", sync)\`. tcm start / tcm dev run the jobs in the app's namespace, once per slot.
 */
export declare function every(spec: string, fn: () => unknown): RecurringJob;
/**
 * A typed, durable table, declared at the top level: \`export const users = table<User>("users")\`. tcm attaches the
 * row type's schema: writes are checked against it, and rows written under an older type are checked, migrated
 * with \`migrate\` (if given) or refused when read. Data lives in .tcm/data/store.sqlite.
 */
export declare function table<T>(name: string, opts?: TableOptions<T>): Table<T>;
export interface TableOptions<T> {
  /**
   * Upgrades rows stored as an earlier row type. One function, or one step per earlier type, oldest first:
   * \`[fromV1, fromV2]\`. A row goes through the first step whose parameter type it fits, then the later ones,
   * until it fits \`T\`. The result is checked, and stored. \`tcm data migrate <table>\` upgrades every row now.
   */
  migrate?: ((old: any) => T | Promise<T>) | readonly ((old: any) => unknown)[];
  /** Fields no two rows may share: a write that would duplicate one fails with a 409. Indexed. */
  unique?: readonly (keyof T & string)[];
  /** Fields to index, so \`find\` on them doesn't read every row. */
  index?: readonly (keyof T & string)[];
  /** The table's previous name: its rows move to this table when it's first used. */
  renamedFrom?: string;
}
export interface FindOptions<T> {
  orderBy?: keyof T & string;
  desc?: boolean;
  limit?: number;
  offset?: number;
}
export interface Table<T> {
  readonly name: string;
  /** Store a new row; returns its id. */
  insert(value: T): Promise<string>;
  /** Store \`value\` under \`id\`, replacing what was there. */
  put(id: string, value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  /**
   * Change one row atomically: \`fn\` gets the current value and returns the new one, synchronously, so nothing can
   * write in between. Returns the new value, or undefined if there's no such row.
   */
  update(id: string, fn: (current: T) => T): Promise<T | undefined>;
  /** Rows whose fields equal \`where\`'s (all rows if omitted), oldest first or by \`orderBy\`. */
  find(where?: Partial<T>, opts?: FindOptions<T>): Promise<{ id: string; value: T }[]>;
  /** The first row \`find\` would return. */
  findOne(where?: Partial<T>, opts?: Omit<FindOptions<T>, "limit">): Promise<{ id: string; value: T } | undefined>;
  count(where?: Partial<T>): Promise<number>;
}
/**
 * Run \`fn\` as one transaction over every table: all its writes happen, or, if it throws, none do. While it runs,
 * other requests' table calls wait, so none sees its uncommitted rows or writes in between. Jobs it enqueues
 * are queued when it commits, and dropped if it rolls back. A transaction inside one is a savepoint. Keep it
 * short (it holds the store), and don't await anything inside that itself waits for a table.
 */
export declare function transaction<R>(fn: () => R | Promise<R>): Promise<R>;
/** For tests: run the queued jobs that are due (all of them with \`{ all: true }\`), inline. */
export declare function runJobs(opts?: { all?: boolean }): Promise<{ done: number; failed: number }>;
/** Run \`fn\` as if answering a request, for tests of server functions: no network (sessions kept in memory). */
export declare function withRequest<T>(
  init: { method?: string; url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; ip?: string },
  fn: () => T | Promise<T>,
): Promise<{ value: T; setCookies: string[] }>;
`;

/** The generated `tcm-server.js` and `tcm-server.d.ts`. */
export function serverApiFiles(): { js: string; dts: string } {
  const js = `// generated by tcm — do not edit: the #tcm/server runtime
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
${codecSource().replaceAll("export ", "")}
${schemaCheckerSource()}
const api = (${createServerApi})({ AsyncLocalStorage, randomBytes, DatabaseSync, encode, decode, checkValue });
export const {
  HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, revokeSessions, rateLimit,
  enqueue, enqueueAfter, every, runJobs, table, transaction, withCall, withRequest, pendingCookies, startWorker, setSchedules,
} = api;
`;
  return { js, dts: DECLARATIONS };
}
