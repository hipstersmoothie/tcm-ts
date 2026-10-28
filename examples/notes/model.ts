// tcm: namespace notes
// The model: notes as plain data, and plain functions over them. Nothing here touches Node, the DOM or React, so
// tcm places all of it "anywhere": server components, browser components and tests share the same hashes.
import assert from "node:assert/strict";

/**
 * A note: a title and a markdown body. Stored in the `notes.notes` table; the sidebar shows it as a {@link NoteSummary}.
 */
export type Note = { title: string; body: string; updatedAt: Date };

/** A note as the sidebar lists it: made on the server by {@link summarize}, sent to the browser as props. */
export type NoteSummary = { id: string; title: string; excerpt: string; updated: string };

/**
 * The start of a note's text, without markdown syntax, on one line and cut to `max` characters.
 *
 * @param body markdown, as a {@link Note}'s body
 * @param max the longest excerpt, `…` included
 *
 * ```ts
 * excerpt("# Groceries\n\n- **eggs**\n- `milk`")
 * excerpt("A first line that goes on and on", 12)
 * ```
 */
export function excerpt(body: string, max = 80): string {
  const text = body
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Whether a note matches a search: every word of `search` appears in its title or body, ignoring case. An empty
 * search matches everything.
 *
 * ```ts
 * matches(sampleNotes[0]!, "milk EGGS")
 * matches(sampleNotes[0]!, "bread")
 * ```
 */
export function matches(note: Note, search: string): boolean {
  const text = `${note.title}\n${note.body}`.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

/**
 * How long ago `date` was, for people: "just now", "5 minutes ago", "3 hours ago", or the day.
 *
 * ```ts
 * ago(new Date("2026-01-01T12:00:00Z"), new Date("2026-01-01T12:05:00Z"))
 * ago(new Date("2026-01-01T09:00:00Z"), new Date("2026-01-01T12:00:00Z"))
 * ```
 */
export function ago(date: Date, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return date.toISOString().slice(0, 10);
}

/** What the sidebar shows for a stored note: its {@link excerpt}, and when it changed ({@link ago}). */
export function summarize(id: string, note: Note, now: Date = new Date()): NoteSummary {
  return { id, title: note.title, excerpt: excerpt(note.body), updated: ago(note.updatedAt, now) };
}

/** Notes to start with: the empty sidebar offers to add them (`notes.addSampleNotes`). Frozen: it's data, not state. */
export const sampleNotes: readonly Note[] = Object.freeze([
  {
    title: "Groceries",
    body: "- **eggs** (a dozen)\n- milk\n- `coffee`, the good one",
    updatedAt: new Date("2026-10-20T09:00:00Z"),
  },
  {
    title: "How this app works",
    body:
      "# No directives\n\n" +
      "The sidebar and this page are **server components**: they read the notes table, so they render on the " +
      "server. The search box and the editor keep *state*, so they run in the browser.\n\n" +
      "Nothing says which is which: tcm infers it from what each component uses. See `tcm view notes.NoteList`.",
    updatedAt: new Date("2026-10-21T14:30:00Z"),
  },
  {
    title: "Markdown",
    body:
      "Notes are markdown: *emphasis*, **strong**, `code`, [links](https://react.dev), lists and code blocks.\n\n" +
      "```\nconst same = \"hash on both sides\";\n```\n\n" +
      "The same `notes.Markdown` component renders this page on the server and the editor's preview in the browser.",
    updatedAt: new Date("2026-10-22T08:15:00Z"),
  },
]);

/** Excerpts drop markdown syntax and fit on one line. */
export const testExcerpt = () => {
  assert.equal(excerpt("# Groceries\n\n- **eggs**\n- `milk`"), "Groceries eggs milk");
  assert.equal(excerpt("see [the docs](https://example.com)"), "see the docs");
  assert.equal(excerpt("abcdefghij", 5), "abcd…");
};

/** Every word of a search must appear; case doesn't matter. */
export const testMatches = () => {
  const note = sampleNotes[0]!;
  assert.ok(matches(note, ""));
  assert.ok(matches(note, "Milk eggs"));
  assert.ok(!matches(note, "milk bread"));
};

/** Recent changes read as minutes or hours; older ones as the day. */
export const testAgo = () => {
  const now = new Date("2026-01-02T12:00:00Z");
  assert.equal(ago(new Date("2026-01-02T11:59:40Z"), now), "just now");
  assert.equal(ago(new Date("2026-01-02T11:59:00Z"), now), "1 minute ago");
  assert.equal(ago(new Date("2026-01-02T07:00:00Z"), now), "5 hours ago");
  assert.equal(ago(new Date("2025-12-30T12:00:00Z"), now), "2025-12-30");
};
