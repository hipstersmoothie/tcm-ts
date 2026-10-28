// A scratch file. The notes app is already in the codebase (see the Codebase sidebar, or `ucm ls notes`); this
// file is where you try things. Bare expressions are watch expressions: their values show at the end of the line.
import { renderToStaticMarkup } from "react-dom/server";
import { excerpt, Markdown, parseBlocks, sampleNotes } from "#codebase/notes";

parseBlocks("# Hello\n\nsome *text*\n\n- a list");
excerpt(sampleNotes[1]!.body);

// components are values too: render one to HTML right here
renderToStaticMarkup(<Markdown text={"**bold** and `code`"} />);

// Try: change how a note's sidebar line reads, save, and "Update codebase". notes.summarize is re-hashed, and so
// is every definition that uses it, server components included; `ucm dev notes.App` reloads with it.
export const shout = (s: string): string => s.toUpperCase() + "!";

shout(excerpt(sampleNotes[0]!.body, 20));
