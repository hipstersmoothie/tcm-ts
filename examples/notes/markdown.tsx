// ucm: namespace notes
// A small markdown renderer. It's React elements and nothing else (no state, no DOM, no server), so ucm places it
// "anywhere": the same definition renders a note on the server, and the editor's live preview in the browser.
import assert from "node:assert/strict";

/** A block of markdown: what {@link parseBlocks} splits a note into, and {@link Markdown} draws. */
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; code: string };

/** A run of text inside a block, as {@link parseInline} finds them. */
export type Inline = { kind: "text" | "strong" | "em" | "code"; text: string } | { kind: "link"; text: string; href: string };

/**
 * Split markdown into blocks: `#` headings, `-` lists, fenced code, and paragraphs between blank lines.
 *
 * ```ts
 * parseBlocks("# Title\n\nSome *text*\non two lines\n\n- one\n- two")
 * ```
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      blocks.push({ kind: "code", code: code.join("\n") });
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
    } else if (item) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === "list") last.items.push(item[1]!);
      else blocks.push({ kind: "list", items: [item[1]!] });
    } else if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * Find `**strong**`, `*emphasis*`, `` `code` `` and `[links](https://…)` in a line of text.
 *
 * ```ts
 * parseInline("a **bold** and `code` [link](https://react.dev)")
 * ```
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: "strong", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "em", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "code", text: m[3] });
    else out.push({ kind: "link", text: m[4]!, href: m[5]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** Only web links become links: a note can't smuggle in a `javascript:` URL. */
export const safeHref = (href: string): string | undefined => (/^https?:\/\//.test(href) ? href : undefined);

/** One line of markdown text, with its {@link parseInline | inline} formatting. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.kind === "strong" ? (
          <strong key={i}>{part.text}</strong>
        ) : part.kind === "em" ? (
          <em key={i}>{part.text}</em>
        ) : part.kind === "code" ? (
          <code key={i}>{part.text}</code>
        ) : part.kind === "link" ? (
          <a key={i} href={safeHref(part.href)} target="_blank" rel="noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * A note's body, rendered. Used by `notes.NotePreview` (a server component: it renders there) and by
 * `notes.NoteEditor` (a browser component: it renders there, as you type). One definition, one hash.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      {parseBlocks(text).map((block, i) =>
        block.kind === "heading" ? (
          block.level === 1 ? <h2 key={i}><InlineText text={block.text} /></h2> : <h3 key={i}><InlineText text={block.text} /></h3>
        ) : block.kind === "list" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <InlineText text={item} />
              </li>
            ))}
          </ul>
        ) : block.kind === "code" ? (
          <pre key={i}>{block.code}</pre>
        ) : (
          <p key={i}>
            <InlineText text={block.text} />
          </p>
        ),
      )}
    </div>
  );
}

/** Blocks: headings, lists, code fences, and paragraphs joined across lines. */
export const testParseBlocks = () => {
  assert.deepEqual(parseBlocks("# Title\n\nSome *text*\non two lines\n\n- one\n- two\n\n```\ncode\n```"), [
    { kind: "heading", level: 1, text: "Title" },
    { kind: "paragraph", text: "Some *text* on two lines" },
    { kind: "list", items: ["one", "two"] },
    { kind: "code", code: "code" },
  ]);
};

/** Inline formatting, and links that only go to the web. */
export const testParseInline = () => {
  assert.deepEqual(parseInline("a **b** *c* `d` [e](https://f.dev)"), [
    { kind: "text", text: "a " },
    { kind: "strong", text: "b" },
    { kind: "text", text: " " },
    { kind: "em", text: "c" },
    { kind: "text", text: " " },
    { kind: "code", text: "d" },
    { kind: "text", text: " " },
    { kind: "link", text: "e", href: "https://f.dev" },
  ]);
  assert.equal(safeHref("javascript:alert(1)"), undefined);
};
