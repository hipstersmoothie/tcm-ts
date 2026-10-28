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

export function createServerApi(deps: { AsyncLocalStorage: typeof AsyncLocalStorage; randomBytes: typeof randomBytes; DatabaseSync: typeof DatabaseSync }) {
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
    request: ServerRequest;
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

  const request = (): ServerRequest => context("request()").request;
  const cookie = (name: string): string | undefined => context("cookie()").request.cookies[name];

  const setCookie = (name: string, value: string, opts: CookieOptions = {}) => {
    const c = context("setCookie()");
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
    const id = c.request.cookies[SESSION_COOKIE];
    if (!id) return undefined;
    const row = store(c).prepare("SELECT data, expires FROM sessions WHERE id = ?").get(id) as { data: string; expires: number } | undefined;
    if (!row || row.expires <= Date.now()) return undefined;
    return { id, data: JSON.parse(row.data) as Record<string, unknown> };
  };
  const session = (): Record<string, unknown> => sessionRow(context("session()"))?.data ?? {};
  const setSession = (data: Record<string, unknown>, maxAge = 30 * 24 * 3600) => {
    const c = context("setSession()");
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
    const c = context("clearSession()");
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

  return { HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, revokeSessions, rateLimit, withCall, withRequest, pendingCookies };
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
const api = (${createServerApi})({ AsyncLocalStorage, randomBytes, DatabaseSync });
export const { HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, revokeSessions, rateLimit, withCall, withRequest, pendingCookies } = api;
`;
  return { js, dts: DECLARATIONS };
}
