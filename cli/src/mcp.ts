// `tcm mcp`: tcm for AI agents, as a Model Context Protocol server (JSON-RPC over stdio). Working in a codebase
// isn't how agents usually work with code: there are no source files to edit, definitions are found and changed
// through tcm, and a change re-hashes what depends on it. The server teaches that (its instructions, and
// tcm_guide), and gives the steps as tools, each one a tcm command run in its own process (the agent sees what a
// person at a terminal would), with what to do next where there's a next step.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { IR_VERSION } from "@tcm/core";
import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import os from "node:os";

/** What the model is told when it connects: the way of working, in brief. tcm_guide has the rest. */
export const INSTRUCTIONS = `This project's code is a tcm codebase (.tcm/codebase.sqlite): Unison's codebase model for TypeScript. Each top-level definition is stored by the hash of its code, and names (dotted paths, like lib.math.square) point at hashes. The codebase is the truth: there are no source files to edit (anything under .tcm/ is generated).

To change code:
1. Find it: tcm_find searches names, docs and signatures (or types: ":(xs: T[]) => T"); tcm_view shows definitions with their current names; tcm_dependents and tcm_deps follow references; tcm_at says which definition a line of a file (a stack trace's, say) is in.
2. For a small change, tcm_patch does it in one step: find-and-replace on a definition's code as tcm_view shows it, checked and saved. For more, tcm_edit the definitions you'll change. It writes them into a scratch file: ordinary TypeScript that imports the rest of the codebase from "#codebase/…". Edit that file with your usual file tools. New definitions go in a scratch file too, below a "// tcm: namespace a.b" line.
3. tcm_check typechecks the file and says what saving would do; tcm_update saves it. Dependents are re-hashed automatically; any that stop typechecking are in tcm_todo: fix them the same way (tcm_edit, then tcm_update).
4. Tests are definitions named test… (or anything under a tests namespace). tcm_test runs them, cached by hash: only the tests your change reaches run again.

Renames are tcm_mv: references are by hash, so nothing else changes. tcm_status shows where things stand: what's in the codebase, unsaved scratch work, and what needs doing. tcm_guide explains more: the model, editing, testing, apps, packages and releases, mirrors. Any other command: tcm_cli.`;

