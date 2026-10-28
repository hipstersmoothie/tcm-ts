# Data: typed tables

Typed tables never silently disagree with your code.

```ts
import { table, transaction } from "#ucm/server";

export type User = { name: string; email: string; joined: Date; plan: "free" | "pro"; logins: number };
export const users = table<User>("users");          // declared at the top level

await users.insert({ name: "ada", email: "ada@x", joined: new Date(), plan: "free", logins: 0 });
await users.find({ name: "ada" });                    // also get / put / delete / count
```

TypeScript erases `User` at runtime, but ucm sees it where the table is declared. It derives a schema from it
and attaches that schema, with its hash, to the table. A table declared anywhere but the top level, or without
a row type, explains how to declare one when used.

Data lives in `.ucm/data/store.sqlite`, apart from the codebase. Under `ucm test`, tables live in memory.

## Options

```ts
export const users = table<User>("users", {
  migrate: [fromV1, fromV2],   // one step per earlier row type, picked by its parameter type
  unique: ["email"],           // a duplicate write fails with a 409
  index: ["plan"],             // find({ plan: "pro" }) uses an index
  renamedFrom: "members",      // the old table's rows move over
});
```

## Writes are checked

Every write is checked against `User`, and each row records the schema it was written with. Dates, maps and sets
round-trip.

## When the row type changes

Each stored row is checked as it's read:

- **Rows that still fit the new type** (e.g. a new optional field) just work.
- **Rows that don't are converted by `migrate`**, the result is checked, and the upgraded row is written back.
- **With no `migrate`,** reading refuses with the reason, never returning the wrong shape.

`migrate` is one function, or a chain of typed steps, oldest first:

```ts
export function fromV1(old: { body: string }) {
  return { text: old.body, tags: [] as string[] };
}
export function fromV2(old: { text: string; tags: string[] }): Note {
  return { ...old, pinned: false };
}
export const notes = table<Note>("notes", { migrate: [fromV1, fromV2] });
```

ucm records each step's parameter type. A row goes through the first step whose parameter it fits, then the
later ones, until it fits the row type, so a v1 row goes through both steps here and a v2 row through the second.
Type changes accumulate without one function having to handle every past shape. A row no step takes fails with
each step's reason ("step 1 (fromV1): row.body is missing; …").

**`ucm update` reports this up front.** When a row type changes, it checks the stored rows and says whether they
fit, will be migrated (some step takes them), or need a step first. It also reports stored duplicates that would
break a new `unique` field, and rows waiting to move from a `renamedFrom` table.

**`ucm data migrate <table>` migrates every row now**, through the current code, instead of as rows are read.
`<table>` is a table name or the name of the definition declaring it. Afterwards it says whether `migrate` still
has work: once every row has the current type, it can be removed. Keep it while an older build that writes the
old type is still serving.

**Old pages reload instead of misreading.** A page from an older build (old builds keep serving) that reads rows
written by newer code gets a 410, and its browser reloads onto the current version.

## Queries and indexes

- **`find(where, { orderBy, desc, limit, offset })`** returns `{ id, value }[]` whose fields equal `where`'s,
  oldest first unless ordered. **`findOne(where, opts)`** returns the first, **`count(where)`** how many.
- **`unique` and `index` fields get SQLite expression indexes.** A write that would duplicate a `unique` field
  fails with `HttpError(409)` naming the other row; writes never replace another row to satisfy uniqueness.
- **When every row has the current type** (e.g. after `ucm data migrate`), filtering, ordering and paging run in
  SQL, using the indexes. Otherwise rows of older types are read through `migrate` first, so results never
  depend on whether a row was migrated yet.

## Renaming a table

`renamedFrom: "members"` moves the old table's rows to the new name when the table is first used, and any rows an
older build writes under the old name afterwards.

## Atomic updates

`update(id, fn)` is an atomic read-modify-write: `fn` gets the current value and returns the new one,
synchronously, while the row is locked. It returns the new value, or `undefined` if there's no such row.

```ts
await users.update(id, (u) => ({ ...u, logins: u.logins + 1 }));
```

## Transactions

```ts
await transaction(async () => {
  const a = (await accounts.get(from))!;
  const b = (await accounts.get(to))!;
  await accounts.put(from, { ...a, balance: a.balance - amount });
  if (a.balance < amount) throw new Error("insufficient funds");   // rolls back the debit
  await accounts.put(to, { ...b, balance: b.balance + amount });
});
```

`transaction(fn)` makes any number of reads and writes, across tables, all or nothing: a throw rolls them all
back, and `transaction` returns `fn`'s result.

- **Isolated.** Every request shares one SQLite connection, so a transaction holds the store for as long as it
  runs. Table calls inside it run in it; other requests' table calls wait until it commits or rolls back.
  Nobody sees a debit without its credit.
- **Jobs wait for the commit.** Jobs [enqueued](jobs.md) inside a transaction are queued when it commits, and
  dropped if it rolls back, so a failed signup doesn't send its welcome email.
- **Nesting.** A transaction inside a transaction is a savepoint: its failure undoes only its own writes.
  `update` inside a transaction is a savepoint too.

Trade-offs:

- **Keep transactions short.** While one runs, every other table call in the process waits.
- **Don't await anything inside a transaction that itself needs a table from outside it**, such as a request
  to your own server. It would wait forever.
- **The lock is per process.** Another process using the same store, such as `ucm data migrate` while the app
  serves, is kept out by SQLite's write lock instead: it waits up to 5 seconds for a transaction to finish,
  then fails with "database is locked".

## `ucm data`

`ucm data` lists tables and row counts, and notes tables whose rows span several row types. `ucm data <table>
[n]` shows the newest rows, each with the schema it was written with.
