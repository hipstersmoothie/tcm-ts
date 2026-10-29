# Server functions

Server functions know who's calling. Importing anything from `#tcm/server` is also what puts a function on the
server; placement still needs no annotation.

```ts
import { session, setSession, clearSession, rateLimit, HttpError, request } from "#tcm/server";

export async function login(name: string, password: string): Promise<string> {
  if (!(await checkPassword(name, password))) throw new HttpError(401, "wrong name or password");
  rateLimit("login:" + request().ip, { max: 5, per: 60 });   // a 429 with Retry-After beyond that
  setSession({ user: name });                    // stored server-side; the cookie is just an id
  return name;
}
export async function me(): Promise<string> {
  const user = session().user;                   // unknown, expired or revoked sessions come back empty
  if (typeof user !== "string") throw new HttpError(401, "sign in first");
  return user;
}
```

The same module provides [tables and transactions](data.md) and [jobs](jobs.md).

## Request context

- **`request()`** gives the method, URL, `Headers`, cookies, client IP, and an `AbortSignal` that fires if the
  client disconnects. The context follows the call through any depth of `await`s (AsyncLocalStorage). Server
  components get the same context, both when they're fetched and when they render a page's first paint (the
  page's request; [React](react.md#cookies)).
- **`cookie(name)`, `setCookie`, `deleteCookie`.** Cookies default to `HttpOnly` and `SameSite=Lax`, and to
  `Secure` over TLS.

## Sessions

`session()`, `setSession(data)`, `clearSession()` and `revokeSessions(match)`.

- Session data lives server-side in `.tcm/data/sessions.sqlite`, apart from the codebase, and the cookie holds
  only an unguessable id.
- `setSession` issues a fresh id every time, which blocks session fixation.
- Sessions can be revoked: `revokeSessions((s) => s.user === "ada")` signs Ada out everywhere and returns how
  many sessions ended.

## Rate limits and errors

- **`rateLimit(key, { max, per })`** is a sliding window per key. Beyond the limit it throws a 429 with
  `Retry-After`.
- **`HttpError(status, message)` reaches the browser** as a rejected promise carrying `status` and the message.
- **Other errors are hidden in production.** Under `tcm start` the browser gets "internal error" and the server
  logs the full stack, so database errors and paths don't leak. `tcm dev` shows everything.

## Streaming

A server function can be an `async function*`, and browser code iterates it with `for await`, as if it were
local:

- chunks arrive as they're produced (newline-delimited JSON over one response);
- the request context, session included, lasts for the whole stream;
- `break` in the browser aborts the request, which stops the generator on the server.

## Plain HTTP endpoints

`tcm start <app> --http app.api` (or `tcm dev`) serves every function under `app.api` at `/api/…`, e.g.
`app.api.hooks.stripe` at `/api/hooks/stripe`, for webhooks and outside API clients. `--http ns=/prefix` picks
another prefix.

- A handler takes a standard `Request` and returns a `Response`, plain data (sent as JSON) or nothing (204).
- Names resolve on each request, so `tcm mv` moves a URL without a restart.
- These routes are for other callers, so they skip the CSRF checks. Check signatures (e.g. a webhook secret)
  in the handler.

## Testing

`withRequest(init, fn)` runs `fn` as if answering a request (`method`, `url`, `headers`, `cookies`, `ip`), with
sessions in memory, and returns its value plus the `Set-Cookie` headers it produced. See [testing](testing.md).
