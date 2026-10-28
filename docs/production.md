# Deploying: by moving a name

- **`tcm build <app>`** writes an immutable, content-addressed build to `.tcm/apps/<app hash>/`. Its assets are
  served under `/_app/<hash>/`. An existing build is reused unless `--force`. A React component app's build also
  holds a server-rendering bundle (`server/`, never served), which `tcm start` renders each page's first paint
  with ([React](react.md#the-first-paint)).
- **`tcm start <app>`** serves the build the app's name points to now. When the name moves (`tcm update`,
  `mv`, `reset`, `pull`), it builds the new version if needed and switches to it. Deploying and rolling back
  are both moving a name, like Unison's service names pointing at service hashes. It also runs the
  [job](jobs.md) worker and schedules, and serves [HTTP routes](server-api.md#plain-http-endpoints) with
  `--http`.
- **There is no version skew.** Earlier builds stay served, and their server functions stay callable. A tab
  opened before a deploy keeps loading its own assets and calling the exact code it was built against, until it
  reloads. `prod.test.ts` deploys v2 and checks the v1 tab still works, then rolls back.
- **`tcm apps` lists builds; `tcm apps prune --keep N` removes old ones.** It keeps the current build plus the
  N newest others; `tcm start --keep N` does this after every deploy. A tab still on a pruned build gets
  `410 Gone` from its next server call, and the browser runtime reloads the page onto the current version.
- **Pushing is deploying.** `tcm push prod` to a server running `tcm start` sends only the definitions it
  lacks. The server verifies them by re-hashing, then its `tcm start` sees the name move, builds and switches.
  There's no deploy script and no restart.
- **TLS.** `tcm start --tls` serves HTTPS; cookies then default to `Secure`.
- **Errors.** Unexpected errors are logged on the server and reach the browser only as "internal error"
  ([server API](server-api.md#rate-limits-and-errors)).
- **Data changes** are covered in [data](data.md#when-the-row-type-changes): old pages that read rows written
  by newer code get a 410 and reload.
