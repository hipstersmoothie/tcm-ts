// tcm: namespace notes
// The page, as React components. None of them says where it runs:
//
// - NoteList, NotePreview and NoteEditorLoader read the notes table (they're async), so they render on the server;
//   the browser fetches their rendered trees by hash, and fetches them again after it calls a server function.
// - App, SearchField, SidebarNote, NoteEditor and the buttons keep state or handle events, so they run in the
//   browser. The ones rendered inside server components (SidebarNote, NoteEditor, EditButton) are sent there by
//   hash, with the props the server gave them.
// - Markdown uses neither, so it renders wherever it's used: on the server in NotePreview, in the browser in
//   NoteEditor's live preview.
import assert from "node:assert/strict";
import { Suspense, useState, useSyncExternalStore } from "react";
import { expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { addSampleNotes, deleteNote, getNote, listNotes, Markdown, saveNote, type NoteSummary } from "#codebase/notes";
// for the README's example
import { excerpt, sampleNotes } from "#codebase/notes";

/** What the page shows, kept in the URL (`?note=<id>&edit=1&q=milk`), so links and the back button work. */
export type Route = { note?: string; edit: boolean; q: string };

/**
 * Read a {@link Route} from a URL's query string.
 *
 * ```ts
 * parseRoute("?note=abc&edit=1&q=milk")
 * parseRoute("")
 * ```
 */
export function parseRoute(search: string): Route {
  const p = new URLSearchParams(search);
  return { note: p.get("note") ?? undefined, edit: p.get("edit") === "1", q: p.get("q") ?? "" };
}

/**
 * The query string for a {@link Route}; {@link parseRoute} reads it back.
 *
 * ```ts
 * routeQuery({ note: "abc", edit: true, q: "" })
 * ```
 */
export function routeQuery(route: Route): string {
  const p = new URLSearchParams();
  if (route.note) p.set("note", route.note);
  if (route.edit) p.set("edit", "1");
  if (route.q) p.set("q", route.q);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Re-render on back/forward and on {@link navigate}. */
function subscribeToRoute(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

/**
 * The current {@link Route}; the component re-renders when it changes. It reads `location` on the server too:
 * while tcm renders the first paint, `location` is the page's URL.
 */
export function useRoute(): Route {
  const search = () => location.search;
  return parseRoute(useSyncExternalStore(subscribeToRoute, search, search));
}

/** Go to another {@link Route}: `to` changes some of the current one. `replace` doesn't add a history entry. */
export function navigate(to: Partial<Route>, replace = false): void {
  const url = routeQuery({ ...parseRoute(location.search), ...to }) || location.pathname;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * The sidebar's list: a server component. It reads the table through {@link listNotes} on the server; each entry
 * is a {@link SidebarNote}, which the browser renders.
 */
export async function NoteList({ search, selected }: { search: string; selected?: string }) {
  const found = await listNotes(search);
  if (!found.length) return search ? <p className="none">No notes match “{search}”.</p> : <EmptySidebar />;
  return (
    <ul className="list">
      {found.map((n) => (
        <SidebarNote key={n.id} note={n} selected={n.id === selected} />
      ))}
    </ul>
  );
}

/** One entry in the sidebar: a browser component (it handles clicks), rendered inside {@link NoteList}. */
export function SidebarNote({ note, selected }: { note: NoteSummary; selected: boolean }) {
  return (
    <li>
      <button className={selected ? "entry selected" : "entry"} onClick={() => navigate({ note: note.id, edit: false })}>
        <strong>{note.title}</strong>
        <small>{note.updated}</small>
        <span>{note.excerpt || "(empty)"}</span>
      </button>
    </li>
  );
}

/** No notes yet: offer the samples. */
export function EmptySidebar() {
  const [adding, setAdding] = useState(false);
  return (
    <div className="none">
      <p>No notes yet.</p>
      <button
        disabled={adding}
        onClick={async () => {
          setAdding(true);
          await addSampleNotes();
        }}
      >
        add sample notes
      </button>
    </div>
  );
}

/**
 * A note, read-only: a server component. Its body is rendered by {@link Markdown} right here on the server; the
 * browser only gets the elements.
 */
export async function NotePreview({ id }: { id: string }) {
  const note = await getNote(id);
  if (!note) return <p className="none">This note was deleted.</p>;
  return (
    <article>
      <header>
        <h1>{note.title}</h1>
        <EditButton />
      </header>
      <small>last changed {note.updatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</small>
      <Markdown text={note.body} />
    </article>
  );
}

/** Switch the current note to the editor. */
export function EditButton() {
  return <button onClick={() => navigate({ edit: true })}>edit</button>;
}

/** Loads a note for {@link NoteEditor} on the server, so the editor starts with the stored text. */
export async function NoteEditorLoader({ id }: { id: string }) {
  const note = await getNote(id);
  if (!note) return <p className="none">This note was deleted.</p>;
  return <NoteEditor key={id} id={id} title={note.title} body={note.body} />;
}

/**
 * Edit a note, or write a new one (no `id`), with a live preview: a browser component. The preview is the same
 * {@link Markdown} that {@link NotePreview} renders on the server, rendered here as you type.
 */
export function NoteEditor({ id, title, body }: { id?: string; title: string; body: string }) {
  const [draftTitle, setTitle] = useState(title);
  const [draft, setBody] = useState(body);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const saved = await saveNote(id, draftTitle, draft);
        navigate({ note: saved, edit: false });
      }}
    >
      <div className="fields">
        <input aria-label="title" value={draftTitle} placeholder="title" onChange={(e) => setTitle(e.target.value)} />
        <textarea aria-label="body" value={draft} placeholder="write markdown" onChange={(e) => setBody(e.target.value)} />
        <div className="actions">
          <button type="submit" disabled={busy}>
            save
          </button>
          <button type="button" onClick={() => navigate({ edit: false, note: id })}>
            cancel
          </button>
          {id !== undefined && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await deleteNote(id);
                navigate({ note: undefined, edit: false });
              }}
            >
              delete
            </button>
          )}
        </div>
      </div>
      <section className="preview">
        <h1>{draftTitle || "Untitled"}</h1>
        <Markdown text={draft} />
      </section>
    </form>
  );
}

