// ucm: namespace notes
// The server half: a typed table, and the functions that change it. They use #ucm/server, so ucm places them on
// the server; browser components call them by hash, like local async functions.
import assert from "node:assert/strict";
import { HttpError, table } from "#ucm/server";
import { matches, sampleNotes, summarize, type Note, type NoteSummary } from "#codebase/notes";

/** Every note, by id. Rows are checked against {@link Note} when written. */
export const notes = table<Note>("notes");

/**
 * The notes matching `search` ({@link matches}), most recently changed first, as the sidebar shows them.
 *
 * @param search words that must all appear in a note (all notes if empty)
 */
export async function listNotes(search: string): Promise<NoteSummary[]> {
  const all = await notes.find(undefined, { orderBy: "updatedAt", desc: true });
  const now = new Date();
  return all.filter((row) => matches(row.value, search)).map((row) => summarize(row.id, row.value, now));
}

/** One note, or `undefined` if there's no such note (it was deleted, say). */
export async function getNote(id: string): Promise<Note | undefined> {
  return notes.get(id);
}

/**
 * Save a note: a new one when `id` is undefined, else replace note `id`. Returns the note's id. A note needs a
 * title, so an empty one becomes "Untitled".
 */
export async function saveNote(id: string | undefined, title: string, body: string): Promise<string> {
  const note: Note = { title: title.trim() || "Untitled", body, updatedAt: new Date() };
  if (id === undefined) return notes.insert(note);
  if (!(await notes.get(id))) throw new HttpError(404, "that note was deleted");
  await notes.put(id, note);
  return id;
}

/** Delete note `id`. Deleting a note that's already gone is fine. */
export async function deleteNote(id: string): Promise<void> {
  await notes.delete(id);
}

/** Add the {@link sampleNotes}, for a first look; the empty sidebar has a button for it. */
export async function addSampleNotes(): Promise<void> {
  for (const n of sampleNotes) await notes.insert({ ...n, updatedAt: new Date() });
}

/** Saving creates, then replaces; search finds by any words; deleted notes are gone. */
export const testSaveSearchDelete = async () => {
  const id = await saveNote(undefined, "  ", "buy **milk**");
  assert.equal((await getNote(id))?.title, "Untitled");
  assert.equal(await saveNote(id, "Shopping", "buy milk and eggs"), id);
  assert.deepEqual((await listNotes("EGGS milk")).map((n) => [n.title, n.excerpt]), [["Shopping", "buy milk and eggs"]]);
  assert.deepEqual(await listNotes("bread"), []);
  await deleteNote(id);
  assert.equal(await getNote(id), undefined);
  await assert.rejects(saveNote(id, "Too late", ""), /deleted/);
};
