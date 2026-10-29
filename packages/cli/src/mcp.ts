// `tcm mcp`: tcm for AI agents, as a Model Context Protocol server (JSON-RPC over stdio). Working in a codebase
// isn't how agents usually work with code: there are no source files to edit, definitions are found and changed
// through tcm, and a change re-hashes what depends on it. The server teaches that (its instructions, and
// tcm_guide), and gives the steps as tools, each one a tcm command run in its own process (the agent sees what a
// person at a terminal would), with what to do next where there's a next step.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { IR_VERSION } from "@tcm/core";

/** What the model is told when it connects: the way of working, in brief. tcm_guide has the rest. */
export const INSTRUCTIONS = `This project's code is a tcm codebase (.tcm/codebase.sqlite): Unison's codebase model for TypeScript. Each top-level definition is stored by the hash of its code, and names (dotted paths, like lib.math.square) point at hashes. The codebase is the truth: there are no source files to edit (anything under .tcm/ is generated).

To change code:
1. Find it: tcm_find searches names, docs and signatures (or types: ":(xs: T[]) => T"); tcm_view shows definitions with their current names; tcm_dependents and tcm_deps follow references.
2. tcm_edit the definitions you'll change. It writes them into a scratch file: ordinary TypeScript that imports the rest of the codebase from "#codebase/…". Edit that file with your usual file tools. New definitions go in a scratch file too, below a "// tcm: namespace a.b" line.
3. tcm_check typechecks the file and says what saving would do; tcm_update saves it. Dependents are re-hashed automatically; any that stop typechecking are in tcm_todo: fix them the same way (tcm_edit, then tcm_update).
4. Tests are definitions named test… (or anything under a tests namespace). tcm_test runs them, cached by hash: only the tests your change reaches run again.

Renames are tcm_mv: references are by hash, so nothing else changes. tcm_status shows what's in the codebase and what needs doing. tcm_guide explains more: the model, editing, testing, apps, packages and releases, mirrors. Any other command: tcm_cli.`;

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
- After tcm_update, check tcm_todo: dependents that no longer typecheck are listed there with the error.
- To undo: tcm_cli ["reset", "1"] brings back the names as they were before the last command.`,
  testing: `# Testing

