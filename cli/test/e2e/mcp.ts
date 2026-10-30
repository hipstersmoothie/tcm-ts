// `tcm mcp`: the codebase's tools for AI agents, over the Model Context Protocol, used as an agent would.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { plainEnv, tcmBin, tempDir, withChildren } from "./harness.ts";
import { okIn } from "./harness.ts";

type Reply = { result?: Record<string, unknown>; error?: { message: string } };

/**
 * `tcm mcp` as an agent's client runs it (with `args`: `--branch agent/a` for a session).
 */
function session(dir: string, keep: <C extends ChildProcess>(c: C) => C, ...args: string[]) {
  const child = keep(spawn(process.execPath, [tcmBin(), "mcp", ...args], { cwd: dir, env: plainEnv(), stdio: ["pipe", "pipe", "pipe"] }));
  let buf = "";
  let id = 0;
  const waiting = new Map<number, (m: Reply) => void>();
  const notes: { method: string; params: Record<string, unknown> }[] = [];
  child.stdout.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, nl)) as { id?: number; method?: string; params?: Record<string, unknown> } & Reply;
      buf = buf.slice(nl + 1);
      if (m.id === undefined) notes.push({ method: m.method!, params: m.params! });
      else waiting.get(m.id)?.(m);
    }
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Reply>((resolve) => {
      const i = ++id;
      waiting.set(i, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
    const r = await request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const result = r.result as { content: { text: string }[]; isError: boolean };
    return { text: result.content[0]!.text, isError: result.isError };
  };
  return { request, call, notes, close: () => child.stdin.end() };
}

/** An agent works in the codebase through tcm mcp: find, edit, check, update, test. */
export const testAgentWorksThroughMcp = () =>
  withChildren(async (keep) => {
    const dir = tempDir("mcp");
    const env = plainEnv();
    assert.equal(spawnSync(process.execPath, [tcmBin(), "init"], { cwd: dir, env }).status, 0);
    // init tells agents how to work here
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.tcm, { command: "tcm", args: ["mcp"] });
    assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /tcm codebase[\s\S]*tcm_edit/);
    fs.writeFileSync(
      path.join(dir, "scratch.ts"),
      `// tcm: namespace lib\nimport assert from "node:assert/strict";\nexport const square = (x: number): number => x * x;\nexport const area = (s: number): number => square(s);\nexport const testArea = () => assert.equal(area(3), 9);\n`,
    );
    assert.equal(spawnSync(process.execPath, [tcmBin(), "add"], { cwd: dir, env }).status, 0);

    const s = session(dir, keep);
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.match(String(init.result!.instructions), /tcm_edit the definitions you'll change/);
    const tools = ((await s.request("tools/list")).result!.tools as { name: string }[]).map((t) => t.name);
    for (const t of ["tcm_status", "tcm_find", "tcm_view", "tcm_edit", "tcm_check", "tcm_update", "tcm_todo", "tcm_test", "tcm_mv", "tcm_cli", "tcm_guide"]) assert.ok(tools.includes(t), t);

    assert.match((await s.call("tcm_status")).text, /3 named definitions[\s\S]*lib {2}3[\s\S]*nothing to do/);
    assert.match((await s.call("tcm_find", { query: ":(x: number) => number" })).text, /lib\.square/);

    // edit: scratch.ts holds work already, so the definition goes to another scratch file
    fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nexport const draft = 1;\n`);
    const edited = await s.call("tcm_edit", { names: ["lib.square"] });
    // (the file as a highlighted block, for clients that render Markdown)
    assert.match(edited.text, /wrote lib\.square to scratch-2\.ts[\s\S]*scratch-2\.ts`:\n\n```ts\n\/\/ tcm: [\s\S]*export const square[\s\S]*\n```\n\nEdit the file, then tcm_check and tcm_update/);
    const file = path.join(dir, "scratch-2.ts");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("x * x", "x ** 2"));
    assert.match((await s.call("tcm_check", { file: "scratch-2.ts" })).text, /~ update +lib\.square[\s\S]*tcm_update saves it/);
    const updated = await s.call("tcm_update", { file: "scratch-2.ts" });
    assert.match(updated.text, /~ updated +lib\.area \(dependent\)[\s\S]*tcm_test runs the tests/);
    // a definition: its name, hash and where it runs, then its code
    assert.match((await s.call("tcm_view", { names: ["lib.square"] })).text, /^\*\*lib\.square\*\* `#\w+` · runs anywhere\n\n```ts\nexport const square = \(x: number\): number => x \*\* 2;?\n```$/);
    // a client that asks for progress hears a long command's output as it comes
    assert.match((await s.call("tcm_test", { namespace: "lib", fresh: true }, { progressToken: "t1" })).text, /1 passed, 0 failed/);
    const progress = s.notes.filter((n) => n.method === "notifications/progress" && n.params.progressToken === "t1");
    assert.ok(progress.some((n) => /lib\.testArea/.test(String(n.params.message))), JSON.stringify(progress));

    assert.match((await s.call("tcm_guide", { topic: "editing" })).text, /# Editing/);
    const bad = await s.call("tcm_view", { names: ["lib.nothing"] });
    assert.equal(bad.isError, true);
    s.close();
  });

