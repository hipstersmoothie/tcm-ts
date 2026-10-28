# #ucm/server reference

Everything server code can import from `#ucm/server`. Importing any of it makes a function run on the server
(see [web apps](apps.md)). For how these fit together, see the guides: [server functions](server-api.md),
[data](data.md), [background jobs](jobs.md).

```ts
import { request, session, setSession, table, enqueue, HttpError } from "#ucm/server";
```

## Requests

```ts
function request(): ServerRequest;

interface ServerRequest {
  method: string;
  url: string;
  headers: Headers;
  cookies: Record<string, string>;
  ip: string | undefined;   // the client's address, as the socket sees it
  signal: AbortSignal;      // aborted when the client disconnects
}
```

The request the current server function is answering. It's available anywhere in the call, through any number of
`await`s. Outside a request (a job, a test without `withRequest`) it throws.

## Cookies

```ts
function cookie(name: string): string | undefined;
function setCookie(name: string, value: string, opts?: CookieOptions): void;
function deleteCookie(name: string, opts?: { path?: string }): void;

interface CookieOptions {
  maxAge?: number;          // seconds
  path?: string;
  httpOnly?: boolean;       // default true: not readable by browser scripts
  secure?: boolean;         // default true when served over TLS
  sameSite?: "Strict" | "Lax" | "None";   // default "Lax"
}
```

## Sessions

```ts
function session(): Record<string, unknown>;
function setSession(data: Record<string, unknown>, maxAge?: number): void;
function clearSession(): void;
function revokeSessions(match: (data: Record<string, unknown>) => boolean): number;
```

- `session()` is the caller's session data: empty if they have none, or it expired or was revoked.
- `setSession(data)` starts a new session (default 30 days). The data stays on the server
  (`.ucm/data/sessions.sqlite`); the cookie holds only a fresh, unguessable id, so a new id on every sign-in
  prevents session fixation.
- `revokeSessions(match)` ends every session whose data matches, e.g. `revokeSessions((s) => s.user === "ada")`
  signs Ada out everywhere. Returns how many ended.

## Errors and limits

```ts
class HttpError extends Error {
  constructor(status: number, message: string, opts?: { retryAfter?: number });
  readonly status: number;
  readonly retryAfter?: number;   // seconds, sent as Retry-After
}

function rateLimit(key: string, opts: { max: number; per: number }): void;
```

- Throw an `HttpError` to fail a call on purpose: the browser's promise rejects with its `status` and `message`.
  Any other error reaches the browser as "internal error" in production (it's logged on the server), and in full
  under `ucm dev`.
- `rateLimit(key, { max, per })` allows `max` calls per `per` seconds for `key` (e.g. `"login:" + request().ip`),
  and throws a 429 with `Retry-After` beyond that.

## Tables

```ts
function table<T>(name: string, opts?: TableOptions<T>): Table<T>;

interface Table<T> {
  readonly name: string;
  insert(value: T): Promise<string>;                 // returns the new row's id
  put(id: string, value: T): Promise<void>;          // store under id, replacing what was there
  get(id: string): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  update(id: string, fn: (current: T) => T): Promise<T | undefined>;   // atomic read-modify-write
  find(where?: Partial<T>, opts?: FindOptions<T>): Promise<{ id: string; value: T }[]>;
  findOne(where?: Partial<T>, opts?: Omit<FindOptions<T>, "limit">): Promise<{ id: string; value: T } | undefined>;
  count(where?: Partial<T>): Promise<number>;
}

interface TableOptions<T> {
  migrate?: ((old: any) => T | Promise<T>) | readonly ((old: any) => unknown)[];
  unique?: readonly (keyof T & string)[];
  index?: readonly (keyof T & string)[];
  renamedFrom?: string;
}

interface FindOptions<T> {
  orderBy?: keyof T & string;
  desc?: boolean;
  limit?: number;
  offset?: number;
}
```

Declare a table at the top level: `export const users = table<User>("users")`. Rows are checked against `T` on
every write, and rows stored as an older version of `T` are checked, migrated or refused when read. `find`
returns rows whose fields equal `where`'s, oldest first unless ordered. See [data](data.md) for migrations,
indexes and the rest.

## Transactions

```ts
function transaction<R>(fn: () => R | Promise<R>): Promise<R>;
```

All of `fn`'s table writes happen, or, if it throws, none do. Other requests' table calls wait while it runs. Jobs
enqueued inside are queued when it commits and dropped if it rolls back. Nested calls are savepoints. Keep it
short, and don't await anything inside that itself needs a table from outside it.

## Background jobs

```ts
function enqueue<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): string;
function enqueueAfter<A extends unknown[]>(seconds: number, fn: (...args: A) => unknown, ...args: A): string;
function every(spec: string, fn: () => unknown): RecurringJob;
```

- `enqueue(fn, ...args)` runs `fn(...args)` in the background, soon, with up to 5 attempts and exponential
  backoff, and returns the job's id. `fn` must be a codebase function (it's recorded by hash, so the job runs the
  version that queued it), and the arguments plain data.
- `enqueueAfter(seconds, fn, ...args)` waits first.
- `export const nightly = every("0 3 * * *", cleanup)` is a recurring job: five cron fields in UTC, or an interval
  like `"15m"` (`s`, `m`, `h`, `d`). `ucm start` and `ucm dev` run the recurring jobs in the app's namespace, once
  per slot however many servers there are.

## For tests

```ts
function withRequest<T>(
  init: { method?: string; url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; ip?: string },
  fn: () => T | Promise<T>,
): Promise<{ value: T; setCookies: string[] }>;

function runJobs(opts?: { all?: boolean }): Promise<{ done: number; failed: number }>;
```

- `withRequest(init, fn)` runs `fn` as if answering a request, with no network: sessions are kept in memory, and
  the cookies it set come back in `setCookies` (pass them in `cookies` to continue the session).
- `runJobs()` runs the queued jobs that are due, inline; `{ all: true }` runs every queued job.

Under `ucm test`, tables and jobs live in memory. See [testing](testing.md).
