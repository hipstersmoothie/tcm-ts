# AI agents

Working in a codebase isn't how coding agents usually work: there are no source files to edit, definitions are
found and changed through tcm, a change re-hashes what depends on it, and tests only run when something they
reach changed. `tcm mcp` teaches an agent that, as a [Model Context Protocol](https://modelcontextprotocol.io)
server its tools and instructions come from. Claude Code, Cursor, Codex and other MCP clients pick it up.

## Setting it up

`tcm init` does it: it adds the server to the project's `.mcp.json` (`tcm mcp`), and writes a short section about
tcm into `AGENTS.md` for agents that read that instead. Neither is changed if it already mentions tcm. Elsewhere,
register `tcm mcp` (stdio) as an MCP server run in the codebase's directory.

## What the agent gets

The server's instructions say how to work here: find code, `tcm_edit` it into a scratch file, edit that with the
agent's own file tools, `tcm_check`, `tcm_update`, fix what `tcm_todo` lists, `tcm_test`. Each tool runs the tcm
command of the same name, so it does exactly what that command does at a terminal, and results say what to do
next where there's a next step (dependents to fix, a check to save). A client that asks for progress hears each
line of a command's output as it comes (MCP progress notifications), so a long `tcm_test` shows its suites as
they finish.

| Tool | |
|---|---|
| `tcm_status` | where things stand: the branch, the codebase by namespace, scratch files holding unsaved work, what needs fixing, the [mirror](importing.md#mirrors) if there is one |
| `tcm_find` | names, docs and signatures; `:<type>` searches [by type](search.md) |
| `tcm_view`, `tcm_docs` | definitions with current names and where they run, as Markdown: a line with each one's names, hash and placement, then its code (or a file's content) in a highlighted block; documentation, examples evaluated |
| `tcm_deps`, `tcm_dependents` | what a definition uses, and what uses it |
| `tcm_edit` | definitions into a scratch file, its path and contents returned (the contents in a highlighted block); a scratch file holding unsaved work keeps it: the definitions are added to it |
| `tcm_patch` | a small change in one step: find-and-replace on a definition's code as `tcm_view` shows it, checked and saved as `tcm_update` does, the change shown; nothing is saved if an edit doesn't apply or the result doesn't typecheck |
| `tcm_at` | which definition is at a line of a file (a stack trace's, a search result's), or every definition in a file with its lines |
| `tcm_check`, `tcm_update` | what saving a scratch file would do; saving it |
| `tcm_todo` | conflicts, and dependents that stopped typechecking |
| `tcm_test`, `tcm_run` | tests (cached by hash, `names` for only some, `fresh` to run them all) and [suites](testing.md#suites-testing-a-command-as-a-program) (cached by the code they ran, `definitions` to leave them out); running a definition |
| `tcm_mv`, `tcm_rm`, `tcm_history` | renaming, removing, history |
| `tcm_merge` | in a [session](#several-agents-at-once-sessions): land its branch on `main`, once the tests the change reaches pass |
| `tcm_cli` | any other command ([CLI](cli.md)) |
| `tcm_guide` | longer explanations, by topic: the model, editing, testing, apps, packages and releases, mirrors, troubleshooting |

## Several agents at once: sessions

Agents can work in one codebase at the same time, each in a session: `tcm mcp --branch agent/a`, or
`tcm mcp --session` for a new branch of its own each time it starts (`session/<date>-<id>`), which is what an
`.mcp.json` every agent shares wants. With `--session`, an agent that's the only one working on the codebase (no
other `tcm mcp` running on it: each records itself in `.tcm/mcp/`) works on the codebase's own branch instead,
with nothing to merge; its instructions say so. A session:

- **works on its own branch** (made from the codebase's own if it's new), whatever the others do: `tcm switch` is
  refused there, and every command it runs is on its branch (`TCM_BRANCH` names it, for the CLI too);
- **has its own scratch files and `#codebase` imports**, in `.tcm/sessions/<branch>/`: a scratch file named by
  itself (`scratch.ts`) is there, one with a path is where the path says;
- **leaves the repository's files alone**: a [mirror](importing.md#mirrors) follows the branch it was linked on
  (`main`), so a session's work reaches the files when it lands there;
- **lands with `tcm_merge`**: `main` is merged into the session's branch first (conflicts, and dependents it broke,
  are the session's to fix, then `tcm_merge` again), the tests the change reaches run, and only if they pass is
  the branch merged into `main`. The agent's instructions say all this.

Test results are cached by hash, for everyone: a test one session ran doesn't run again in another for the same
code. A session is also how to keep working while something long reads `main` (`pnpm verify` in tcm's own
repository): the session's changes don't touch it until they land.

## A new tcm, without restarting

`tcm mcp` runs the server under a small supervisor. When tcm is replaced (upgraded, or, in tcm's own repository, a
new known-good build verified), the supervisor starts the server again between requests, replays the client's
handshake, and tells the client its tools changed (`notifications/tools/list_changed`), so new tools and fixes
reach a running agent without restarting it.

## Without MCP

The CLI is the same workflow: `tcm edit <name>`, edit the scratch file, `tcm check`, `tcm update`, `tcm todo`,
`tcm test`. `tcm help` lists every command.