/**
 * Agents in sessions (`tcm mcp --branch`) work in one codebase at once, each on its own branch with its own scratch
 * files, out of the mirror's files and each other's way, until tcm_merge lands their work on main: main merged in,
 * the tests it reaches passing, then onto main, which the files follow.
 */
export const testSessionsWorkApart = () =>
  withChildren(async (keep) => {
    const root = tempDir("sessions");
    const proj = path.join(root, "proj");
    const dir = path.join(root, "cb");
    for (const d of ["src", "test"]) fs.mkdirSync(path.join(proj, d), { recursive: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(proj, "src", "math.ts"), "export const square = (x: number): number => x * x;\n");
    fs.writeFileSync(path.join(proj, "test", "math.ts"), `import assert from "node:assert/strict";\nimport { square } from "../src/math.ts";\n\nexport const testSquare = () => assert.equal(square(3), 9);\n`);
    const tcm = (...args: string[]) => okIn(dir, ...args);
    const source = () => fs.readFileSync(path.join(proj, "src", "math.ts"), "utf8");
    tcm("init");
    fs.rmSync(path.join(dir, "scratch.ts"));
    tcm("import", proj, "--into", "lib", "--tests", "--mirror");

    const a = session(dir, keep, "--branch", "agent/a");
    const b = session(dir, keep, "--branch", "agent/b");
    const init = await a.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.match(String(init.result!.instructions), /a session on its own branch, agent\/a[\s\S]*tcm_merge/);

    // a changes square, in its own scratch file, on its own branch
    const edited = await a.call("tcm_edit", { names: ["lib.math.square"] });
    assert.match(edited.text, /sessions\/agent_a\/scratch\.ts/);
    const file = path.join(dir, ".tcm", "sessions", "agent_a", "scratch.ts");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("x * x", "x ** 2"));
    assert.match((await a.call("tcm_update")).text, /~ update +lib\.math\.square/);
    // b, main and the files don't see it
    assert.match((await b.call("tcm_view", { names: ["lib.math.square"] })).text, /x \* x/);
    assert.match(tcm("view", "lib.math.square"), /x \* x/);
    assert.match(source(), /x \* x/);
    // and a session stays on its branch
    assert.match((await a.call("tcm_cli", { args: ["switch", "main"] })).text, /session on agent\/a/);

    // b's scratch files are its own too; it adds a test that fails
    assert.match((await b.call("tcm_edit", { names: ["lib.math.square"] })).text, /sessions\/agent_b\/scratch\.ts/);
    fs.writeFileSync(path.join(dir, ".tcm", "sessions", "agent_b", "scratch.ts"), `// tcm: namespace lib.math\nexport const testCube = () => {\n  throw new Error("not yet");\n};\n`);
    assert.match((await b.call("tcm_update")).text, /\+ new +lib\.math\.testCube/);

    // a lands: its change is on main, and in the files
    const landed = await a.call("tcm_merge");
    assert.equal(landed.isError, false, landed.text);
    assert.match(landed.text, /agent\/a is on main/);
    assert.match(tcm("view", "lib.math.square"), /x \*\* 2/);
    assert.match(source(), /x \*\* 2/);

    // b brings main in, but its test fails: nothing lands
    const refused = await b.call("tcm_merge");
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /testCube[\s\S]*nothing landed on main/);
    assert.doesNotMatch(tcm("ls", "lib.math"), /testCube/);

    // with --session, each server is a session on a new branch of its own
    const c = session(dir, keep, "--session");
    const cInit = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.match(String(cInit.result!.instructions), /own branch, session\/\d{4}-\d{2}-\d{2}-[0-9a-f]{6}:/);
    a.close();
    b.close();
    c.close();
  });
