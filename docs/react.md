# React and server components

Write React components in `.tsx` scratch files. tcm works out which ones render on the server and which in the
browser, the way it places all code ([web apps](apps.md)): there's no `"use client"` and no `"use server"`.

```tsx
// tcm: namespace notes
import { table } from "#tcm/server";
import { useState } from "react";

export const notes = table<{ text: string }>("notes");

export async function addNote(text: string): Promise<void> {     // a server function
  await notes.insert({ text });
}

export async function NoteList() {                                // async: renders on the server
  const all = await notes.find();
  return <ul>{all.map((n) => <li key={n.id}>{n.value.text}</li>)}</ul>;
}

export function NewNote() {                                       // state and a handler: renders in the browser
  const [text, setText] = useState("");
  return (
    <form onSubmit={async (e) => { e.preventDefault(); await addNote(text); setText(""); }}>
      <input value={text} onChange={(e) => setText(e.target.value)} />
    </form>
  );
}

export function App() {                                           // renders anywhere: here, in the browser
  return <main><NewNote /><NoteList /></main>;
}
```

```sh
npm install react react-dom @types/react @types/react-dom
tcm add notes.tsx
tcm dev notes.App
```

`tcm dev` (and `tcm build`/`tcm start`) accept a component as the app: tcm renders it into the page with React
DOM. A `main` function that calls `createRoot` itself works too.

## Where a component renders

`tcm view` says, for every component, where it renders and why:

| a component that | renders |
|---|---|
| uses a hook (`useState`, `useEffect`, …), an event handler (`onClick={…}`), or the DOM | in the browser |
| is `async`, or uses the server (a [table](data.md), `node:*`, `#tcm/server`) | on the server |
| does neither | anywhere: where it's used |

```
$ tcm view notes.NoteList
// notes.NoteList #umd74guw : () => Promise<Element>
// renders on the server: it is an async component; the browser fetches its rendered tree by hash
```

Rendering a component isn't calling it, so a JSX element doesn't pull a component's needs into the one that
renders it. A server component can render `<NewNote />`, and a browser component can render `<NoteList />`.
Each renders where it has to.

- **A server component used by browser code** becomes a stub in the browser. The stub fetches the component's
  rendered tree by hash (`POST /__tcm/rpc/<hash>`, with its props as the argument) and renders that. Its props
  are checked against its parameter types, as a server function's arguments are.
- **A browser component inside a server component** is sent as a reference to its hash, with the props the
  server gave it. The browser already has its code: `tcm dev` lists these as "rendered in the browser inside
  server components".
- **A component that renders anywhere** (plain markup, like a `Markdown` renderer) renders on the server inside
  a server component and in the browser inside a browser component. It's the same definition and the same hash.
- **Server functions** are called from browser components as usual: import them and `await` them.

`tcm dev` prints the split:

```
  server   1 component(s) rendered on the server, fetched by hash: notes.NoteList #umd74guw
  server   1 function(s) the browser calls by hash: notes.addNote #2w6iz4qg
```

## Keeping server components current

After the page calls a server function, every server component on it fetches its tree again, so `NoteList`
shows the new note without any wiring. Browser components inside a refetched tree keep their state, as React
keeps it for any re-render.

A server component's props come from the browser component rendering it. Change them (`<NoteList search={q} />`
with `q` in state) and it fetches the tree for the new props.

## What crosses

Props sent between the two sides are plain data, the same as server function arguments
([web apps](apps.md#plain-data-crosses-the-wire)). Elements in the props a server component passes (`children`,
or `sidebar={<Nav />}`) are rendered on the server first. A function can't be sent; tcm refuses it and says
where it was:

```
notes.NoteList > notes.Entry: prop `onPick` is a function, which can't be sent from the server to the browser;
the browser component can import what it needs itself
```

## Packages and versions

JSX compiles to calls into `react/jsx-runtime` (or your tsconfig's `jsxImportSource`). That runtime is pinned
like an import: a component's hash includes the React version it was written against, and its generated module
imports that version. tcm also installs the project's `@types/react` for it, and makes the packages React
installs beside it (React DOM's `react`) use the same copy, so there's one React.

## Trying components out

Components are values, so a watch expression can render one:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "#codebase/notes";

renderToStaticMarkup(<Markdown text="**hi**" />);    // ⧩ '<div class="markdown"><p><strong>hi</strong></p></div>'
```

The [notes example](../examples/README.md#notes-react-server-components) is a complete app: a sidebar and
note page rendered on the server, an editor with a live preview in the browser, and search.

## Limits

- **The first paint happens in the browser.** The page loads, then server components fetch their trees; there's
  no server-rendered HTML yet.
- **A server component's tree arrives whole.** There's no streaming, and `<Suspense>` inside a server
  component doesn't show its fallback.
- **Context providers, `lazy` and class components render only in the browser.**
- **Import hooks by name** (`import { useState } from "react"`). tcm can't tell that `React.useState` makes a
  component a browser component, and a hook called on the server fails.
