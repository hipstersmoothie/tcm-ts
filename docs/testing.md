# Testing

```ts
// tcm: namespace lib
import assert from "node:assert/strict";
export const testSortIsStable = () => {
  assert.deepEqual(sortWith(byKey, [/* … */]), [/* … */]);
};
```

- **A test is a definition named `test…`, or any definition under a `tests` namespace.** It passes by returning
  (or resolving) without throwing.
- **`tcm test [namespace]`** runs them. The watcher runs tests from the scratch file inline.
- **Results are cached by hash and Node version.** A test's hash covers everything it calls, so only tests whose
  code or dependencies changed re-run. Tests that read the filesystem, clock or network can go stale in the
  cache: `--fresh` re-runs everything. Watch expressions are cached the same way ([getting
  started](scratch-files.md#scratch-files)).

## Testing app code in one process

Under `tcm test` everything runs locally, the counterpart of Unison's local `Remote` handler:

- **Server functions** are plain function calls. `withRequest(init, fn)` from `#tcm/server` runs code as if
  answering a request (method, URL, headers, cookies, IP), so login flows test with no server.
- **Tables live in memory**, one store per test run, shared by the run's tests: give each test its own rows.
- **Jobs:** `runJobs()` runs the queued jobs that are due, inline; `runJobs({ all: true })` runs all of them.