const GUIDE: Record<string, string> = {
  model: `# The model

- A definition is a top-level function, const, class, type or interface. Its hash covers its code, with local names and formatting left out, and the hashes of what it uses. Comments and docs aren't part of it.
- Names are pointers: tcm_mv renames for free, and two names can point at one definition (tcm_cli ["alias", …]).
- A change to a definition gives it a new hash. Everything that uses it is re-hashed automatically (an update propagates), so there's never a stale build. What stops typechecking goes to tcm_todo rather than breaking silently.
- History is kept per command: tcm_cli ["history"], ["diff"], ["reset", "<n>"] undo anything. Branches: tcm_cli ["branch", "x"], ["switch", "x"], ["merge", "x"].
- Packages: imports of npm packages are pinned by compatible range and installed by tcm; nothing to npm install.`,
  editing: `# Editing

- tcm_edit ["lib.math.square", "lib.math.cube"] writes those definitions to a scratch file (scratch.ts unless you give one) with "// tcm: path …" lines saying where each goes back. Edit the file, then tcm_check, then tcm_update.
- A scratch file is ordinary TypeScript. It imports codebase definitions from "#codebase/<namespace path>" (import { square } from "#codebase/lib/math"), npm packages by name, Node builtins as "node:…".
- New definitions: put "// tcm: namespace lib.math" at the top of a scratch file and write them; tcm_update adds them there.
- Bare expressions in a scratch file (square(4)) are watch expressions: tcm_check evaluates and shows them, nothing saves them.
- Only top-level const (not let/var), function, class, type and interface; enums, namespaces and decorators aren't supported (use an as-const object).
- Definitions that refer to each other are a cycle, hashed and updated together. tcm_edit writes only the ones you name (and says what they're in a cycle with); saving saves the rest of the cycle with them, as it is.
- After tcm_update, check tcm_todo: dependents that no longer typecheck are listed there with the error.
- To undo: tcm_cli ["reset", "1"] brings back the names as they were before the last command.`,
  testing: `# Testing

- A test is a definition named test… (testSortIsStable) or any definition under a tests namespace. It passes by returning (or resolving) without throwing; expect and vi come from "vitest", node:assert works too.
- tcm_test [namespace] runs them with Vitest, in Node (or Chrome when a test renders a component with state). Results are cached by hash: a re-run only runs tests whose code, or something they use, changed. fresh: true runs everything.
- Tests in a scratch file run when you tcm_check it.
- A package can declare suites: test files that run its command as a program (manifest suites: { cmd: ["test/*.test.ts"] }). tcm_test runs them too, each only if code it ran changed; definitions: true leaves them out.`,
  apps: `# Apps

- An app is a definition (a React component, or a handler); tcm_cli ["dev", "<name>"] serves it while you work, ["build", …] and ["start", …] for production.
- Where code runs (server or browser) is inferred from what it uses: no "use client"/"use server". A browser function calling a server one becomes a call by hash. tcm_view shows where each definition runs.
- #tcm/server has the server API: requests, sessions, typed tables (table<Row>("name")), background jobs (enqueue, every).`,
  packages: `# Packages and releases

- A definition named manifest makes its namespace a package: { name, exports, bin, with, files }.
- tcm_cli ["release", "check", "<pkg>"] shows the next version, from semver checks on the package's API since its last release; ["release", "<pkg>"] makes it (["release", "<pkg>", "--draft"] first, to write a summary).
- tcm_cli ["pack", "<pkg>@<version>"] makes the npm package; publishing is done by hand.`,
  mirrors: `# Mirrors

- A codebase can mirror a directory of source files (tcm_cli ["import", "<dir>", "--into", "<ns>", "--mirror"]): changes made in tcm are written back to those files as edits, so git and other editors see them. A new namespace gets a file; a rename reaches files near the mirror that use the name (scripts, tests). tcm_status says whether there's one.
- With a mirror you can also edit its files directly (or git can: a pull, a checkout): the next tool call imports what changed first, definitions removed from the files included. A file that doesn't import yet (an edit half made) isn't written to until it does.
- Releases of a mirrored codebase are recorded with its files (tcm-releases.json) and need the files committed first.`,
  troubleshooting: `# When something goes wrong

- "not in the codebase" from an import in a scratch file: the name is wrong, tcm_find it.
- tcm_update says "conflict": two definitions share a name now; tcm_cli ["resolve", "<name>", "#<hash>"] picks one.
- A test passes from cache but you changed something outside the codebase (a file, the network): tcm_test with fresh: true.
- tcm_cli ["verify"] re-renders and re-hashes everything; it must report the identity.
- tcm_cli ["help"] lists every command; tcm_cli ["<command>", "--help"] explains one.`,
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** the tcm command to run, from the arguments */
  argv?: (a: Record<string, unknown>) => string[];
  run?: (a: Record<string, unknown>, ctx: Ctx) => Promise<Result>;
}

interface Result {
  text: string;
  isError?: boolean;
}

interface Ctx {
  root: string;
  /** the session's branch (`tcm mcp --branch`), if this server is one */
  branch?: string;
  /** run a tcm command; `onLine` hears its output as it comes; `env` adds to its environment */
  tcm: (argv: string[], onLine?: (line: string) => void, env?: Record<string, string>) => Promise<{ code: number; out: string }>;
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : String(v));
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(/\s+/) : []);
const schema = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const names = { type: "array", items: { type: "string" }, description: "dotted names (lib.math.square) or #hashes" };

/** A short note on what to do after a command, from what it printed. */
function next(argv: string[], out: string, code: number): string | undefined {
  if (argv[0] === "update" || argv[0] === "add") {
    if (/no longer typecheck|tcm todo/.test(out)) return "Some dependents no longer typecheck: see tcm_todo, and fix them with tcm_edit + tcm_update.";
    if (code === 0) return "Saved. tcm_test runs the tests this reaches.";
  }
  if (argv[0] === "check" && code === 0 && /~ update|\+ new/.test(out)) return "tcm_update saves it.";
  return undefined;
}

