# Pages and other files

A codebase keeps more than code: docs pages, stylesheets, images. Each is a definition of its own, a **file**,
named like any definition (`docs.getting-started`) and kept as written. It's hashed by its content, and it's in
history, branches, merges and sync like code.

| Format | Kept as |
|---|---|
| `.md`, `.txt`, `.css`, `.svg`, `.html`, `.json`, `.yaml`, `.yml`, `.toml`, `.csv` | text |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, `.pdf` | bytes |
| anything else, in a [mirror](importing.md#mirrors) (`.sh`, `.js`, `LICENSE`) | text, or bytes if it isn't UTF-8 |

A file's name is its namespace and its file name without the extension, dashes kept: `getting-started.md` in
`docs` is `docs.getting-started`. A hidden file's name drops its dot (`.gitignore` is `gitignore`). (Its name
can't have other dots.)

## Saving and editing

A file is saved like a scratch file, by its path:

```sh
tcm add guide.md --into docs        # docs.guide
tcm check guide.md --into docs      # what saving it would do
tcm edit docs.guide                 # writes guide.md, to change and `tcm update guide.md`
tcm view docs.guide
```

A Markdown file can say where it goes in its first line, as `tcm edit` writes it:
`<!-- tcm: path docs.guide -->`, or `<!-- tcm: namespace docs -->` and its own name. That line isn't kept.

## Links in Markdown

- **To code**, with `{@link name}` as in [doc comments](documentation.md): the link is to the definition by hash,
  so it follows renames and updates. The page names it as it's called now, as short as it reads from the page's
  namespace. A `{@link}` to nothing in the codebase is an error when the page is saved, and `tcm rm` asks before
  removing a name a page links to.
- **To other pages and files**, with ordinary relative links (`[the FAQ](faq.md#why)`): kept as written, and
  checked when the page is saved: a link to a file of the codebase that isn't there is a warning. `tcm mv` of a
  file rewrites the links to it in every page (and a moved page's own links, from where it is now); `tcm rm` asks
  before removing a file a page links to.

Links in code (fences and `inline code`) aren't links.

## Files are values

Code imports a file like any definition, by its name: its content, as it was saved (text as a `string`, bytes as
a `Uint8Array`). The code depends on it by hash, so updating the file re-derives the code that uses it.

```ts
// tcm: namespace ui
import { app } from "#codebase/styles";      // styles.app, a .css file
import { logo } from "#codebase/media";      // media.logo, a .png
export const page = () => `<style>${app}</style>${logo.length} bytes of logo`;
```

A file whose own name isn't an identifier is imported by its name in quotes:
`import { "getting-started" as gettingStarted } from "#codebase/docs"`. A file is data: what it
links to doesn't make the code using it run on the server or in the browser.

## Writing them out

`tcm export <namespace> <dir>` writes a namespace's files to a directory, laid out by their names (`docs.a.b` is
`a/b.md`), with links and names as they are now; `tcm export docs.guide <dir>` writes the one file, `guide.md`. A package can ship them too: an entry of its manifest's `files`
can be a namespace of files instead of a path ([publishing](publishing.md#packages)).

In a [mirror](importing.md#mirrors), every file under the mirrored directory that isn't code is a file of the
codebase, written back as it changes (in a git repository, every one git keeps). So is everything in a directory
with a `.tcm-files` file in it, code included: example projects, an editor extension, kept as written. The mark's
lines are patterns of what to leave out, as in a `.gitignore` (`*.vsix`).

tcm's own docs are files of its codebase (`tcmts.docs`, mirrored to `docs/`), and its docs site is built
from them by a definition (`pnpm docs:site`, which is `pnpm tcm run tcmts.dev.site`). `pnpm verify` builds it too,
and fails on any link or anchor that doesn't resolve.
