# Web apps: no network boundary to write

```ts
// ucm: namespace app
import { readFileSync } from "node:fs";

export async function hostCount(): Promise<number> {       // uses node:fs → runs on the server
  return readFileSync("/etc/hosts", "utf8").split("\n").length;
}
export const render = (n: number) => `hosts: ${n}`;        // runs anywhere
export async function main() {                             // uses document → runs in the browser
  document.querySelector("#app")!.textContent = render(await hostCount());
}
```

`ucm dev app.main` serves this through Vite 8. Nothing is annotated: there's no `"use server"`, no routes, no
fetch calls and no API layer. `ucm update` in another shell hot-reloads the browser. For production, see
[production](production.md).

## How placement is inferred

`ucm view` shows the placement of every definition, and why.

- A definition runs **on the server** if it uses Node (`node:*`, `process`, `Buffer`, a server-only npm
  package), uses [`#ucm/server`](server-api.md), or uses something that does and can't be called remotely.
- It runs **in the browser** if it uses the DOM.
- Otherwise it runs **anywhere**: pure code runs where it's called.
- An **async** server function is a cut point. Browser code calling it gets a stub that calls it by hash
  (`POST /__ucm/rpc/<hash>`), and the code around the call stays in the browser.
- A **synchronous** server function used from the browser is an error that names it ("Make app.machine
  async"), because a network call can't be synchronous.
- Server-only npm packages are found by a heuristic: no browser build, and an entry that imports Node builtins.

## What this guarantees

- **Server code never reaches the browser.** The Vite plugin swaps whole server components for stubs before
  they're resolved.
- **The browser can call only the app's own server functions.** The endpoint surface is exactly the server
  functions the app calls, listed when `ucm dev` starts. Anything else, and cross-origin calls, are refused.
- **No client/server version skew.** Calls go by hash, as Unison's typed service calls do, and a hash never
  changes meaning.
- **Testable in one process:** under `ucm test` everything runs locally ([testing](testing.md)).

## Plain data crosses the wire

JSON plus `Date`, `Map`, `Set`, `BigInt`, `undefined`, `NaN`/`±Infinity` and `-0`. Functions, class instances,
symbols and cycles are refused with a message saying what couldn't be sent, rather than silently turning into
`{}`. The browser and the server share one codec (`packages/cli/src/codec.ts`).

## Arguments are checked against the parameter types

A server function the browser can call is a public endpoint, and TypeScript types are gone at runtime. So ucm
derives a runtime schema from each server function's parameters (objects, arrays, tuples, unions, literals,
dates, maps, sets, recursive types). Calls with wrong types, missing fields, unexpected extra fields, or too many
arguments are refused with a 400 that says what's wrong, before the function runs.

## CSRF

Server functions read cookies, so calls must be same-origin, must not be cross-site (`Sec-Fetch-Site`), and
must send JSON, which rules out plain HTML form posts. [HTTP routes](server-api.md#plain-http-endpoints) are
for other callers and skip these checks.

## Module-level state is placed by who uses it

That follows from inference, not annotation, and every app report shows it:

- **Server state:** `const visits = new Map()` used only by server functions has one copy, shared by every
  client.
- **Browser state:** used only by browser code, each tab has its own copy.
- **Used by both sides:** the server and every tab silently get separate copies, so ucm warns.

Only fresh mutable objects count (`new …`, `[]`, `{}`); `as const`, frozen and computed values don't. For state
that must survive restarts, use a [table](data.md).
