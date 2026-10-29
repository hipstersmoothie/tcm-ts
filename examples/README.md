# Examples

Two complete apps and a family of packages, each built into a fresh codebase by its `setup.sh`.

## polls: a live polling app

```sh
examples/polls/setup.sh /tmp/polls      # builds the codebase there and runs its tests
cd /tmp/polls && tcm dev polls.main     # or open /tmp/polls in VS Code with the tcm-ts extension
```

A small app that uses most of what tcm does, with no annotations saying what runs where:

| file | what it shows |
|---|---|
| [`model.ts`](polls/model.ts) | plain functions (`tally`, `leader`, `chart`) that run anywhere; tests; sample data |
| [`server.ts`](polls/server.ts) | typed tables, sessions, a rate limit, a background job that announces the winner when a poll closes, a nightly schedule, a streaming function for live results, and a server test using `withRequest` |
| [`ui.ts`](polls/ui.ts) | browser code calling the server like local functions, including `for await` over the live stream |
| [`playground.ts`](polls/playground.ts) | the scratch file you start with: watch expressions over the model, and a definition to change |

Its definitions are documented the [tcm way](../packages/docs/documentation.md): links, and examples that are evaluated
(`tcm docs polls.chart`), and `polls.README` is the namespace's front page.

`setup.sh` adds the three files to a new codebase and then deletes them: from then on the code lives in the
codebase, not in files. Browse it with `tcm ls polls` and `tcm view polls.vote`, or in VS Code's Codebase
sidebar. `tcm view` shows where each definition runs: `polls.chart` anywhere, `polls.vote` on the server (and
callable from the browser by hash), `polls.main` in the browser.

`packages/cli/test/examples.test.ts` builds this example, starts it, votes, and checks the page in Chrome.

## notes: React server components

```sh
examples/notes/setup.sh /tmp/notes      # builds the codebase there and runs its tests
cd /tmp/notes && tcm dev notes.App      # or ▶ Start in VS Code's Apps view
```

A notes app in the style of React's Server Components demo, without a single `"use client"` or `"use server"`.
tcm infers where each component renders from what it uses ([React](../packages/docs/react.md)):

| file | what it shows |
|---|---|
| [`model.ts`](notes/model.ts) | plain functions (`excerpt`, `matches`, `ago`) that run anywhere; tests; sample notes |
| [`markdown.tsx`](notes/markdown.tsx) | a markdown renderer and its `Markdown` component: plain elements, so it renders on the server inside a note's page and in the browser inside the editor's live preview, from one hash |
| [`server.ts`](notes/server.ts) | the `notes` table and the server functions that change it, with a test |
| [`ui.tsx`](notes/ui.tsx) | server components (`NoteList`, `NotePreview`: async, they read the table), browser components (`App`, `NoteEditor`, `SidebarNote`: state and handlers), the URL as state, and a test of the editor that runs in a browser (it renders a component with state) |
| [`playground.tsx`](notes/playground.tsx) | the scratch file you start with: watch expressions, including a component rendered to HTML |

`tcm dev notes.App` prints the split: three server components fetched by hash, the browser components they send
by hash, and the server functions the browser calls. The first paint is rendered on the server, links to a note
included, and the browser hydrates it. Saving a note refreshes the sidebar by itself: after a server function
call, server components fetch their trees again.

The test suite builds this example too, then adds, opens, edits and searches notes in Chrome.

## geometry: packages, releases and changelogs

```sh
examples/geometry/setup.sh /tmp/geometry   # builds the codebase, and its history, there
code /tmp/geometry                         # the Releases view, release-geo.md, the playground
```

One codebase holding two npm packages: `geo`, a geometry library, and `atlas`, a command built on it. Each is
a namespace with a `manifest` ([publishing](../packages/docs/publishing.md)). `setup.sh` gives them a history, step by
step, printing each:

| step | what it shows |
|---|---|
| [`geo.ts`](geometry/geo.ts), [`atlas.ts`](geometry/atlas.ts) | two packages in one codebase, one using the other; documented, with tests, and a command (`atlas 0,0 3,4`) |
| `tcm release geo@1.0.0 --notes …` | first releases, declared stable, with a summary each ([`notes/`](geometry/notes)); tcm writes the rest of the notes |
| [`steps/1.1-geo.ts`](geometry/steps/1.1-geo.ts) | a new definition and an optional parameter: additions, so `tcm release geo` makes it 1.1.0 by itself |
| [`steps/hexagons.ts`](geometry/steps/hexagons.ts) | a [contribution](../packages/docs/contributions.md), proposed on a branch, commented on and merged through a hub (another codebase, `.hub`); a new case of `Shape` is breaking, so it's geo 2.0.0, and its notes name the contribution |
| [`steps/next.ts`](geometry/steps/next.ts) | an unreleased change, and a draft of its notes (`release-geo.md`) for you to write and release |
| [`playground.ts`](geometry/playground.ts) | the scratch file: watch expressions over both packages |

Then:

- `tcm releases`, `tcm changelog geo`: the releases, and a changelog nobody wrote by hand
  ([releases](../packages/docs/releases.md)).
- `tcm release check geo`: what geo's next release would be (2.1.0, additions), and the semver findings why.
- `tcm pack atlas@1.1.0`: an npm package of atlas 1.1, which depends on `geo ^1.1.0` (the first geo with what it
  uses) rather than carrying a copy.
- In VS Code, the **Releases** view shows both packages, the next release of each with its findings, and their
  releases; click a package for its page and changelog. `release-geo.md` has a **Release** lens at the top.
  `setup.sh` points the extension at the tcm that built the codebase (`.vscode/settings.json`).

The test suite builds this example too, and checks its releases, changelog and packages.