/** The search box: its text is part of the URL, and {@link NoteList} gets it as a prop. */
export function SearchField({ value }: { value: string }) {
  const [text, setText] = useState(value);
  return (
    <input
      className="search"
      aria-label="search"
      placeholder="search"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        navigate({ q: e.target.value }, true);
      }}
    />
  );
}

/**
 * The app: a browser component (it follows the URL), laying out the server components it renders. While a server
 * component's tree is on its way, its `<Suspense>` boundary shows "loading…"; the first paint is rendered on the
 * server, so it has none.
 */
export function App() {
  const route = useRoute();
  return (
    <div className="notes">
      <style>{css}</style>
      <aside>
        <header>
          <h1>notes</h1>
          <button onClick={() => navigate({ note: undefined, edit: true })}>new</button>
        </header>
        <SearchField value={route.q} />
        <Suspense fallback={<p className="none">loading…</p>}>
          <NoteList search={route.q} selected={route.note} />
        </Suspense>
      </aside>
      <main>
        <Suspense fallback={<p className="none">loading…</p>}>
          {route.edit ? (
            route.note ? <NoteEditorLoader id={route.note} /> : <NoteEditor title="" body="" />
          ) : route.note ? (
            <NotePreview id={route.note} />
          ) : (
            <p className="none">Pick a note, or write a new one.</p>
          )}
        </Suspense>
      </main>
    </div>
  );
}

/** The page's look: monospace, one accent. */
export const css = `
.notes { display: flex; min-height: 100vh; margin: -8px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #222; }
.notes aside { width: 300px; border-right: 1px solid #ddd; padding: 16px; box-sizing: border-box; }
.notes main { flex: 1; padding: 16px 32px; max-width: 900px; }
.notes header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.notes h1 { font-size: 18px; margin: 0; }
.notes button { font: inherit; background: none; border: 1px solid #222; padding: 2px 10px; cursor: pointer; }
.notes button:disabled { opacity: .5; }
.notes input, .notes textarea { font: inherit; border: 1px solid #ccc; padding: 6px; width: 100%; box-sizing: border-box; }
.notes .search { margin: 12px 0; }
.notes .list { list-style: none; padding: 0; margin: 0; }
.notes .entry { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #eee; padding: 8px 4px; }
.notes .entry.selected { background: #f0f4ff; }
.notes .entry small { float: right; color: #888; }
.notes .entry span { display: block; color: #666; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.notes .none { color: #888; }
.notes article small { color: #888; }
.notes .markdown pre { background: #f6f6f6; padding: 8px; }
.notes .editor { display: flex; gap: 24px; }
.notes .editor > * { flex: 1; }
.notes .fields { display: flex; flex-direction: column; gap: 8px; }
.notes textarea { min-height: 300px; }
.notes .actions { display: flex; gap: 8px; }
.notes .preview { border-left: 1px solid #eee; padding-left: 24px; }
`;

/**
 * The editor's preview follows what you type. It renders a browser component (it keeps state), so it runs in a
 * browser: tcm sees that, and runs it in Chrome.
 */
export const testEditorPreview = () => {
  render(<NoteEditor title="Shopping" body="" />);
  fireEvent.change(screen.getByLabelText("body"), { target: { value: "- **milk**" } });
  expect(screen.getByText("milk").tagName).toBe("STRONG");
  expect(screen.getByRole("heading", { name: "Shopping" })).toBeTruthy();
};

/** A route survives the round trip through the URL. */
export const testRouteRoundTrip = () => {
  const route: Route = { note: "abc", edit: true, q: "milk eggs" };
  assert.deepEqual(parseRoute(routeQuery(route)), route);
  assert.deepEqual(parseRoute(""), { note: undefined, edit: false, q: "" });
  assert.equal(routeQuery({ edit: false, q: "" }), "");
};

/**
 * # Notes
 *
 * A notes app in the style of React's Server Components demo, without a single `"use client"` or `"use server"`:
 * tcm infers what renders where from what each component uses.
 *
 * | part | renders | why |
 * |---|---|---|
 * | {@link NoteList}, {@link NotePreview}, {@link NoteEditorLoader} | server | async: they read the {@link notes.notes} table |
 * | {@link App}, {@link SearchField}, {@link NoteEditor}, {@link SidebarNote} | browser | state and event handlers |
 * | {@link Markdown} | anywhere | plain elements: server inside a preview, browser inside the editor |
 * | {@link saveNote}, {@link deleteNote}, {@link listNotes} | server | called from the browser by hash |
 *
 * Server components fetch their trees again after the page calls a server function, so saving a note updates the
 * sidebar without any wiring. The model is plain functions with tests:
 *
 * ```ts
 * excerpt(sampleNotes[1]!.body, 50)
 * ```
 *
 * Run it with **▶ Start** in the Apps view, or `tcm dev notes.App`.
 */
export type README = never;
