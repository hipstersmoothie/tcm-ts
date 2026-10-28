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
- **`tcm test [namespace]`** runs them. The watcher, `tcm check` and VS Code run a scratch file's tests inline.
- **Tests run with [Vitest](https://vitest.dev), with nothing to set up.** Each test definition is one Vitest
  test: `expect`, `vi` (mocks, spies, fake timers) and the rest come from `vitest`, which tcm provides like any
  package, and failures read like Vitest's, diffs included. Tests that use `node:assert` (or just throw) work too.
- **Results are cached by hash**, and by the Node and Vitest versions. A test's hash covers everything it calls,
  so only tests whose code or dependencies changed re-run. Tests that read the filesystem, clock or network can go
  stale in the cache: `--fresh` re-runs everything. Watch expressions are cached the same way ([scratch
  files](scratch-files.md)).

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
