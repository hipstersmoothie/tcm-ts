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
tcm add notes.tsx
tcm dev notes.App
```

There's nothing to install: tcm provides React, React DOM and their types ([packages](packages.md)).

`tcm dev` (and `tcm build`/`tcm start`) accept a component as the app. tcm renders its first paint on the
server, then the browser takes it over (hydrates it) with React DOM ([below](#the-first-paint)). A `main`
function that calls `createRoot` itself works too, rendered in the browser only.

## Where a component renders

`tcm view` says, for every component, where it renders and why:

| a component that | renders |
|---|---|
| uses a hook (`useState`, `React.useEffect`, …), an event handler (`onClick={…}`), or the DOM, or is a class component | in the browser |
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
shows the new note without any wiring. The fetch runs in a transition: the old tree stays on screen until the
new one is ready, and browser components inside it keep their state, as React keeps it for any re-render.

A server component's props come from the browser component rendering it. Change them (`<NoteList search={q} />`
with `q` in state) and it fetches the tree for the new props.

## Loading and streaming

A server component's stub suspends while its tree is on the way, so a `<Suspense>` boundary above it shows its
fallback:

```tsx
<Suspense fallback={<p>loading…</p>}>
  <NotePreview id={id} />
</Suspense>
```

A `<Suspense>` boundary *inside* a server component streams. Its fallback goes out with the rest of the tree,
and what's inside follows when it's ready, so a slow part doesn't hold up the rest:

```tsx
export async function Page() {
  return (
    <>
      <h1>Dashboard</h1>                                  {/* arrives at once */}
      <Suspense fallback={<p>loading stats…</p>}>
        <Stats />                                          {/* an async component: streams in when it's done */}
      </Suspense>
    </>
  );
}
```

An error inside a boundary goes to that boundary in the browser, so an error boundary around it can catch it.
The rest of the tree is unaffected.

## The first paint

When the app is a component, `tcm dev` and `tcm start` render each page on the server and stream its HTML: the
shell first (everything outside boundaries that are still waiting, with their fallbacks), then each boundary's
contents. Server components render right there, in the page's request (its cookies and session). The trees
they rendered go into the page, and the browser hydrates with them instead of fetching them again.

- **Browser components render on the server too, for the first paint**, as React server rendering does: their
  initial state, without effects. Code that touches the DOM belongs in effects and event handlers.
- **`location` is the page's URL** while the page renders on the server, so browser code that reads it (a
  router, say) renders the same on both sides. `useSyncExternalStore` needs a server snapshot to render on the
  server; `() => location.search` works for both.
- **If the shell can't render on the server** (a browser component reads `window` while rendering), tcm logs why
  and sends the page without it; the browser renders it, as it would without server rendering. A boundary that
  fails on the server is rendered in the browser instead.
- **Until the page hydrates, clicks do nothing**: the markup is there before the code that handles it.

`tcm build` makes a server-rendering bundle along with the browser one, kept in the build (`server/`) but never
served.

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
like an import, by compatible range: a component's hash says it was written against React 19, and the codebase
runs one React 19.x for all of them, with React DOM at the matching version, so there's one React
([packages](packages.md#versions)).

## Trying components out

Components are values, so a watch expression can render one:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "#codebase/notes";

renderToStaticMarkup(<Markdown text="**hi**" />);    // ⧩ '<div class="markdown"><p><strong>hi</strong></p></div>'
```

The [notes example](../../examples/README.md#notes-react-server-components) is a complete app: a sidebar and
note page rendered on the server, an editor with a live preview in the browser, and search.

## Contexts

A server component can provide a context to the browser components it renders:

```tsx
export const Theme = createContext("light");          // a top-level definition, so it has a hash

export async function Layout() {
  const prefs = await loadPrefs();
  return <Theme value={prefs.theme}><Toolbar /></Theme>;   // Toolbar reads it with useContext
}
```

The provider is sent as the context's hash and its value, which must be plain data.

On the server, a `<Theme.Consumer>` reads the value provided above it in the same server-rendered tree, or the
context's default when there's none. A server component can't see providers in browser components above it:
it renders on the server, before the browser has any. Pass what it needs as props.

## Code splitting

A `lazy` component a server component renders loads and renders in the browser. It's sent as a reference to
its definition's hash, like a browser component, so its code is still split out of the page:

```tsx
export const Chart = lazy(() => import("chart-lib"));     // a top-level definition, so it has a hash

export async function Report() {
  const points = await loadPoints();
  return <Chart points={points} />;                        // the browser loads chart-lib, then renders it
}
```

The first paint renders it on the server, as React server rendering does.

## Cookies

A server component can set cookies (`setCookie` from `#tcm/server`), when it's fetched and when it renders the
first paint. Cookies set before the page's headers go out are in them. Ones set later (in a `<Suspense>`
boundary that streams after the shell) are kept under a one-time token in the page, and the browser collects
them right away (`POST /__tcm/cookies/<token>`, within a minute), so `httpOnly` cookies work too.