- A test is a definition named test… (testSortIsStable) or any definition under a tests namespace. It passes by returning (or resolving) without throwing; expect and vi come from "vitest", node:assert works too.
- tcm_test [namespace] runs them with Vitest, in Node (or Chrome when a test renders a component with state). Results are cached by hash: a re-run only runs tests whose code, or something they use, changed. fresh: true runs everything.
- Tests in a scratch file run when you tcm_check it.`,
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
- With a mirror you can also edit its files directly, then import them: tcm_cli ["import", "<dir>", "--into", "<ns>", "--update"] (plus "--tests" if the codebase has the tests). A file changed by hand isn't overwritten by tcm until it's imported.
- Releases of a mirrored codebase are recorded with its files (tcm-releases.json) and need the files committed first.`,
  troubleshooting: `# When something goes wrong

- "not in the codebase" from an import in a scratch file: the name is wrong, tcm_find it.
- tcm_update says "conflict": two definitions share a name now; tcm_cli ["resolve", "<name>", "#<hash>"] picks one.
- A test passes from cache but you changed something outside the codebase (a file, the network): tcm_test with fresh: true.
- tcm_cli ["verify"] re-renders and re-hashes everything; it must report the identity.
- tcm_cli ["help"] lists every command; tcm_cli ["<command>", "--help"] explains one.`,
};

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
  tcm: (argv: string[]) => Promise<{ code: number; out: string }>;
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
    description: "What's in the codebase: its namespaces (with how many definitions each), what needs fixing (todo), and whether it mirrors a directory of source files. Start here.",
    inputSchema: schema({}),
    run: async (_a, ctx) => {
      const ls = await ctx.tcm(["ls"]);
      if (ls.code !== 0) return { text: ls.out, isError: true };
      const counts = new Map<string, number>();
      for (const line of ls.out.split("\n")) {
        const p = line.split(/\s+/)[0];
        if (!p || !/^[\w$.]+$/.test(p)) continue;
        const segs = p.split(".");
        const ns = segs.slice(0, Math.min(segs.length - 1, 3)).join(".") || "(root)";
        counts.set(ns, (counts.get(ns) ?? 0) + 1);
      }
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const todo = await ctx.tcm(["todo"]);
      const mirror = await ctx.tcm(["mirror"]);
      return {
        text: [
          `${total} named definitions, by namespace:`,
          ...[...counts].sort().map(([ns, n]) => `  ${ns}  ${n}`),
          "",
          `todo: ${todo.out || "nothing to do"}`,
          mirror.code === 0 ? `\n${mirror.out}` : "",
        ].join("\n"),
      };
    },
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
    inputSchema: schema({ names }, ["names"]),
    argv: (a) => ["view", ...strs(a.names)],
  },
  { name: "tcm_deps", description: "What a definition uses (codebase definitions, packages).", inputSchema: schema({ name: { type: "string" } }, ["name"]), argv: (a) => ["deps", str(a.name)] },
  { name: "tcm_dependents", description: "What uses a definition: what a change to it re-hashes.", inputSchema: schema({ name: { type: "string" } }, ["name"]), argv: (a) => ["dependents", str(a.name)] },
  { name: "tcm_docs", description: "A definition's documentation, with its examples evaluated.", inputSchema: schema({ name: { type: "string" } }, ["name"]), argv: (a) => ["docs", str(a.name)] },
  {
    name: "tcm_edit",
    description: "Write definitions to a scratch file for editing (default scratch.ts, or scratch.tsx for JSX), with lines saying where each goes back. Returns the file's path and contents: edit it with your file tools, then tcm_check and tcm_update.",
    inputSchema: schema({ names, file: { type: "string", description: "the scratch file (relative to the project)" }, force: { type: "boolean", description: "overwrite a scratch file holding definitions that aren't saved" } }, ["names"]),
    run: async (a, ctx) => {
      const argv = (file?: string) => ["edit", ...strs(a.names), ...(file ? ["--file", file] : []), ...(a.force ? ["--force"] : [])];
      let r = await ctx.tcm(argv(a.file ? str(a.file) : undefined));
      // the default scratch file holds work: never overwrite it unasked, use another
      for (let n = 2; !a.file && !a.force && r.code !== 0 && /is not empty/.test(r.out) && n < 50; n++) {
        const ext = /scratch\.tsx/.test(r.out) ? "tsx" : "ts";
        r = await ctx.tcm(argv(`scratch-${n}.${ext}`));
      }
      if (r.code !== 0) return { text: r.out, isError: true };
      const file = /wrote .* to (\S+)/.exec(r.out)?.[1] ?? str(a.file);
      const abs = file && path.resolve(ctx.root, file);
      const body = abs && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      return { text: `${r.out}\n\n${abs ? `${abs}:\n\n${body}` : ""}\nEdit the file, then tcm_check and tcm_update.` };
    },
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
    description: "Run tests (definitions named test…, or under a tests namespace), optionally in one namespace. Results are cached by hash: only tests whose code or dependencies changed run again.",
    inputSchema: schema({ namespace: { type: "string" }, fresh: { type: "boolean", description: "run everything again, ignoring cached results" } }),
    argv: (a) => ["test", ...(a.namespace ? [str(a.namespace)] : []), ...(a.fresh ? ["--fresh"] : [])],
  },
  {
    name: "tcm_run",
    description: "Run a definition: a function is called with the arguments; what it prints, and a number it returns as the exit code.",
    inputSchema: schema({ name: { type: "string" }, args: { type: "array", items: { type: "string" } } }, ["name"]),
    argv: (a) => ["run", str(a.name), "--", ...strs(a.args)],
  },
  { name: "tcm_mv", description: "Rename a definition or namespace. References are by hash, so no code changes.", inputSchema: schema({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]), argv: (a) => ["mv", str(a.from), str(a.to)] },
  { name: "tcm_rm", description: "Remove names (refused while something depends on them).", inputSchema: schema({ names }, ["names"]), argv: (a) => ["rm", ...strs(a.names)] },
  { name: "tcm_history", description: "This branch's history: an entry per command and what it changed. tcm_cli [\"reset\", \"<n>\"] goes back.", inputSchema: schema({ n: { type: "number" } }), argv: (a) => ["history", String(a.n ?? 10)] },
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
export function serveMcp(root: string, bin: string[], version: string) {
  const tcm = (argv: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(bin[0]!, [...bin.slice(1), ...argv], { cwd: root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code: code ?? 1, out: plain(out).trim() }));
    });
  const ctx: Ctx = { root, tcm };
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
          instructions: INSTRUCTIONS,
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
          let r: Result;
          if (tool.run) r = await tool.run(args, ctx);
          else {
            const argv = tool.argv!(args);
            const { code, out } = await tcm(argv);
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
