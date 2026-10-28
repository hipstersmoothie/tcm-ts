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
import { createHmac, timingSafeEqual } from "node:crypto";

export function createServerApi(deps: { AsyncLocalStorage: typeof AsyncLocalStorage; createHmac: typeof createHmac; timingSafeEqual: typeof timingSafeEqual }) {
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
    secret: string;
    secure: boolean;
  }
  const storage = new deps.AsyncLocalStorage<CallContext>();
  const SESSION_COOKIE = "ucm_session";

  const context = (what: string): CallContext => {
    const c = storage.getStore();
    if (!c) throw new Error(`${what} only works inside a server function called from the browser (ucm dev / ucm start)`);
    return c;
  };

  /** A failure meant for the caller: its status and message reach the browser (other errors are hidden in production). */
  class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "HttpError";
      this.status = status;
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

  // sessions: data in a cookie, signed so the browser can't forge it
  const sign = (payload: string, secret: string) => deps.createHmac("sha256", secret).update(payload).digest("base64url");
  const session = (): Record<string, unknown> => {
    const c = context("session()");
    const raw = c.request.cookies[SESSION_COOKIE];
    const dot = raw ? raw.lastIndexOf(".") : -1;
    if (!raw || dot < 0) return {};
    const [payload, mac] = [raw.slice(0, dot), raw.slice(dot + 1)];
    const expected = Buffer.from(sign(payload, c.secret));
    const got = Buffer.from(mac);
    if (got.length !== expected.length || !deps.timingSafeEqual(got, expected)) return {};
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { d: Record<string, unknown>; exp: number };
      return data.exp > Date.now() ? data.d : {};
    } catch {
      return {};
    }
  };
  const setSession = (data: Record<string, unknown>, maxAge = 30 * 24 * 3600) => {
    const c = context("setSession()");
    const payload = Buffer.from(JSON.stringify({ d: data, exp: Date.now() + maxAge * 1000 })).toString("base64url");
    setCookie(SESSION_COOKIE, `${payload}.${sign(payload, c.secret)}`, { maxAge });
  };
  const clearSession = () => deleteCookie(SESSION_COOKIE);

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

  /** For the RPC host: run one call inside its request's context; reports the Set-Cookie headers it produced. */
  const withCall = async <T>(
    call: { method: string; url: string; headers: Record<string, string | string[] | undefined>; ip: string | undefined; signal: AbortSignal },
    opts: { secret: string; secure: boolean },
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T; setCookies: string[] } | { ok: false; error: unknown; setCookies: string[] }> => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(call.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const ctx: CallContext = {
      request: { method: call.method, url: call.url, headers, cookies: parseCookies(headers.get("cookie")), ip: call.ip, signal: call.signal },
      setCookies: [],
      secret: opts.secret,
      secure: opts.secure,
    };
    try {
      return { ok: true, value: await storage.run(ctx, fn), setCookies: ctx.setCookies };
    } catch (error) {
      return { ok: false, error, setCookies: ctx.setCookies };
    }
  };

  /** Run `fn` as if answering a request: for tests of server functions (`ucm test`), no network involved. */
  const withRequest = async <T>(
    init: { method?: string; url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; secret?: string },
    fn: () => T | Promise<T>,
  ): Promise<{ value: T; setCookies: string[] }> => {
    const cookieHeader = Object.entries(init.cookies ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const headers = { ...(init.headers ?? {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) };
    const r = await withCall(
      { method: init.method ?? "POST", url: init.url ?? "/", headers, ip: "127.0.0.1", signal: new AbortController().signal },
      { secret: init.secret ?? "test-secret", secure: false },
      async () => fn(),
    );
    if (!r.ok) throw r.error;
    return { value: r.value, setCookies: r.setCookies };
  };

  return { HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, withCall, withRequest };
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
  constructor(status: number, message: string);
}
/** The HTTP request this server function is answering. */
export declare function request(): ServerRequest;
export declare function cookie(name: string): string | undefined;
export declare function setCookie(name: string, value: string, opts?: CookieOptions): void;
export declare function deleteCookie(name: string, opts?: { path?: string }): void;
/** The caller's session data (empty if none, expired, or tampered with). */
export declare function session(): Record<string, unknown>;
/** Replace the session data; it lives in a signed, HttpOnly cookie for \`maxAge\` seconds (default 30 days). */
export declare function setSession(data: Record<string, unknown>, maxAge?: number): void;
export declare function clearSession(): void;
/**
 * Run \`fn\` as if answering a request, for tests of server functions: no network involved. Pass the same
 * \`secret\` to calls that should share a session (default "test-secret").
 */
export declare function withRequest<T>(
  init: { method?: string; url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; secret?: string },
  fn: () => T | Promise<T>,
): Promise<{ value: T; setCookies: string[] }>;
`;

/** The generated `ucm-server.js` and `ucm-server.d.ts`. */
export function serverApiFiles(): { js: string; dts: string } {
  const js = `// generated by ucm — do not edit: the #ucm/server runtime
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
const api = (${createServerApi})({ AsyncLocalStorage, createHmac, timingSafeEqual });
export const { HttpError, request, cookie, setCookie, deleteCookie, session, setSession, clearSession, withCall, withRequest } = api;
`;
  return { js, dts: DECLARATIONS };
}

/** Names `#ucm/server` exports to server functions (withCall is for the host). */
export const SERVER_API_EXPORTS = ["HttpError", "request", "cookie", "setCookie", "deleteCookie", "session", "setSession", "clearSession", "withRequest"];
