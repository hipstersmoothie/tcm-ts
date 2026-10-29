# Tutorial: your first web app

A shared notes page: type a note, press Enter, and everyone sees it. It has a database, server code and browser
code, and you won't write a route, a fetch call or an API layer. About ten minutes.

Start a codebase ([install](getting-started.md) first if you haven't):

```sh
mkdir notes && cd notes
tcm init
```

## Write the whole app

Put this in `scratch.ts`:

```ts
// tcm: namespace notes
import { table } from "#tcm/server";

export type Note = { text: string; at: Date };

/** Every note anyone has written. */
export const notes = table<Note>("notes");

export async function addNote(text: string): Promise<void> {
  await notes.insert({ text, at: new Date() });
}

export async function listNotes(): Promise<string[]> {
  return (await notes.find({}, { orderBy: "at", desc: true })).map((r) => r.value.text);
}

export async function main() {
  const input = document.createElement("input");
  const list = document.createElement("ul");
  const show = async () => {
    list.replaceChildren(...(await listNotes()).map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  };
  input.onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    await addNote(input.value);
    input.value = "";
    await show();
  };
  document.body.append(input, list);
  await show();
}
```

A few things to notice:

- `table<Note>("notes")` is a **typed table**: rows are stored on the server and checked against `Note` when
  written. Dates come back as dates.
- `addNote` and `listNotes` use the table, and `main` uses `document`. Nothing says which runs where.
- `main` calls `listNotes()` and `addNote()` as if they were local functions.

```text
$ tcm add
  + new       notes.Note type
  + new       notes.notes : Table<Note>
  + new       notes.addNote : (text: string) => Promise<void>
  + new       notes.listNotes : () => Promise<string[]>
  + new       notes.main : () => Promise<void>
```

## Where things run

tcm works out where each function runs from what it uses:

```text
$ tcm view notes.addNote
// notes.addNote #2w6iz4qg : (text: string) => Promise<void>
// runs on the server: it uses notes.notes, which uses #tcm/server (table); browser code calls it by hash

$ tcm view notes.main
// notes.main #o2wxk6e6 : () => Promise<void>
// runs in the browser: it uses document
```

Code that uses the database, Node or `#tcm/server` runs on the server; code that uses the DOM runs in the
browser; anything else runs wherever it's called from. When browser code calls a server function, tcm turns the
call into a request to that exact function, by hash. Server functions have to be `async`, since a call across the
network can't return immediately; tcm tells you if one isn't.

## Run it

```text
$ tcm dev notes.main
tcm dev notes.main #o2wxk6e6
  url      http://127.0.0.1:5173/
  browser  1 definition(s)
  server   2 function(s) the browser calls by hash: notes.addNote #2w6iz4qg, notes.listNotes #o3tcbfex
```

Open the URL, type a note and press Enter. Open it in a second tab and both show the same notes: they're in the
table, on the server.

`tcm dev` also told you exactly what the browser can reach: two functions. Those are the app's only endpoints.
Nothing else on the server can be called from outside, and each endpoint checks that its arguments match its
parameter types before it runs.

In VS Code, the **Apps** view lists `notes.main` with a ▶ button that does the same and opens the page beside your
code.

## Change it

Leave `tcm dev` running. Show the newest note in capitals, by writing a new `listNotes` in `scratch.ts`:

```ts
// tcm: namespace notes
import { notes } from "#codebase/notes";

export async function listNotes(): Promise<string[]> {
  return (await notes.find({}, { orderBy: "at", desc: true })).map((r, i) => (i === 0 ? r.value.text.toUpperCase() : r.value.text));
}
```

```text
$ tcm update
  ~ update    notes.listNotes : () => Promise<string[]>  (was #o3tcbfex)
  ~ updated   notes.main (dependent)
```

`main` calls `listNotes`, so it was updated too, and the page reloads with the change. There was nothing to restart and nothing to rebuild: the dev server follows the
codebase.

## Ship it

A production build is immutable and named by the app's hash:

```text
$ tcm build notes.main
built notes.main #o2wxk6e6 into .tcm/apps/o2wxk6e6ghnnvykwiutwzxn6fz33byqvl2jj672b6z5o4wwa57lq
  browser  1 definition(s)
  server   2 function(s) the browser calls by hash: notes.addNote #2w6iz4qg, notes.listNotes #o3tcbfex
```

To serve it:

```sh
tcm start notes.main --port 8080
```

`tcm start` serves whatever `notes.main` names, and keeps watching that name. Run `tcm update` and it builds the
new version and switches to it; `tcm reset` back and it switches back. Deploying and rolling back are both just
moving a name. Pages that were already open keep working against the version they loaded until they reload, so
an update never breaks someone mid-session.

## What you've done

You wrote one file with server and browser code mixed freely, and tcm split it, connected the two sides by hash,
stored the data in a typed table, and gave you a dev server and a production server.

Next:

- The [polls example](../../examples/README.md) goes further: sessions, a background job, a recurring job, a live
  stream of results, tests and documented code.
- Guides: [server functions](server-api.md) (sessions, errors, streaming), [data](data.md) (queries, changing a
  table's shape), [background jobs](jobs.md), [deploying](production.md).