const TOOLS: Tool[] = [
  {
    name: "tcm_status",
    description: "Where things stand: the branch you're on, the codebase by namespace (with how many definitions each), scratch files holding unsaved work (and what saving them would do), what needs fixing (todo), and whether a mirror's files are in step. Start here.",
    inputSchema: schema({}),
    argv: () => ["status"],
  },
  {
    name: "tcm_find",
    description: 'Search the codebase: words match names, docs and signatures; a query starting with ":" is a type, matched up to renaming, argument order, async and generality (":(xs: T[]) => T").',
    inputSchema: schema({ query: { type: "string", description: 'words, or ":<type>"' } }, ["query"]),
    argv: (a) => ["find", ...(str(a.query).trim().startsWith(":") ? [str(a.query).trim()] : str(a.query).split(/\s+/).filter(Boolean))],
  },
  {
    name: "tcm_view",
    description: "Show definitions as code, with current names, where each runs (server, browser, anywhere) and its hash.",
    inputSchema: schema({ names: names }, ["names"]),
    run: async (a, ctx) => {
      const r = await ctx.tcm(["view", ...strs(a.names)]);
      return r.code === 0 ? { text: viewMarkdown(r.out) } : { text: r.out, isError: true };
    },
  },
  { name: "tcm_deps", description: "What a definition uses (codebase definitions, packages).", inputSchema: schema({ name: { type: "string" } }, ["name"]), argv: (a) => ["deps", str(a.name)] },
  { name: "tcm_dependents", description: "What uses a definition: what a change to it re-hashes.", inputSchema: schema({ name: { type: "string" } }, ["name"]), argv: (a) => ["dependents", str(a.name)] },
  { name: "tcm_docs", description: "A definition's documentation, with its examples evaluated.", inputSchema: schema({ name: { type: "string" } }, ["name"]), argv: (a) => ["docs", str(a.name)] },
  {
    name: "tcm_edit",
    description: "Write definitions to a scratch file for editing (default scratch.ts, or scratch.tsx for JSX), with lines saying where each goes back. A scratch file holding unsaved work keeps it: the definitions are added to it. Returns the file's path and contents: edit it with your file tools, then tcm_check and tcm_update.",
    inputSchema: schema({ names: names, file: { type: "string", description: "the scratch file (relative to the project)" }, force: { type: "boolean", description: "replace what a scratch file holds, even definitions that aren't saved, instead of adding to it" } }, ["names"]),
    run: async (a, ctx) => {
      const argv = (file?: string) => ["edit", ...strs(a.names), ...(file ? ["--file", file] : []), ...(a.force ? ["--force"] : [])];
      const r = await ctx.tcm(argv(a.file ? str(a.file) : undefined));
      if (r.code !== 0) return { text: r.out, isError: true };
      const file = /(?:wrote|added) .* to (\S+)/.exec(r.out)?.[1] ?? /in (\S+) already/.exec(r.out)?.[1] ?? str(a.file);
      const abs = file && path.resolve(ctx.root, file);
      const body = abs && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      const shown = abs ? `\`${abs}\`:\n\n${fence(body.trimEnd(), LANG[path.extname(abs).slice(1)] ?? "")}\n\n` : "";
      return { text: `${r.out}\n\n${shown}Edit the file, then tcm_check and tcm_update.` };
    },
  },
  {
    name: "tcm_patch",
    description:
      "Change a definition by find-and-replace on its code, as tcm_view shows it (current names), and save it as tcm_update does: checked, its dependents re-hashed, the tests it reaches named. Each `old` must be in it exactly once (or set `all`). Nothing is saved if an edit doesn't apply or the result doesn't typecheck. The quick way to make a small change; tcm_edit is for bigger ones.",
    inputSchema: schema(
      {
        name: { type: "string", description: "the definition" },
        edits: { type: "array", items: schema({ old: { type: "string" }, new: { type: "string" } }, ["old", "new"]), description: "what to find, and what replaces it, in order" },
        all: { type: "boolean", description: "replace every place each old text is" },
      },
      ["name", "edits"],
    ),
    argv: (a) => ["patch", str(a.name), "--edits", JSON.stringify(a.edits), ...(a.all ? ["--all"] : [])],
  },
  {
    name: "tcm_at",
    description: "Which definition is at a line of a file (a scratch file, a definition's document in .tcm/src, a generated module in .tcm/cache as stack traces name them, a mirrored file); without a line, every definition in the file with its lines.",
    inputSchema: schema({ place: { type: "string", description: "<file>[:<line>], relative to the project" } }, ["place"]),
    argv: (a) => ["at", str(a.place)],
  },
  {
    name: "tcm_check",
    description: "Typecheck a scratch file and say what saving it would do (new, update, identical, conflict); watch expressions and tests in it are run.",
    inputSchema: schema({ file: { type: "string", description: "the scratch file (default scratch.ts)" } }),
    argv: (a) => ["check", ...(a.file ? [str(a.file)] : [])],
  },
  {
    name: "tcm_update",
    description: "Save a scratch file: new definitions are added, changed ones replace the old, and everything depending on them is re-hashed. Dependents that stop typechecking go to tcm_todo.",
    inputSchema: schema({ file: { type: "string", description: "the scratch file (default scratch.ts)" } }),
    argv: (a) => ["update", ...(a.file ? [str(a.file)] : [])],
  },
  { name: "tcm_todo", description: "What needs fixing: conflicted names, and dependents that stopped typechecking (with the error).", inputSchema: schema({}), argv: () => ["todo"] },
  {
    name: "tcm_test",
    description: "Run tests (definitions named test…, or under a tests namespace), optionally only some (by name or namespace), and the suites packages declare (test files running a package's command). Results are cached by hash: only tests whose code or dependencies changed run again, and only suites that ran code that changed.",
    inputSchema: schema({
      names: { type: "array", items: { type: "string" }, description: "only these tests, or the tests under these namespaces" },
      fresh: { type: "boolean", description: "run everything again, ignoring cached results" },
      definitions: { type: "boolean", description: "only the test definitions, not the suites (which can take minutes when much changed)" },
    }),
    argv: (a) => ["test", ...(Array.isArray(a.names) ? strs(a.names) : []), ...(a.fresh ? ["--fresh"] : []), ...(a.definitions ? ["--definitions"] : [])],
  },
  {
    name: "tcm_run",
    description: "Run a definition: a function is called with the arguments; what it prints, and a number it returns as the exit code.",
    inputSchema: schema({ name: { type: "string" }, args: { type: "array", items: { type: "string" } } }, ["name"]),
    argv: (a) => ["run", str(a.name), "--", ...strs(a.args)],
  },
  { name: "tcm_mv", description: "Rename a definition or namespace. References are by hash, so no code changes.", inputSchema: schema({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]), argv: (a) => ["mv", str(a.from), str(a.to)] },
  { name: "tcm_rm", description: "Remove names (refused while something depends on them).", inputSchema: schema({ names: names }, ["names"]), argv: (a) => ["rm", ...strs(a.names)] },
  { name: "tcm_history", description: "This branch's history: an entry per command and what it changed. tcm_cli [\"reset\", \"<n>\"] goes back.", inputSchema: schema({ n: { type: "number" } }), argv: (a) => ["history", String(a.n ?? 10)] },
  {
    name: "tcm_merge",
    description:
      "Land this session's branch on main (or `into`): main is merged into the branch first (conflicts and broken dependents are the session's to fix, then tcm_merge again), then the tests the change reaches run, and only if they pass is the branch merged into main, which the repository's files follow. Only in a session (`tcm mcp --branch`).",
    inputSchema: schema({ into: { type: "string", description: "the branch to land on (default main)" } }),
    run: async (a, ctx) => {
      if (!ctx.branch) return { text: "tcm_merge lands a session's branch: start this server as a session (`tcm mcp --branch <name>`)", isError: true };
      const into = str(a.into) || "main";
      if (into === ctx.branch) return { text: `this session is on ${into} already`, isError: true };
      const said: string[] = [];
      // what's on the target since the branch was made, here first: it's tested together
      const up = await ctx.tcm(["merge", into]);
      said.push(`merging ${into} into ${ctx.branch}:\n${up.out}`);
      if (up.code !== 0) return { text: `${said.join("\n\n")}\n\nFix the conflicts on ${ctx.branch} (tcm_todo, tcm_cli ["resolve", …]), then tcm_merge again.`, isError: true };
      const todo = await ctx.tcm(["todo"]);
      if (todo.out.trim() && !/^nothing to do$/.test(todo.out.trim())) return { text: `${said.join("\n\n")}\n\n${todo.out}\n\nFix these on ${ctx.branch} (tcm_edit, tcm_update), then tcm_merge again.`, isError: true };
      const tests = await ctx.tcm(["test"]);
      if (tests.code !== 0) return { text: `${said.join("\n\n")}\n\ntesting ${ctx.branch}:\n${tests.out}\n\nThese fail on ${ctx.branch}: nothing landed on ${into}.`, isError: true };
      said.push(`testing ${ctx.branch}: ${tests.out.split("\n").filter((l) => /passed|no tests/.test(l)).join("; ")}`);
      // then the branch, on the target, as the target's own (its session is TCM_BRANCH, for this one command)
      const land = await ctx.tcm(["merge", ctx.branch], undefined, { TCM_BRANCH: into });
      said.push(`landing on ${into}:\n${land.out}`);
      if (land.code !== 0) return { text: `${said.join("\n\n")}\n\n${into} moved meanwhile, and merging into it conflicts: tcm_merge again brings it in.`, isError: true };
      return { text: `${said.join("\n\n")}\n\n${ctx.branch} is on ${into}.` };
    },
  },
  {
    name: "tcm_cli",
    description: 'Any tcm command, as its arguments (["help"] lists them; ["<command>", "--help"] explains one): branches, merges, apps, packages, releases, lint, fmt, verify.',
    inputSchema: schema({ args: { type: "array", items: { type: "string" } } }, ["args"]),
    argv: (a) => strs(a.args),
  },
  {
    name: "tcm_guide",
    description: `How to work in a tcm codebase, by topic: ${Object.keys(GUIDE).join(", ")}.`,
    inputSchema: schema({ topic: { type: "string", enum: Object.keys(GUIDE) } }, ["topic"]),
    run: async (a) => ({ text: GUIDE[str(a.topic)] ?? `topics: ${Object.keys(GUIDE).join(", ")}` }),
  },
];

