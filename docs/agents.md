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
next where there's a next step (dependents to fix, a check to save).

| Tool | |
|---|---|
| `tcm_status` | namespaces and how many definitions each holds, what needs fixing, the [mirror](importing.md#mirrors) if there is one |
| `tcm_find` | names, docs and signatures; `:<type>` searches [by type](search.md) |
| `tcm_view`, `tcm_docs` | definitions with current names and where they run; documentation, examples evaluated |
| `tcm_deps`, `tcm_dependents` | what a definition uses, and what uses it |
| `tcm_edit` | definitions into a scratch file, path and contents returned (a scratch file holding work is never overwritten: another is used) |
| `tcm_check`, `tcm_update` | what saving a scratch file would do; saving it |
| `tcm_todo` | conflicts, and dependents that stopped typechecking |
| `tcm_test`, `tcm_run` | tests (cached by hash, `fresh` to run them all); running a definition |
| `tcm_mv`, `tcm_rm`, `tcm_history` | renaming, removing, history |
| `tcm_cli` | any other command ([CLI](cli.md)) |
| `tcm_guide` | longer explanations, by topic: the model, editing, testing, apps, packages and releases, mirrors, troubleshooting |

## Without MCP

The CLI is the same workflow: `tcm edit <name>`, edit the scratch file, `tcm check`, `tcm update`, `tcm todo`,
`tcm test`. `tcm help` lists every command.
