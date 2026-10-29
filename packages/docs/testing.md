# Testing

```ts
// tcm: namespace lib
import { expect, vi } from "vitest";

export const testSortIsStable = () => {
  expect(sortWith(byKey, [/* … */])).toEqual([/* … */]);
};

export const testRetriesOnce = async () => {
  const fetch = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error("down")).mockResolvedValue(1);
  expect(await withRetry(fetch)).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
};
```

- **A test is a definition named `test…`, or any definition under a `tests` namespace.** It passes by returning
  (or resolving) without throwing.
- **`tcm test [namespace]`** runs them (and [suites](#suites-testing-a-command-as-a-program)). The watcher, `tcm check` and VS Code run a scratch file's tests inline.
- **Tests run with [Vitest](https://vitest.dev), with nothing to set up.** Each test definition is one Vitest
  test: `expect`, `vi` (mocks, spies, fake timers) and the rest come from `vitest`, which tcm provides like any
  package, and failures read like Vitest's, diffs included. Tests that use `node:assert` (or just throw) work too.
- **Results are cached by hash**, and by the Node and Vitest versions. A test's hash covers everything it calls,
  so only tests whose code or dependencies changed re-run. Tests that read the filesystem, clock or network can go
  stale in the cache: `--fresh` re-runs everything. Watch expressions are cached the same way ([scratch
  files](scratch-files.md)).

## Suites: testing a command as a program

A package's command (its `bin`) can be tested the way people use it: by running it. Its suites are test
definitions that do, in namespaces the package's [manifest](publishing.md#packages) names under `suites`
(command → namespaces, relative to the package's):

```ts
// tcm: namespace greeter
export const manifest = { name: "greeter", bin: { greet: "main" }, suites: { greet: ["e2e"] } };
```

```ts
// tcm: namespace greeter.e2e
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export const testGreets = () => {
  const r = spawnSync(process.execPath, [process.env.GREET_BIN!, "tcm"], { encoding: "utf8" });
  assert.equal(r.stdout, "hello, tcm\n");
};
```

- **`tcm test`** runs them after the other test definitions: each as a program of its own (passing if it returns),
  against the codebase's own build of the command, which it finds in `<COMMAND>_BIN` (`GREET_BIN` here;
  `MY_TOOL_BIN` for `my-tool`). They run side by side, each reported as it finishes; `--definitions` leaves them
  out. They aren't run with Vitest. `--bin greet=pkg/bin/greet.js` runs them against another build of the
  command instead, such as the package `tcm pack` makes: its results are kept apart, and hold until the
  package's files change or code the test ran in it does (a packed module is named by its component's hash).
- **Results are cached by the code a test ran.** V8's coverage of each run (every process it starts) says which
  definitions executed, and the result holds until the test changes, or the code of one of those definitions
  does. A definition it didn't run can change without running it again, though everything using it is
  re-hashed: that changes no code the test ran. Values computed when a module loads count as run.

tcm's own end-to-end tests are its suites (`tcmts.cli.test.e2e`): a change to the mirror's code runs the tests
that used a mirror again, and leaves the rest cached.

## Tests in a project you import

Tests are definitions, so they can live beside the code they test in an imported project too: write them as
exports named `test…` in a `test/` (or `tests/`) directory, and `tcm import --tests` brings them in with
everything else ([importing](importing.md)). Helpers there are plain definitions. A `*.test.ts` file next to
them can register the same exports with another runner (tcm's own repository does that for `node:test`):

```ts
// test/math.ts
import assert from "node:assert/strict";
import { double } from "../src/math.ts";

export const testDouble = () => assert.equal(double(21), 42);
```

## Where a test runs

A test runs in Node, unless it needs a browser: it (or something it uses or renders) touches the DOM or is a
component that keeps state or handles events. Those run in [Vitest's browser
mode](https://vitest.dev/guide/browser/), in Chrome (the one installed; nothing is downloaded):

```tsx
import { expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

export const testCounter = () => {
  render(<Counter />);                             // Counter keeps state: this test runs in a browser
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("button").textContent).toBe("clicked 1");
};
```

Tests go through Vite, as apps do. In a browser test, server functions the code calls are reached by hash, as in
an app: the test's server answers them. Testing libraries like `@testing-library/react` are imports like any
other.

## Testing app code in one process

In a Node test, everything runs locally, the counterpart of Unison's local `Remote` handler:

- **Server functions** are plain function calls. `withRequest(init, fn)` from `#tcm/server` runs code as if
  answering a request (method, URL, headers, cookies, IP), so login flows test with no server.
- **Tables live in memory**, one store per test run, shared by the run's tests: give each test its own rows.
- **Jobs:** `runJobs()` runs the queued jobs that are due, inline; `runJobs({ all: true })` runs all of them.

## The test framework's version

Vitest is pinned in the lock like any package (`tcm packages`), and `tcm upgrade vitest` moves it. Since results
are cached by its version too, an upgrade re-runs the tests.
