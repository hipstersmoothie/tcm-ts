# Examples

Two complete apps, each built into a fresh codebase by its `setup.sh`.

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

Its definitions are documented the [tcm way](../docs/documentation.md): links, and examples that are evaluated
(`tcm docs polls.chart`), and `polls.README` is the namespace's front page.

`setup.sh` adds the three files to a new codebase and then deletes them: from then on the code lives in the
codebase, not in files. Browse it with `tcm ls polls` and `tcm view polls.vote`, or in VS Code's Codebase
sidebar. `tcm view` shows where each definition runs: `polls.chart` anywhere, `polls.vote` on the server (and
callable from the browser by hash), `polls.main` in the browser.

`packages/cli/test/examples.test.ts` builds this example, starts it, votes, and checks the page in Chrome.

## notes: React server components

```sh
examples/notes/setup.sh /tmp/notes      # installs React, builds the codebase there, runs its tests
cd /tmp/notes && tcm dev notes.App      # or ▶ Start in VS Code's Apps view
```

A notes app in the style of React's Server Components demo, without a single `"use client"` or `"use server"`.
tcm infers where each component renders from what it uses ([React](../docs/react.md)):

| file | what it shows |
|---|---|
| [`model.ts`](notes/model.ts) | plain functions (`excerpt`, `matches`, `ago`) that run anywhere; tests; sample notes |
| [`markdown.tsx`](notes/markdown.tsx) | a markdown renderer and its `Markdown` component: plain elements, so it renders on the server inside a note's page and in the browser inside the editor's live preview, from one hash |
| [`server.ts`](notes/server.ts) | the `notes` table and the server functions that change it, with a test |
| [`ui.tsx`](notes/ui.tsx) | server components (`NoteList`, `NotePreview`: async, they read the table), browser components (`App`, `NoteEditor`, `SidebarNote`: state and handlers), and the URL as state |
| [`playground.tsx`](notes/playground.tsx) | the scratch file you start with: watch expressions, including a component rendered to HTML |

`tcm dev notes.App` prints the split: three server components fetched by hash, the browser components they send
by hash, and the server functions the browser calls. The first paint is rendered on the server, links to a note
included, and the browser hydrates it. Saving a note refreshes the sidebar by itself: after a server function
call, server components fetch their trees again.

The test suite builds this example too, then adds, opens, edits and searches notes in Chrome.
