import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const BIN = process.env.UCM_BIN ? path.resolve(process.env.UCM_BIN) : fileURLToPath(new URL("../bin/ucm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ucm lsp ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

/** A minimal LSP client: framed JSON-RPC over the server's stdio. */
function client() {
  const child = spawn(process.execPath, [BIN, "lsp"], { cwd: os.tmpdir(), env });
  children.push(child);
  const notes: Msg[] = [];
  const pending = new Map<number, (m: Msg) => void>();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString())![1]);
      if (buf.length < sep + 4 + len) return;
      const m = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString()) as Msg;
      buf = buf.subarray(sep + 4 + len);
      if (m.id !== undefined && !m.method) pending.get(m.id as number)?.(m);
      else if (m.method && m.id !== undefined) write({ id: m.id, result: null }); // e.g. workspace/codeLens/refresh
      else notes.push(m);
    }
  });
  const write = (m: Msg) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      write({ id: n, method, params });
    });
  const notify = (method: string, params: unknown) => write({ method, params });
  const waitFor = async <T>(find: () => T | undefined, ms = 20000): Promise<T> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const v = find();
      if (v) return v;
    }
    throw new Error(`timed out; stderr:\n${stderr}\nnotifications:\n${JSON.stringify(notes, null, 1)}`);
  };
  return { request, notify, notes, waitFor, child };
}

const at = (text: string, needle: string, delta = 0) => {
  const offset = text.indexOf(needle) + delta;
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};
const titles = (lenses: { command: { title: string } }[]) => lenses.map((l) => l.command.title);

test("the language server: status lenses, save commands, watch values, hovers, ucm diagnostics", async () => {
  spawnSync(process.execPath, [BIN, "init"], { cwd: dir, env });
  const file = path.join(dir, "scratch.ts");
  const uri = pathToFileURL(file).href;
  const text = `// ucm: namespace lib
/** Square a number. */
export const square = (x: number): number => x * x;
export const testSquare = () => {
  if (square(3) !== 9) throw new Error("bad");
};

square(12);
`;
  fs.writeFileSync(file, text);

  const c = client();
  const init = await c.request("initialize", { processId: null, rootUri: pathToFileURL(dir).href, capabilities: {}, clientInfo: { name: "test" } });
  assert.ok(init.capabilities.codeLensProvider && init.capabilities.inlayHintProvider && init.capabilities.hoverProvider);
  assert.deepEqual(init.capabilities.executeCommandProvider.commands, ["ucm.add", "ucm.update", "ucm.mv"]);
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
  const doc = { textDocument: { uri } };

  // what each definition would be, with the action that saves it; watch values and test results inline
  let lenses = await c.request("textDocument/codeLens", doc);
  assert.deepEqual(titles(lenses).slice(0, 2), ["+ new lib.square", "Add to codebase"]);
  assert.equal(lenses[0].range.start.line, 2);
  const hints = await c.waitFor(async () => {
    const h = await c.request("textDocument/inlayHint", { ...doc, range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } } });
    return h.length ? h : undefined;
  });
  assert.equal(hints[0].label, "⧩ 144");
  assert.equal(hints[0].position.line, 7);
  lenses = await c.request("textDocument/codeLens", doc);
  assert.ok(titles(lenses).includes("✓ passed"), titles(lenses).join(" | "));

  // the Add action saves to the codebase; the lenses then show the hash
  const added = await c.request("workspace/executeCommand", { command: "ucm.add", arguments: [uri] });
  assert.equal(added, true);
  await c.waitFor(() => c.notes.find((n) => n.method === "window/showMessage" && /\+ new\s+lib\.square/.test(n.params.message)));
  lenses = await c.request("textDocument/codeLens", doc);
  assert.match(titles(lenses)[0]!, /^lib\.square #[a-z2-7]{8}$/);

  // an unsaved edit: the lens says what saving would do, and saving refuses until the file is saved
  const edited = text.replace("x * x", "x ** 2");
  c.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: edited }] });
  lenses = await c.request("textDocument/codeLens", doc);
  assert.match(titles(lenses)[0]!, /^~ update lib\.square \(was #[a-z2-7]{8}\)$/);
  assert.equal(titles(lenses)[1], "Update codebase");
  assert.equal(await c.request("workspace/executeCommand", { command: "ucm.update", arguments: [uri] }), null);
  await c.waitFor(() => c.notes.find((n) => n.method === "window/showMessage" && /Save scratch\.ts first/.test(n.params.message)));

  // hovers: a definition in the file, and a codebase name imported elsewhere
  c.notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text }] });
  const own = await c.request("textDocument/hover", { ...doc, position: at(text, "square =", 2) });
  assert.match(own.contents.value, /\*\*lib\.square\*\* `#[a-z2-7]{8}`/);
  assert.match(own.contents.value, /Runs anywhere\./);
  assert.match(own.contents.value, /Square a number\./);
  const appFile = path.join(dir, "app.ts");
  const appUri = pathToFileURL(appFile).href;
  const app = `import { square } from "#codebase/lib";\n\nexport const area = (r: number) => 3 * square(r);\n`;
  fs.writeFileSync(appFile, app);
  c.notify("textDocument/didOpen", { textDocument: { uri: appUri, languageId: "typescript", version: 1, text: app } });
  const imported = await c.request("textDocument/hover", { textDocument: { uri: appUri }, position: at(app, "square(r)", 1) });
  assert.match(imported.contents.value, /\*\*lib\.square\*\*/);
  assert.match(imported.contents.value, /1 named dependent\n/, "testSquare uses it");

  // ucm's own errors are diagnostics; type errors are TypeScript's to report, and stop hashing
  const withLet = text + "let counter = 0;\n";
  c.notify("textDocument/didChange", { textDocument: { uri, version: 4 }, contentChanges: [{ text: withLet }] });
  const diag = await c.waitFor(() => c.notes.findLast((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === uri && n.params.version === 4));
  assert.equal(diag.params.diagnostics[0].source, "ucm");
  assert.match(diag.params.diagnostics[0].message, /top-level `let`/);
  assert.equal(diag.params.diagnostics[0].range.start.line, 8);
  const typeError = text.replace("square(12)", 'square("12")');
  c.notify("textDocument/didChange", { textDocument: { uri, version: 5 }, contentChanges: [{ text: typeError }] });
  lenses = await c.request("textDocument/codeLens", doc);
  assert.deepEqual(titles(lenses), ["ucm: 1 type error; nothing hashed until they're fixed"]);

  await c.request("shutdown", null);
  c.notify("exit", null);
  await new Promise((r) => c.child.on("exit", r));
});
