// `#ucm/server`: what a server function can know about the call it's serving.
//
//   import { request, session, setSession, HttpError } from "#ucm/server";
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
// The API is written as one factory whose own source text becomes `.ucm/cache/ucm-server.js` (with types in
// `ucm-server.d.ts`): server functions, test runners and the RPC host all import that file, so they share one
// instance per process wherever ucm itself runs from (its source, a built package, or a codebase's cache).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { codecSource, decode, encode } from "./codec.ts";
import { checkValue, schemaCheckerSource } from "@ucm/core";

export function createServerApi(deps: {
  AsyncLocalStorage: typeof AsyncLocalStorage;
  randomBytes: typeof randomBytes;
  DatabaseSync: typeof DatabaseSync;
  encode: typeof encode;
  decode: typeof decode;
  checkValue: typeof checkValue;
}) {
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
  const SESSION_COOKIE = "ucm_sid";

  const context = (what: string): CallContext => {
    const c = storage.getStore();
    if (!c) throw new Error(`${what} only works inside a server function called from the browser (ucm dev / ucm start)`);
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
  // Jobs live in .ucm/data/jobs.sqlite and name their function by hash, so a job runs the exact code version that
  // enqueued it, even across deploys. A claim is one atomic UPDATE with a lease, so several processes can work
  // the same queue; a scheduled slot is claimed by a unique key, so it runs once however many servers there are.
  const HASH_MARK = Symbol.for("ucm.hash");
  const JOB_MARK = Symbol.for("ucm.job");
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
    const id = deps.randomBytes(12).toString("base64url");
    const r = jobsDb(dataDir)
      .prepare("INSERT OR IGNORE INTO jobs (id, fn_hash, fn_name, args, run_at, max_attempts, status, created, slot) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
      .run(id, hash ?? "", opts.name ?? (fn.name || "anonymous"), deps.encode(args, `arguments to ${fn.name || "the job"}`), runAt, opts.attempts ?? 5, Date.now(), opts.slot ?? null);
    if (!r.changes) return "";
    if (!dataDir) memoryFns.set(id, fn);
    return id;
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
  /** A recurring job: export it from the app's namespace and `ucm start` / `ucm dev` run it on schedule. */
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

  /** For the host: work the queue in .ucm/data, `concurrency` jobs at a time, loading functions by hash. */
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

  // ---- tables: typed, durable rows in .ucm/data/store.sqlite ----------------------------------------------------
  // The row type is erased at runtime, but ucm knows it where the table is declared and attaches its schema (with a
  // hash) to the table value. Every write is checked against it and records the schema it was written with. A read
  // of a row written under another schema checks that it still fits, else migrates it, else refuses: stored data
  // never silently disagrees with the code reading it. Rows from newer code mean the caller is a stale page (410).
  const SCHEMA_MARK = Symbol.for("ucm.schema");
  type Db = InstanceType<typeof DatabaseSync>;
  interface RowSchema {
    name?: string;
    hash: string;
    s: Parameters<typeof checkValue>[0];
    defs: Parameters<typeof checkValue>[3];
  }
  const dataDbs = new Map<string, Db>();
  const dataDb = (dataDir: string | undefined): Db => {
    const file = dataDir ? `${dataDir}/store.sqlite` : ":memory:";
    let db = dataDbs.get(file);
    if (!db) {
      db = new deps.DatabaseSync(file);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, schema_hash TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id));
        CREATE TABLE IF NOT EXISTS schemas (tbl TEXT NOT NULL, hash TEXT NOT NULL, schema TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY (tbl, hash));`);
      dataDbs.set(file, db);
    }
    return db;
  };

  class Table<T> {
    readonly name: string;
    readonly #migrate?: (old: unknown) => T | Promise<T>;
    constructor(name: string, opts: { migrate?: (old: unknown) => T | Promise<T> } = {}) {
      if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid table name '${name}'`);
      this.name = name;
      this.#migrate = opts.migrate;
    }
    #schema(): RowSchema {
      const s = (this as unknown as Record<symbol, RowSchema | undefined>)[SCHEMA_MARK];
      if (!s) throw new Error(`table "${this.name}" doesn't know its row type: declare it at the top level with one, e.g. export const ${this.name} = table<Row>("${this.name}")`);
      return s;
    }
    #db(): Db {
      const db = dataDb(dataDirNow());
      const s = this.#schema();
      db.prepare("INSERT OR IGNORE INTO schemas (tbl, hash, schema, first_seen) VALUES (?, ?, ?, ?)").run(this.name, s.hash, JSON.stringify({ s: s.s, defs: s.defs }), Date.now());
      return db;
    }
    #check(value: unknown, what: string) {
      const s = this.#schema();
      const bad = deps.checkValue(s.s, value, what, s.defs);
      if (bad) throw new TypeError(`table "${this.name}": ${bad}`);
    }
    async #read(db: Db, row: { id: string; data: string; schema_hash: string }): Promise<T> {
      const s = this.#schema();
      const value = deps.decode(row.data);
      if (row.schema_hash === s.hash) return value as T;
      // written under another schema: fine if it still fits, otherwise migrate it (and store the result)
      if (deps.checkValue(s.s, value, "row", s.defs) === undefined) return value as T;
      const seen = db.prepare("SELECT hash, first_seen FROM schemas WHERE tbl = ? AND hash IN (?, ?)").all(this.name, row.schema_hash, s.hash) as { hash: string; first_seen: number }[];
      const firstSeen = (h: string) => seen.find((x) => x.hash === h)?.first_seen ?? 0;
      if (firstSeen(row.schema_hash) > firstSeen(s.hash)) {
        throw new HttpError(410, `table "${this.name}": row ${row.id} was written by a newer version of this app; reload for the current version`);
      }
      if (!this.#migrate) {
        throw new Error(`table "${this.name}": row ${row.id} was written as an older type and doesn't fit the current one (${deps.checkValue(s.s, value, "row", s.defs)}). Give table() a migrate function: table<Row>("${this.name}", { migrate: (old) => ... })`);
      }
      const next = await this.#migrate(value);
      this.#check(next, `migrated row ${row.id}`);
      db.prepare("UPDATE rows SET data = ?, schema_hash = ?, updated = ? WHERE tbl = ? AND id = ? AND schema_hash = ?").run(deps.encode(next), s.hash, Date.now(), this.name, row.id, row.schema_hash);
      return next;
    }
    /** Store `value` under `id`, replacing what was there; it must fit the row type. */
    async put(id: string, value: T): Promise<void> {
      this.#check(value, "value");
      this.#db().prepare("INSERT OR REPLACE INTO rows (tbl, id, data, schema_hash, updated) VALUES (?, ?, ?, ?, ?)").run(this.name, id, deps.encode(value, `a ${this.name} row`), this.#schema().hash, Date.now());
    }
    /** Store a new row; returns its id. */
    async insert(value: T): Promise<string> {
      const id = deps.randomBytes(9).toString("base64url");
      await this.put(id, value);
      return id;
    }
    async get(id: string): Promise<T | undefined> {
      const db = this.#db();
      const row = db.prepare("SELECT id, data, schema_hash FROM rows WHERE tbl = ? AND id = ?").get(this.name, id) as { id: string; data: string; schema_hash: string } | undefined;
      return row ? this.#read(db, row) : undefined;
    }
    async delete(id: string): Promise<boolean> {
      return this.#db().prepare("DELETE FROM rows WHERE tbl = ? AND id = ?").run(this.name, id).changes > 0;
    }
    /** Rows whose fields equal `where`'s (all rows if omitted), oldest first. */
    async find(where: Partial<T> = {}): Promise<{ id: string; value: T }[]> {
      const db = this.#db();
      const out: { id: string; value: T }[] = [];
      const keys = Object.entries(where as Record<string, unknown>).map(([k, v]) => [k, deps.encode(v)] as const);
      for (const row of db.prepare("SELECT id, data, schema_hash FROM rows WHERE tbl = ? ORDER BY updated, id").all(this.name) as { id: string; data: string; schema_hash: string }[]) {
        const value = await this.#read(db, row);
        if (keys.every(([k, v]) => deps.encode((value as Record<string, unknown>)[k]) === v)) out.push({ id: row.id, value });
      }
      return out;
    }
    async count(where: Partial<T> = {}): Promise<number> {
      return (await this.find(where)).length;
    }
  }
  /** A typed, durable table: `export const users = table<User>("users")`. */
  const table = <T>(name: string, opts?: { migrate?: (old: unknown) => T | Promise<T> }) => new Table<T>(name, opts);

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

  /** Run `fn` as if answering a request: for tests of server functions (`ucm test`), no network involved. */
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
    enqueue, enqueueAfter, every, runJobs, table, withCall, withRequest, pendingCookies, startWorker, setSchedules,
  };
}

