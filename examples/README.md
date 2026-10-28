# Examples

## polls: a live polling app

```sh
examples/polls/setup.sh /tmp/polls      # builds the codebase there and runs its tests
cd /tmp/polls && ucm dev polls.main     # or open /tmp/polls in VS Code with the ucm-ts extension
```

A small app that uses most of what ucm does, with no annotations saying what runs where:

| file | what it shows |
|---|---|
| [`model.ts`](polls/model.ts) | plain functions (`tally`, `leader`, `chart`) that run anywhere; tests; sample data |
| [`server.ts`](polls/server.ts) | typed tables, sessions, a rate limit, a background job that announces the winner when a poll closes, a nightly schedule, a streaming function for live results, and a server test using `withRequest` |
| [`ui.ts`](polls/ui.ts) | browser code calling the server like local functions, including `for await` over the live stream |
| [`playground.ts`](polls/playground.ts) | the scratch file you start with: watch expressions over the model, and a definition to change |

Its definitions are documented the [ucm way](../docs/documentation.md): links, and examples that are evaluated
(`ucm docs polls.chart`), and `polls.README` is the namespace's front page.

`setup.sh` adds the three files to a new codebase and then deletes them: from then on the code lives in the
codebase, not in files. Browse it with `ucm ls polls` and `ucm view polls.vote`, or in VS Code's Codebase
sidebar. `ucm view` shows where each definition runs: `polls.chart` anywhere, `polls.vote` on the server (and
callable from the browser by hash), `polls.main` in the browser.

`packages/cli/test/examples.test.ts` builds this example, starts it, votes, and checks the page in Chrome.
