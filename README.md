# ucm-ts

[Unison](https://www.unison-lang.org)'s codebase model for plain TypeScript. Definitions are stored by the
hash of their syntax tree, and names are only pointers to hashes. So renames are free, nothing gets rebuilt,
and two versions of a dependency can live side by side. You don't need new syntax: any erasable TypeScript
file works as input, and Node runs the result directly through its built-in type stripping.

Requires Node ≥ 22.18 (tested on 24.15). The only dependency is `typescript@6`, which is used for parsing
and typechecking.

```sh
# from a checkout: build the npm package and install it globally
pnpm install && pnpm build
npm install -g "$(cd dist/package && npm pack --silent)"   # binaries: ucm and ucm-ts

# or, while hacking on ucm itself, run the TypeScript source directly
alias ucm="node $PWD/packages/cli/bin/ucm.js"

mkdir demo && cd demo
ucm init          # .ucm/codebase.sqlite, package.json "#codebase" imports, tsconfig, scratch.ts
ucm               # watch: typecheck + hash scratch files, evaluate bare expressions
ucm add           # save new definitions from scratch.ts
```

## The workflow

A scratch file is ordinary TypeScript, and `node scratch.ts` runs it as is. Saved definitions are imported
through a generated shim:

```ts
// ucm: namespace lib
import { square } from "#codebase";            // root namespace
import { sortWith } from "#codebase/lib";       // namespace lib
import { basename } from "node:path";           // builtins and npm packages work as usual

export const sumSquares = (xs: number[]) => xs.map(square).reduce((a, b) => a + b, 0);

sumSquares([1, 2, 3])                           // watch expression: the watcher prints 14
```

| Command | |
|---|---|
| `ucm` / `ucm check [file]` | report each definition as `new` / `identical` / `update` / `alias` / `conflict`, then evaluate watch expressions |
| `ucm add` / `ucm update` | save. `update` re-points names and re-hashes every dependent; dependents that stop typechecking keep their old hash and go to `todo` |
| `ucm import <dir> [--into ns]` | add an existing project. Each file becomes a namespace (`core/src/analyze.ts` → `core.analyze`); imports between files, barrels and workspace packages resolve to hashes; test files are skipped |
| `ucm migrate` | rebuild a codebase written with an older hash format. Every stored definition is re-rendered against its migrated dependencies and re-hashed; names, history, branches, patches, todo and remotes carry over; the old `.ucm` is kept as a backup |
| `ucm dev <app>` / `ucm build <app>` / `ucm start <app>` | browser apps with server functions called by hash (see below): develop with hot reload, build immutably, serve in production, where moving the app's name deploys or rolls back |
| `ucm test [namespace] [--fresh]` | run tests: definitions named `test…` (or under a `tests` namespace) that pass by returning without throwing. A test's hash covers everything it calls, so results are cached by hash and Node version, and only tests whose code or dependencies changed re-run. The watcher runs tests from the scratch file inline. Tests that read the filesystem, clock or network can go stale in the cache; use `--fresh` |
| `ucm verify` | re-render every live definition from the store and re-hash it. This must be the identity |
| `ucm view`, `ls`, `find`, `deps`, `dependents`, `docs` | browse. Code is rendered with the *current* names |
| `ucm run <name> [args]` | run a definition. Functions are called with the args, and the result is awaited and printed |
| `ucm mv`, `alias`, `rm`, `resolve` | name operations. They never touch code |
| `ucm edit <name>...` | write definitions to a scratch file, with references following any updates. Names can span namespaces; a definition whose path isn't `<namespace>.<declared name>` gets a `// ucm: path a.b.c` comment, so `update` binds it back to the same path. You can write those comments yourself too |
| `ucm todo` | conflicts, plus dependents that need fixing after an update |
| `ucm diff [<id> \| <branch> \| <a> <b>]` | review changes by meaning: what the last command changed (or since a history entry, or between branches). Edits are shown as line diffs with each side's own names. Definitions re-hashed only because a dependency changed are listed separately, with what triggered them. Renames and aliases are recognized as such, and renaming locals or reformatting doesn't count as a change |
| `ucm remote add <name> <url\|dir> [--token t]` | a `ucm serve` URL or another codebase directory |
| `ucm push` / `ucm pull [remote] [branch]` | sync by hash: only components the other side lacks are sent. `pull` mirrors into `origin/main`. It fast-forwards your branch if you haven't changed it, and merges otherwise. `push` refuses if the remote moved since your last sync |
| `ucm merge <branch>` | three-way merge of names, against the other branch as of the last merge, sync or fork. A name changed on one side takes that side; changed differently on both sides, it becomes a conflict (`ucm todo`, `ucm resolve`). A definition only re-hashed because a dependency moved doesn't count as a change. Each one-sided update is a patch, so the other side's code is re-derived against it; what no longer typechecks goes to `todo` |
| `ucm run <name> [args] --on <remote>` | send the definition's missing closure, run it there, and stream stdout/stderr back |
| `ucm serve [--port] [--host] [--token] [--no-run] [--tls]` | serve this codebase over HTTP(S). It requires a token, and clients can run code unless `--no-run`. `--tls` uses `--tls-cert`/`--tls-key`, or a self-signed certificate it creates, and prints the certificate's fingerprint. Clients pin it with `ucm remote add … --fingerprint`, and the token is only written after the pin checks out. Serving beyond localhost without TLS is refused unless `--insecure` |
| `ucm history`, `reset <id>`, `branch`, `switch` | reflog, undo, and branches of the namespace |

## How it works

- **Dynamic `import("pkg")`** of a package or Node builtin is pinned like a static import, so it's still
  content-addressed. Lazy imports of local files or codebase modules are rejected. A computed specifier
  (`import(url)`) is allowed with a warning, because it loads code the codebase doesn't track.
- **Definitions** are top-level `function`s (overloads included), `const`s, `class`es, `type`s and `interface`s.
  Top-level destructuring (`const { a, b: [c] } = init()`) binds one definition per name; the bindings share
  the statement, so it still runs once. A type and a value can share a name, like TypeScript's own type and value spaces (`const User = z.object(…)`
  with `type User = z.infer<typeof User>`). Each half is its own definition, updated, diffed and merged
  independently. The `#codebase` shim exports both under the one name.
  Classes hash as one unit. In scratch files, top-level `let`/`var`, enums, namespaces, decorators and
  `declare` are rejected with a reason. `ucm import` accepts most of them, because existing code uses them (see
  [Importing existing projects](#importing-existing-projects)).
- **Hashing** (`packages/core/src/canonicalize.ts`): every definition is lowered to an S-expression IR built
  from syntax-kind *names*, not numbers, with every child labelled by its slot (`name`, `body`, …).
  - Comments, formatting and `export` are dropped.
  - Literals are normalized: `1_000` = `0x3e8`, and `'a'` = `"a"`.
  - Locals become de Bruijn levels, so renaming a local doesn't change the hash.
  - Every identifier is resolved through the type checker. A reference to another definition becomes
    `Ref <hash>`, an npm import becomes `Ext npm:<pkg>@<exact version>`, and a global becomes `G name`.
  - Property names stay structural.
  - Type annotations are part of the hash.
  - Mutually recursive definitions are hashed as a cycle (Tarjan SCC + Unison-style ordering), including
    cycles that span files.
  - **Identity is preserved.** In JavaScript every declaration has its own identity: `new Map()` twice is two
    maps, and two identical classes fail each other's `instanceof`. So every function, class and value is
    hashed with a *lineage salt*, the codebase path where it was first added. Updates and renames reuse the
    existing salt, so renames stay free and re-adding the same file reproduces the same hashes. Identical code
    added at two paths is two definitions. Types have no runtime identity and stay unsalted, so they still
    deduplicate.
  - **Names are hashed exactly where JavaScript can observe them** (`.name`): function and class
    declarations, `const f = () => …`, and local functions or bindings that name an anonymous function
    (`function helper() {}`, `(cb = () => {}) =>`). Generated code keeps these names, so `ucm mv` changes the
    codebase path but not `.name`. All other locals and parameters stay alpha-renamable.
  - **The format is frozen at IR v5.** `packages/core/test/golden.test.ts` pins the hashes of a corpus that
    covers most syntax. `pnpm compare-ts 5.8` re-hashes the repo and the corpus on another TypeScript
    version: 5.8.3, 5.9.3 and 6.0.3 produce identical hashes.
- **Storage** (`packages/store`): `node:sqlite`. It holds definitions (IR, original source text, spans of
  every reference), dependency edges, signatures, docs, names per branch, a name log, patches and todo.
- **Execution** (`packages/loader`): each component becomes `.ucm/cache/<hash>.ts`, with the current names
  spliced into the stored source and `import { h_<hash> as name } from "./<hash>.ts"` for dependencies.
  - npm dependencies are installed under per-version aliases (`npm__pkg__1.2.3`), so pinned versions coexist.
  - Node runs these files with no build step and no loader hooks.
  - The cache and the `.ucm/codebase` shim are derived data: both are rebuilt from the database.

**Sync never trusts the sender.** Received definitions are checked before anything is stored:
- each component must arrive complete;
- every reference must resolve;
- rendering, typechecking and hashing locally must reproduce the claimed hashes.

Dependencies and signatures are recomputed locally. Nothing received is executed during checking, and npm
installs use `--ignore-scripts`. Tampered source sent under an existing hash is rejected; `sync.test.ts`
checks this.

**Compiler options** come from the project's `tsconfig.json`: `lib`, strictness, `types` and so on are the
project's choice. A few options are forced, with a warning when the project sets them otherwise:
- `module`/`moduleResolution` NodeNext, which import classification and `#codebase` rely on;
- `verbatimModuleSyntax` and `erasableSyntaxOnly`, which Node's type stripping needs;
- `allowImportingTsExtensions` and `noEmit`.

`ucm import <dir>` uses the tsconfig nearest that directory, with bundler resolution (extensionless and
directory imports work) and without the stripping requirements. Emit options (`declaration`,
`isolatedDeclarations`, `composite`, …) are dropped. Each definition records the strictness, `lib` and `target`
it was checked with, and is re-checked under those later (`verify`, `update`, `receive`). Options never affect
hashes, only what typechecks.

## Importing existing projects

`ucm import <dir> --into ns [--exclude a,b]` takes a project as it is. These have been imported, verified
(every definition renders and re-hashes to itself) and run from a scratch file:

| project | definitions | notes |
|---|---|---|
| neverthrow | 51 | `strict: false`, kept as its check profile |
| ts-pattern | 247 | namespace imports (`P.infer<…>`), `declare const` |
| valibot (`library/src`, `--exclude vitest`) | 941 | 573 files in 4s; module state, `@ts-expect-error` above overloads |

What import mode accepts beyond scratch files:

- **Enums, namespaces and parameter properties.** Node can't strip these, so their cache modules start with
  `// ucm: transform` and are compiled by a module hook when loaded. They hash like any other syntax.
- **Namespace imports of project modules.** `import * as ns from "./mod"` with `ns.member` is a reference to
  `member`, hashed exactly as if it had been imported by name. Using `ns` as a value is still refused.
- **`declare const x: unique symbol`**, the usual brand pattern, is a type-only definition. It's salted like a
  term, so two identical declarations are still two distinct symbols.
- **Top-level `let`** is module state (a lazy cache, a config cell). It's salted, so each declaration is its
  own cell. Every definition that assigns to it shares its component (one module), because an imported
  binding is read-only. Readers import it and see live updates.
- **`// @ts-expect-error` and `// @ts-ignore`** directly above a declaration stay with it. Like other comments
  they aren't hashed, but they decide whether it typechecks.

Still refused: `declare module`/`declare global`, `import x = require()`, decorators, and top-level statements.

**Packaging:** Node won't strip types from files under `node_modules`, so `pnpm build` (`scripts/build.ts`)
transpiles the workspace into one plain-JavaScript package, `ucm-ts`, in `dist/package`. Code ucm
generates (`.ucm/cache`) stays TypeScript, because it lives in your project. `pnpm test:package` packs and
installs that package, then runs the whole test suite against the installed copy. The binary is also
available as `ucm-ts`, since Unison's own CLI is called `ucm` too.

Tests: `pnpm test` runs the hashing invariants, the frozen golden hashes and an end-to-end CLI scenario.
`pnpm typecheck` checks the repo.

## Browser apps: no network boundary to write

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
fetch calls and no API layer.

**How placement is inferred** (`ucm view` shows it for every definition):
- A definition runs **on the server** if it uses Node (`node:*`, `process`, `Buffer`, a server-only npm package),
  or uses something that does and can't be called remotely.
- It runs **in the browser** if it uses the DOM.
- Otherwise it runs **anywhere**.
- An **async** server function is a cut point. Browser code calling it gets a stub that calls it by hash, and
  the code around the call stays in the browser.
- A **synchronous** server function used from the browser is an error that names it ("Make app.machine
  async"), because a network call can't be synchronous.

**What this guarantees:**
- **Server code never reaches the browser.** The Vite plugin swaps whole server components for stubs before
  they're resolved.
- **The browser can call only the app's own server functions.** The endpoint surface is exactly the server
  functions the app calls, listed when `ucm dev` starts. Anything else, and cross-origin calls, are refused.
- **No client/server version skew.** Calls go by hash, as Unison's typed service calls do, and a hash never
  changes meaning.
- **Plain data crosses the wire:** JSON plus `Date`, `Map`, `Set`, `BigInt` and `undefined`. Anything else is
  refused with a message.
- **Hot reload:** `ucm update` in another shell reloads the browser.
- **Testable in one process:** in `ucm test` everything runs locally, the counterpart of Unison's local
  `Remote` handler.

**Server functions know who's calling.** `#ucm/server` gives them their request's context:

```ts
import { session, setSession, clearSession, rateLimit, HttpError, request } from "#ucm/server";

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

- **`request()`** gives the method, URL, `Headers`, cookies, client IP, and an `AbortSignal` that fires if
  the client disconnects. The context follows the call through any depth of `await`s.
- **`setCookie` / `deleteCookie`.** Cookies default to `HttpOnly` and `SameSite=Lax`, and to `Secure` over TLS.
- **`session` / `setSession` / `clearSession` / `revokeSessions(match)`.** Session data lives server-side in
  `.ucm/data/sessions.sqlite`, apart from the codebase, and the cookie holds only an unguessable id.
  `setSession` issues a fresh id every time, which blocks session fixation. Sessions can be revoked, e.g.
  `revokeSessions((s) => s.user === "ada")` signs Ada out everywhere. `.ucm/data` and secrets are gitignored.
- **`rateLimit(key, { max, per })`** is a sliding window per key. Beyond the limit it throws a 429 with
  `Retry-After`.
- **`HttpError(status, message)` reaches the browser** as a rejected promise carrying `status` and the
  message.
- **Other errors are hidden in production.** Under `ucm start` the browser gets "internal error" and the server
  logs the full stack, so database errors and paths don't leak. `ucm dev` shows everything.
- **`withRequest(init, fn)` runs a server function as if answering a request,** so `ucm test` can test login
  flows with no server running.
- **Placement still needs no annotation.** Using `#ucm/server` is what puts a function on the server.
- **Streaming.** A server function can be an `async function*`, and browser code iterates it with
  `for await`, as if it were local:
  - chunks arrive as they're produced (newline-delimited JSON over one response);
  - the request context, session included, lasts for the whole stream;
  - `break` in the browser aborts the request, which stops the generator on the server.
- **Plain HTTP endpoints, routed by name.** `ucm start <app> --http app.api` (or `ucm dev`) serves every
  function under `app.api` at `/api/…`, e.g. `app.api.hooks.stripe` at `/api/hooks/stripe`, for webhooks and
  outside API clients:
  - a handler takes a standard `Request` and returns a `Response`, plain data (sent as JSON) or nothing (204);
  - names resolve on each request, so `ucm mv` moves a URL without a restart;
  - these routes are for other callers, so they skip the CSRF checks. Check signatures (e.g. a webhook secret)
    in the handler.
- **Typed tables that never silently disagree with your code.** For example:

  ```ts
  export type User = { name: string; email: string; joined: Date };
  export const users = table<User>("users");          // declared at the top level
  await users.insert({ name: "ada", email: "ada@x", joined: new Date() });
  await users.find({ name: "ada" });                    // also get / put / delete / count
  ```

  Options cover how the data evolves and how it's queried:

  ```ts
  export const users = table<User>("users", {
    migrate: [fromV1, fromV2],   // one step per earlier row type, picked by its parameter type
    unique: ["email"],           // a duplicate write fails with a 409
    index: ["plan"],             // find({ plan: "pro" }) uses an index
    renamedFrom: "members",      // the old table's rows move over
  });
  await users.find({ plan: "pro" }, { orderBy: "joined", desc: true, limit: 10 });
  await users.findOne({ email });
  await users.update(id, (u) => ({ ...u, logins: u.logins + 1 }));   // atomic read-modify-write
  await transaction(async () => {                                      // several rows, all or nothing
    await accounts.put(from, { ...a, balance: a.balance - amount });
    await accounts.put(to, { ...b, balance: b.balance + amount });
  });
  ```

  TypeScript erases `User` at runtime, but ucm sees it where the table is declared. It derives a schema from
  it and attaches that schema, with its hash, to the table.
  - **Writes are checked** against `User`. Each row records the schema it was written with, in
    `.ucm/data/store.sqlite`. Dates, maps and sets round-trip.
  - **When `User` changes,** each stored row is checked as it's read:
    - rows that still fit the new type (e.g. a new optional field) just work;
    - rows that don't are converted by `migrate`, the result is checked, and the upgraded row is written back.
      `migrate` is one function, or a chain of typed steps, oldest first:
      `[(old: V1) => V2, (old: V2) => User]`. ucm records each step's parameter type, and a row goes through the
      first step whose parameter it fits, then the later ones, until it fits `User`. Type changes accumulate
      without one function having to handle every past shape;
    - with no `migrate`, reading refuses with the reason, never returning the wrong shape.
  - **`ucm update` reports this up front.** It checks the stored rows the moment the type changes and says
    whether they fit, will be migrated (some step takes them), or need a step first. It also reports stored
    duplicates that would break a new `unique` field.
  - **`ucm data migrate <table>` migrates every row now** through the current code, rather than as rows are
    read. Afterwards it says whether `migrate` still has work: once every row has the current type, it can be
    removed. Keep it while an older build that writes the old type is still serving.
  - **Old pages reload instead of misreading.** A page from an older build (old builds keep serving) that reads
    rows written by newer code gets a 410, and its browser reloads onto the current version.
  - **Queries.** `find(where, { orderBy, desc, limit, offset })`, `findOne` and `count`. `unique` and `index`
    fields get SQLite expression indexes. When every row has the current type (e.g. after `ucm data migrate`),
    filtering, ordering and paging run in SQL. Otherwise rows of older types are read through `migrate` first,
    so results never depend on whether a row was migrated yet.
  - **`update(id, fn)`** is atomic: `fn` is synchronous and runs while the row is locked.
  - **`transaction(async () => { … })`** makes any number of reads and writes, across tables, all or nothing:
    a throw rolls them all back. Every request shares one SQLite connection, so a transaction holds the store
    for as long as it runs. Table calls inside it run in it, and other requests' table calls wait until it
    commits. Nobody sees a debit without its credit. Jobs enqueued inside are queued on commit and dropped on
    rollback, so a failed signup doesn't send its welcome email. A transaction inside a transaction is a
    savepoint. Keep transactions short, and don't await anything inside one that itself waits on a table
    (such as a request to your own server): it would wait forever. The lock is per process. Another process
    using the same store, such as `ucm data migrate` while the app serves, is kept out by SQLite's write lock
    instead: it waits up to 5 seconds for a transaction to finish, then fails with "database is locked".
  - `ucm data` lists tables and row counts, and `ucm data <table>` shows rows. Tables live in memory under
    `ucm test`.
- **Background jobs.** `enqueue(sendWelcome, user.id)` from a server function returns at once; the work runs
  in the background.
  - **Durable.** Jobs live in `.ucm/data/jobs.sqlite` and survive restarts. A worker inside `ucm start` and
    `ucm dev` runs them, with 5 attempts and exponential backoff by default, and records the last error.
    `enqueueAfter(seconds, fn, …)` delays one.
  - **Queued by hash, like Unison shipping a computation.** A job records the exact code version that enqueued
    it, so a deploy between enqueue and run doesn't change what it does. The function must be a codebase
    definition, and its arguments plain data.
  - **Safe with several servers.** A claim is one atomic update with a lease, so several `ucm start` processes
    can share the queue, and a crashed worker's job is picked up again when its lease expires.
- **Scheduled jobs.** `export const nightly = every("0 3 * * *", cleanup)` uses five cron fields in UTC, or an
  interval like `every("15m", sync)`.
  - **Found statically.** `ucm start` and `ucm dev` find these in the app's namespace from the code itself, with
    no registration, and moving a name reschedules them.
  - **Each slot runs once,** however many servers share the codebase.
  - **New schedules don't fire on their first deploy.** After downtime, an interval schedule catches up once.
- **Managing jobs.** `ucm jobs` lists the queue; `ucm jobs retry <id>` and `ucm jobs cancel <id>` act on one.
  In tests, `runJobs()` drains the queue inline.
- **CSRF.** Server functions read cookies, so calls must be same-origin, must not be cross-site
  (`Sec-Fetch-Site`), and must send JSON, which rules out plain HTML form posts.

**Arguments are checked against the parameter types.** A server function the browser can call is a public
endpoint, and TypeScript types are gone at runtime. So ucm derives a runtime schema from each server function's
parameters (objects, arrays, tuples, unions, literals, dates, maps, sets, recursive types). Calls with wrong
types, missing fields, unexpected extra fields, or too many arguments are refused with a 400 that says
what's wrong, before the function runs.

**Production: deploy and roll back by moving a name.**
- `ucm build <app>` writes an immutable, content-addressed build to `.ucm/apps/<app hash>/`. Its assets are
  served under `/_app/<hash>/`.
- `ucm start <app>` serves the build the app's name points to now. When the name moves (`ucm update`, `mv`,
  `reset`, `pull`), it builds the new version if needed and switches to it, so deploying and rolling back are
  both moving a name, like Unison's service names pointing at service hashes.
- **There is no version skew.** Earlier builds stay served, and their server functions stay callable. A tab
  opened before a deploy keeps loading its own assets and calling the exact code it was built against, until
  it reloads. `prod.test.ts` deploys v2 and checks the v1 tab still works, then rolls back.
- **`ucm apps` lists builds; `ucm apps prune --keep N` removes old ones.** It keeps the current build plus the
  N newest others; `ucm start --keep N` does this after every deploy. A tab still on a pruned build gets
  `410 Gone` from its next server call, and the browser runtime reloads the page onto the current version.
- **Pushing is deploying.** `ucm push prod` to a server running `ucm start` sends only the definitions it
  lacks. The server verifies them by re-hashing, then its `ucm start` sees the name move, builds and switches.
  There's no deploy script and no restart.

**Module-level state is placed by who uses it.** That follows from inference, not annotation, and every app
report shows it:
- **Server state:** `const visits = new Map()` used only by server functions has one copy, shared by every
  client.
- **Browser state:** used only by browser code, each tab has its own copy.
- **Used by both sides:** the server and every tab silently get separate copies, so ucm warns.

Only fresh mutable objects count (`new …`, `[]`, `{}`); `as const`, frozen and computed values don't.

**Not yet:**
- **Server-only npm packages are found by a heuristic:** no browser build, and an entry that imports Node
  builtins.

## Self-hosting

`pnpm selfhost` imports `packages/` into `selfhost/.ucm` (142 definitions) and then:

1. runs `ucm verify` with the **self-hosted** ucm: every definition round-trips to its own hash;
2. runs the whole test suite against the self-hosted CLI and analyzer (`UCM_BIN=selfhost/ucm.ts
   UCM_CORE=selfhost/core.ts`), which execute entirely from `.ucm/cache`;
3. checks the fixed point: the self-hosted ucm imports `packages/` again and assigns exactly the same hashes.

Getting there took two small refactors, both now enforced by the tool. A top-level `for` loop that filled a
lookup table became an immediately-invoked function, and the CLI's top-level `try` moved into an exported
`runCli`. `ucm import` refuses top-level statements, because quietly skipping one could leave a definition
half-initialized.

## Not done yet

The design and milestones are in the plan. Still open:

- `import.meta` is location-dependent: it is evaluated inside `.ucm/cache`, so ucm warns about it.
  ucm-ts's own `createRequire(import.meta.url)` still finds `@types/node`, because the cache sits inside
  the repo.
- `ucm import` skips test files (`*.test.ts`, `*.spec.ts`, `*.test-d.ts`, `test/` directories).
- `find` searches signature *text*; structural type search (signature IR) isn't built.
- Watch results aren't cached by hash.
- The watcher uses `createProgram` with `oldProgram` reuse, not a LanguageService.
- To share one definition under two names, use `ucm alias`. Adding the same code twice creates two.
- TypeScript 7 (the Go compiler) has a different API and isn't supported.
- Behaviour of transitive npm dependencies is not part of a hash; only the direct `name@version` is.