const MAX = 60_000;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Serve MCP on stdin/stdout. Each tool runs `tcm` (this same program: `bin`) in `root`, so a tool does exactly
 * what the command does at a terminal, without its output reaching the protocol channel.
 */
export function serveMcp(root: string, bin: string[], version: string, branch?: string) {
  const tcm = (argv: string[], onLine?: (line: string) => void, env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(bin[0]!, [...bin.slice(1), ...argv], { cwd: root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let heard = 0;
      const hear = (d: Buffer) => {
        out += d;
        if (!onLine) return;
        const end = out.lastIndexOf("\n");
        if (end < heard) return;
        for (const line of plain(out.slice(heard, end)).split("\n")) if (line.trim()) onLine(line);
        heard = end + 1;
      };
      child.stdout.on("data", hear);
      child.stderr.on("data", hear);
      child.on("close", (code) => resolve({ code: code ?? 1, out: plain(out).trim() }));
    });
  const ctx: Ctx = { root, tcm, ...(branch ? { branch } : {}) };
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const handle = async (m: { id?: number | string; method?: string; params?: Record<string, unknown> }) => {
    const reply = (result: unknown) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code: number, message: string) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: (m.params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "tcm", version: `${version} (hash format v${IR_VERSION})` },
          instructions: branch
            ? `${INSTRUCTIONS}\n\nThis is a session on its own branch, ${branch}: your changes stay on it, and out of the repository's files, while other agents work on other branches of the same codebase. When your change is done and its tests pass, tcm_merge lands it on main (merging main in first, then testing).`
            : process.env.TCM_MCP_ALONE
              ? `${INSTRUCTIONS}\n\nYou're the only agent working on this codebase, so your changes go straight to its own branch (and the files it writes), with no merging to do. An agent starting while you're here gets a branch of its own.`
              : INSTRUCTIONS,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === m.params?.name);
        if (!tool) return fail(-32602, `no tool ${String(m.params?.name)}`);
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          // a client that asked for progress hears the command's output as it comes: some take minutes
          const token = (m.params?._meta as { progressToken?: string | number } | undefined)?.progressToken;
          let progress = 0;
          const onLine = token === undefined ? undefined : (line: string) => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, message: line } });
          let r: Result;
          if (tool.run) r = await tool.run(args, { ...ctx, tcm: (argv: string[], heard?: (line: string) => void, env?: Record<string, string>) => tcm(argv, heard ?? onLine, env) });
          else {
            const argv = tool.argv!(args);
            const { code, out } = await tcm(argv, onLine);
            const hint = next(argv, out, code);
            r = { text: [out || (code === 0 ? "done" : `tcm ${argv[0]} failed`), hint].filter(Boolean).join("\n\n"), isError: code !== 0 };
          }
          const text = r.text.length > MAX ? `${r.text.slice(0, MAX)}\n… (${r.text.length - MAX} more characters)` : r.text;
          return reply({ content: [{ type: "text", text }], isError: !!r.isError });
        } catch (e) {
          return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        if (m.method?.startsWith("notifications/")) return;
        return fail(-32601, `no method ${String(m.method)}`);
    }
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let m: Parameters<typeof handle>[0];
      try {
        m = JSON.parse(line) as Parameters<typeof handle>[0];
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      void handle(m);
    }
  });
  return new Promise<void>((resolve) => process.stdin.on("end", () => resolve()));
}

