# Pages and other files

A codebase keeps more than code: docs pages, stylesheets, images. Each is a definition of its own, a **file**,
named like any definition (`docs.getting-started`) and kept as written. It's hashed by its content, and it's in
history, branches, merges and sync like code.

| Format | Kept as |
|---|---|
| `.md`, `.txt`, `.css`, `.svg`, `.html`, `.json`, `.yaml`, `.yml`, `.toml`, `.csv` | text |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, `.pdf` | bytes |

A file's name is its namespace and its file name without the extension, dashes kept: `getting-started.md` in
`docs` is `docs.getting-started`. (Its name can't have other dots.)

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

## Writing them out

`tcm export <namespace> <dir>` writes a namespace's files to a directory, laid out by their names (`docs.a.b` is
`a/b.md`), with links and names as they are now. A package can ship them too: an entry of its manifest's `files`
can be a namespace of files instead of a path ([publishing](publishing.md#packages)).

In a [mirror](importing.md#mirrors), the files under the mirrored directory that aren't code or configuration
(Markdown, CSS, images; not JSON, YAML or TOML) are files of the codebase, written back as they change.

tcm's own docs are files of its codebase (`tcmts.docs`, mirrored to `packages/docs/`), and its docs site is built
from them by a definition (`pnpm docs:site`, which is `pnpm tcm run tcmts.dev.site`). `pnpm verify` builds it too,
and fails on any link or anchor that doesn't resolve.