/** Types of `#ucm/server`, for editors and the checker (the runtime is generated from createServerApi above). */
const DECLARATIONS = `// generated by ucm — do not edit
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
 * (.ucm/data/sessions.sqlite); the cookie holds only a fresh, unguessable id.
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
 * like \`every("15m", sync)\`. ucm start / ucm dev run the jobs in the app's namespace, once per slot.
 */
export declare function every(spec: string, fn: () => unknown): RecurringJob;
/**
 * A typed, durable table, declared at the top level: \`export const users = table<User>("users")\`. ucm attaches the
 * row type's schema: writes are checked against it, and rows written under an older type are checked, migrated
 * with \`migrate\` (if given) or refused when read. Data lives in .ucm/data/store.sqlite.
 */
export declare function table<T>(name: string, opts?: { migrate?: (old: any) => T | Promise<T> }): Table<T>;
export interface Table<T> {
  readonly name: string;
  /** Store a new row; returns its id. */
  insert(value: T): Promise<string>;
  /** Store \`value\` under \`id\`, replacing what was there. */
  put(id: string, value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  /** Rows whose fields equal \`where\`'s (all rows if omitted), oldest first. */
  find(where?: Partial<T>): Promise<{ id: string; value: T }[]>;
  count(where?: Partial<T>): Promise<number>;
}
/** For tests: run the queued jobs that are due (all of them with \`{ all: true }\`), inline. */
export declare function runJobs(opts?: { all?: boolean }): Promise<{ done: number; failed: number }>;
/** Run \`fn\` as if answering a request, for tests of server functions: no network (sessions kept in memory). */
export declare function withRequest<T>(
  init: { method?: string; url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; ip?: string },
  fn: () => T | Promise<T>,
): Promise<{ value: T; setCookies: string[] }>;
`;

/** The generated `ucm-server.js` and `ucm-server.d.ts`. */
export function serverApiFiles(): { js: string; dts: string } {
  const js = `// generated by ucm — do not edit: the #ucm/server runtime
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
${codecSource().replaceAll("export ", "")}
${schemaCheckerSource()}
const api = (${createServerApi})({ AsyncLocalStorage, randomBytes, DatabaseSync, encode, decode, checkValue });
export const {
  HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, revokeSessions, rateLimit,
  enqueue, enqueueAfter, every, runJobs, table, withCall, withRequest, pendingCookies, startWorker, setSchedules,
} = api;
`;
  return { js, dts: DECLARATIONS };
}