/**
 * The language a client highlights a file in, by its extension (or a file definition's format).
 */
export const LANG: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", md: "markdown", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", sh: "sh", css: "css", html: "html", svg: "xml", csv: "csv" }

/**
 * `text` as a Markdown code block in `lang`: its fence longer than any run of backticks inside it.
 */
export function fence(text: string, lang: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${text}\n${f}`;
}

/**
 * `tcm view`'s output as Markdown, for clients that render it: for each definition a line with its names, hash and
 * where it runs, then its code (or a file's content) as a highlighted block.
 */
export function viewMarkdown(out: string): string {
  const header = /^\/\/ (\S+(?:, \S+)*) (#[a-z2-7]{8,}) ?(.*)$/;
  const blocks: { names: string; hash: string; rest: string; lines: string[] }[] = [];
  for (const line of out.split("\n")) {
    const m = header.exec(line);
    if (m) blocks.push({ names: m[1]!, hash: m[2]!, rest: m[3]!, lines: [] });
    else if (blocks.length) blocks.at(-1)!.lines.push(line);
  }
  if (!blocks.length) return out;
  return blocks
    .map((b) => {
      while (b.lines.length && !b.lines.at(-1)!.trim()) b.lines.pop();
      // code says its type after a colon; a file, its format
      const file = !b.rest.startsWith(":");
      const runs = !file && b.lines[0]?.startsWith("// runs ") ? b.lines.shift()!.slice(3) : undefined;
      const about = file ? `${b.rest || "text"} file` : runs;
      return `**${b.names}** \`${b.hash}\`${about ? ` · ${about}` : ""}\n\n${fence(b.lines.join("\n"), file ? (LANG[b.rest] ?? "") : "ts")}`;
    })
    .join("\n\n");
}

