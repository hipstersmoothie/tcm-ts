import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `tcm mcp`: the codebase's tools for AI agents, over the Model Context Protocol, used as an agent would.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm mcp ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

function session() {
  const child = spawn(process.execPath, [BIN, "mcp"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let id = 0;
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, nl)) as { id: number; result?: Record<string, unknown>; error?: { message: string } };
      buf = buf.slice(nl + 1);
      waiting.get(m.id)?.(m);
    }
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
      const i = ++id;
      waiting.set(i, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await request("tools/call", { name, arguments: args });
    const result = r.result as { content: { text: string }[]; isError: boolean };
    return { text: result.content[0]!.text, isError: result.isError };
  };
  return { request, call, close: () => child.stdin.end() };
}

test("an agent works in the codebase through tcm mcp: find, edit, check, update, test", async () => {
  assert.equal(spawnSync(process.execPath, [BIN, "init"], { cwd: dir, env }).status, 0);
  // init tells agents how to work here
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.tcm, { command: "tcm", args: ["mcp"] });
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /tcm codebase[\s\S]*tcm_edit/);
  fs.writeFileSync(
    path.join(dir, "scratch.ts"),
    `// tcm: namespace lib\nimport assert from "node:assert/strict";\nexport const square = (x: number): number => x * x;\nexport const area = (s: number): number => square(s);\nexport const testArea = () => assert.equal(area(3), 9);\n`,
  );
  assert.equal(spawnSync(process.execPath, [BIN, "add"], { cwd: dir, env }).status, 0);

  const s = session();
  const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.match(String(init.result!.instructions), /tcm_edit the definitions you'll change/);
  const tools = ((await s.request("tools/list")).result!.tools as { name: string }[]).map((t) => t.name);
  for (const t of ["tcm_status", "tcm_find", "tcm_view", "tcm_edit", "tcm_check", "tcm_update", "tcm_todo", "tcm_test", "tcm_mv", "tcm_cli", "tcm_guide"]) assert.ok(tools.includes(t), t);

  assert.match((await s.call("tcm_status")).text, /3 named definitions[\s\S]*lib {2}3[\s\S]*nothing to do/);
  assert.match((await s.call("tcm_find", { query: ":(x: number) => number" })).text, /lib\.square/);

  // edit: scratch.ts holds work already, so the definition goes to another scratch file
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nexport const draft = 1;\n`);
  const edited = await s.call("tcm_edit", { names: ["lib.square"] });
  assert.match(edited.text, /wrote lib\.square to scratch-2\.ts[\s\S]*export const square[\s\S]*tcm_check and tcm_update/);
  const file = path.join(dir, "scratch-2.ts");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("x * x", "x ** 2"));
  assert.match((await s.call("tcm_check", { file: "scratch-2.ts" })).text, /~ update +lib\.square[\s\S]*tcm_update saves it/);
  const updated = await s.call("tcm_update", { file: "scratch-2.ts" });
  assert.match(updated.text, /~ updated +lib\.area \(dependent\)[\s\S]*tcm_test runs the tests/);
  assert.match((await s.call("tcm_view", { names: ["lib.square"] })).text, /x \*\* 2/);
  assert.match((await s.call("tcm_test", { namespace: "lib" })).text, /1 passed, 0 failed/);

  assert.match((await s.call("tcm_guide", { topic: "editing" })).text, /# Editing/);
  const bad = await s.call("tcm_view", { names: ["lib.nothing"] });
  assert.equal(bad.isError, true);
  s.close();
});
