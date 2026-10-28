# Background jobs

```ts
import { enqueue, enqueueAfter, every } from "#tcm/server";

export async function signup(user: string): Promise<string> {
  enqueue(sendWelcome, user);              // returns the job id at once; the work runs in the background
  enqueueAfter(3600, sendReminder, user);  // an hour from now
  return user;
}
export const nightly = every("0 3 * * *", cleanup);
```

## Queued jobs

- **Durable.** Jobs live in `.tcm/data/jobs.sqlite` and survive restarts. A worker inside `tcm start` and
  `tcm dev` runs them, with 5 attempts and exponential backoff by default, and records the last error.
- **Queued by hash, like Unison shipping a computation.** A job records the exact code version that enqueued
  it, so a deploy between enqueue and run doesn't change what it does. The function must be a codebase
  definition (not an inline function), and its arguments plain data.
- **Safe with several servers.** A claim is one atomic update with a lease, so several `tcm start` processes
  can share the queue, and a crashed worker's job is picked up again when its lease expires.
- **Transactional.** Inside a [`transaction`](data.md#transactions), `enqueue` takes effect on commit and is
  dropped on rollback.

## Scheduled jobs

`every("0 3 * * *", cleanup)` uses five cron fields in UTC; `every("15m", sync)` an interval (`s`, `m`, `h`,
`d`).

- **Found statically.** `tcm start` and `tcm dev` find schedules in the app's namespace from the code itself,
  with no registration, and moving a name reschedules them.
- **Each slot runs once,** however many servers share the codebase.
- **New schedules don't fire on their first deploy.** After downtime, an interval schedule catches up once.

## Managing jobs

`tcm jobs [n]` lists the queue; `tcm jobs retry <id>` and `tcm jobs cancel <id>` act on one (an id prefix is
enough). In tests, `runJobs()` drains the queue inline ([testing](testing.md)).