/**
 * The id the supervisor gives the handshake it replays to a restarted server.
 */
export const REINIT = "tcm-supervisor-reinit";

/**
 * The MCP servers running on a codebase now (the records of ones that stopped are cleared away).
 */
export function liveMcpServers(root: string): { pid: number; branch?: string }[] {
  const dir = serversDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => {
    const file = path.join(dir, f);
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; branch?: string };
      process.kill(s.pid, 0);
      return [s];
    } catch {
      fs.rmSync(file, { force: true });
      return [];
    }
  });
}

/**
 * Say this process is an MCP server on the codebase (on `branch`); undone when it exits.
 */
export function registerMcpServer(root: string, branch: string | undefined) {
  const file = path.join(serversDir(root), `${process.pid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ...(branch ? { branch } : {}) }));
  const gone = () => fs.rmSync(file, { force: true });
  process.on("exit", gone);
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => process.exit(0));
}

/**
 * Where the MCP servers running on a codebase say so: a file each, by process id, with its branch.
 */
export const serversDir = (root: string) => path.join(root, ".tcm", "mcp");

/**
 * When a file was last replaced or written, to notice a new version: its inode and time, or undefined if it's gone.
 */
export function stampOf(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * Run the MCP server `argv` as a child and relay the protocol, starting it again when `watch` (this tcm's own
 * program) is replaced: a new version installed, or a new known-good tcm verified. The restart waits until no
 * request is in flight; the client's handshake is replayed to the new server, and the client is told the tools
 * changed. So an agent picks up a new tcm, tools and all, without restarting. Resolves with the server's exit code.
 */
export function superviseMcp(argv: string[], env: NodeJS.ProcessEnv, cwd: string, watch: string, poll = 2000): Promise<number> {
  return new Promise((resolve) => {
    let current: ChildProcess | undefined;
    let init: string | undefined;
    let initialized: string | undefined;
    const inFlight = new Set<string>();
    let restarting = false;
    let pending = false;
    let held: string[] = [];
    let stamp = stampOf(watch);
    const write = (line: string) => process.stdout.write(line + "\n");
    const toChild = (line: string) => {
      try {
        const msg = JSON.parse(line) as { id?: unknown; method?: string };
        if (msg.method === "initialize") init = line;
        if (msg.method === "notifications/initialized") initialized = line;
        if (msg.id !== undefined && msg.method) inFlight.add(JSON.stringify(msg.id));
      } catch {
        // not ours to understand: passed on as it is
      }
      current!.stdin!.write(line + "\n");
    };
    const start = (replay: boolean) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
      current = child;
      let buf = "";
      child.stdout!.setEncoding("utf8").on("data", (d: string) => {
        buf += d;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: { id?: unknown; result?: unknown; error?: unknown } = {};
          try {
            msg = JSON.parse(line);
          } catch {
            // passed on as it is
          }
          // the replayed handshake answered: the new server is ready, and the client hears what changed
          if (msg.id === REINIT) {
            if (initialized) child.stdin!.write(initialized + "\n");
            restarting = false;
            write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
            const waiting = held;
            held = [];
            for (const l of waiting) toChild(l);
            continue;
          }
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) inFlight.delete(JSON.stringify(msg.id));
          write(line);
          restartIfDue();
        }
      });
      child.on("exit", (code) => {
        // (a server replaced on purpose isn't the end)
        if (child !== current) return;
        clearInterval(timer);
        resolve(code ?? 0);
      });
      if (replay && init) child.stdin!.write(JSON.stringify({ ...JSON.parse(init), id: REINIT }) + "\n");
    };
    const restartIfDue = () => {
      if (!pending || restarting || inFlight.size || !init) return;
      pending = false;
      restarting = true;
      const old = current!;
      start(true);
      old.kill();
    };
    const timer = setInterval(() => {
      const now = stampOf(watch);
      if (!now || now === stamp) return;
      stamp = now;
      pending = true;
      restartIfDue();
    }, poll);
    start(false);
    let rest = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => {
      rest += d;
      for (let nl = rest.indexOf("\n"); nl >= 0; nl = rest.indexOf("\n")) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (!line.trim()) continue;
        if (restarting) held.push(line);
        else toChild(line);
      }
    });
    process.stdin.on("end", () => current?.stdin!.end());
  });
}

/**
 * A running server is seen as one; a stopped one's record is cleared.
 */
export const testLiveMcpServers = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tcm mcp servers "));
  fs.mkdirSync(serversDir(root), { recursive: true });
  fs.writeFileSync(path.join(serversDir(root), "1.json"), JSON.stringify({ pid: process.pid, branch: "session/x" }));
  fs.writeFileSync(path.join(serversDir(root), "2.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.deepEqual(liveMcpServers(root), [{ pid: process.pid, branch: "session/x" }]);
  assert.deepEqual(fs.readdirSync(serversDir(root)), ["1.json"]);
  fs.rmSync(root, { recursive: true, force: true });
}
