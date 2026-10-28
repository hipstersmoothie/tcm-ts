import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm lsp ")));
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

test("the language server: status lenses, save commands, watch values, hovers, tcm diagnostics", async () => {
  spawnSync(process.execPath, [BIN, "init"], { cwd: dir, env });
  const file = path.join(dir, "scratch.ts");
  const uri = pathToFileURL(file).href;
  const text = `// tcm: namespace lib
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
  assert.deepEqual(init.capabilities.executeCommandProvider.commands, ["tcm.add", "tcm.update", "tcm.mv", "tcm.edit", "tcm.dataMigrate", "tcm.upgrade"]);
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
  const added = await c.request("workspace/executeCommand", { command: "tcm.add", arguments: [uri] });
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
  assert.equal(await c.request("workspace/executeCommand", { command: "tcm.update", arguments: [uri] }), null);
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

  // tcm's own errors are diagnostics; type errors are TypeScript's to report, and stop hashing
  const withLet = text + "let counter = 0;\n";
  c.notify("textDocument/didChange", { textDocument: { uri, version: 4 }, contentChanges: [{ text: withLet }] });
  const diag = await c.waitFor(() => c.notes.findLast((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === uri && n.params.version === 4));
  assert.equal(diag.params.diagnostics[0].source, "tcm");
  assert.match(diag.params.diagnostics[0].message, /top-level `let`/);
  assert.equal(diag.params.diagnostics[0].range.start.line, 8);
  const typeError = text.replace("square(12)", 'square("12")');
  c.notify("textDocument/didChange", { textDocument: { uri, version: 5 }, contentChanges: [{ text: typeError }] });
  lenses = await c.request("textDocument/codeLens", doc);
  assert.deepEqual(titles(lenses), ["tcm: 1 type error; nothing hashed until they're fixed"]);

  await c.request("shutdown", null);
  c.notify("exit", null);
  await new Promise((r) => c.child.on("exit", r));
});

test("the codebase in the editor: tree, rendered views, definition, references, symbols, type search, edit", async () => {
  const dir2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm lsp2 ")));
  const tcm = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir2, env, encoding: "utf8" });
  tcm("init");
  fs.writeFileSync(
    path.join(dir2, "scratch.ts"),
    `// tcm: namespace geo
export type Point = { x: number; y: number };
/** Distance between two points. */
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const perimeter = (ps: Point[]): number => ps.reduce((n, p, i) => n + dist(p, ps[(i + 1) % ps.length]!), 0);
`,
  );
  tcm("add");
  fs.writeFileSync(path.join(dir2, "scratch.ts"), `// tcm: namespace app\nimport { dist } from "#codebase/geo";\n\nexport const far = (n: number) => dist({ x: 0, y: 0 }, { x: n, y: n }) > 10;\n`);
  tcm("add");
  const scratchText = `import { perimeter } from "#codebase/geo";\n\nperimeter([]);\n`;
  fs.writeFileSync(path.join(dir2, "scratch.ts"), scratchText);

  const c = client();
  await c.request("initialize", { processId: null, rootUri: pathToFileURL(dir2).href, capabilities: {}, clientInfo: { name: "Visual Studio Code" } });
  c.notify("initialized", {});

  // the namespace tree
  const root = await c.request("tcm/tree", { namespace: "" });
  assert.deepEqual(root.namespaces.map((n: any) => [n.name, n.count]), [["app", 1], ["geo", 3]]);
  const geo = await c.request("tcm/tree", { namespace: "geo" });
  assert.deepEqual(geo.definitions.map((d: any) => [d.name, d.kind]), [["Point", "type"], ["dist", "term"], ["perimeter", "term"]]);
  assert.equal(geo.definitions[1].doc, "Distance between two points.");
  assert.equal(geo.definitions[1].uri, "tcm:/geo/dist.ts");

  // a definition's view: rendered with current names, references link to their definitions
  const perim = await c.request("tcm/source", { uri: "tcm:/geo/perimeter.ts" });
  assert.match(perim.text, /^\/\/ geo\.perimeter #[a-z2-7]{8}\n/);
  assert.match(perim.text, /import \{ dist \} from "#codebase\/geo";/);
  const def = await c.request("textDocument/definition", { textDocument: { uri: "tcm:/geo/perimeter.ts" }, position: at(perim.text, "dist(p", 1) });
  assert.equal(def.uri, "tcm:/geo/dist.ts");
  const distText = (await c.request("tcm/source", { uri: "tcm:/geo/dist.ts" })).text;
  assert.equal(distText.split("\n")[def.range.start.line]!.slice(def.range.start.character, def.range.end.character), "dist");

  // references: from a view, and from a codebase name in a scratch file, across the codebase
  const fromView = await c.request("textDocument/references", { textDocument: { uri: "tcm:/geo/dist.ts" }, position: def.range.start, context: { includeDeclaration: false } });
  assert.deepEqual(fromView.map((l: any) => l.uri).sort(), ["tcm:/app/far.ts", "tcm:/geo/perimeter.ts"]);
  const uri = pathToFileURL(path.join(dir2, "scratch.ts")).href;
  c.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: scratchText } });
  // Cmd+click on a codebase name in a scratch file goes to its source; local names are TypeScript's
  const toSource = await c.request("textDocument/definition", { textDocument: { uri }, position: at(scratchText, "perimeter([", 2) });
  assert.equal(toSource.uri, "tcm:/geo/perimeter.ts");
  assert.equal(await c.request("textDocument/definition", { textDocument: { uri }, position: { line: 2, character: 12 } }), null, "not a name");
  const fromScratch = await c.request("textDocument/references", { textDocument: { uri }, position: at(scratchText, "perimeter([", 2), context: { includeDeclaration: true } });
  assert.deepEqual(fromScratch.map((l: any) => l.uri), ["tcm:/geo/perimeter.ts"], "the declaration; nothing uses it yet");

  // lenses on a view: who uses it, edit, rename
  const lenses = await c.request("textDocument/codeLens", { textDocument: { uri: "tcm:/geo/dist.ts" } });
  assert.deepEqual(titles(lenses), ["2 dependents", "Edit", "Rename"]);

  // outline, workspace symbols, hover in a view
  const symbols = await c.request("textDocument/documentSymbol", { textDocument: { uri: "tcm:/geo/dist.ts" } });
  assert.equal(symbols[0].name, "dist");
  const found = await c.request("workspace/symbol", { query: "per" });
  assert.deepEqual(found.map((s: any) => [s.name, s.containerName]), [["perimeter", "geo"]]);
  const hover = await c.request("textDocument/hover", { textDocument: { uri: "tcm:/geo/perimeter.ts" }, position: at(perim.text, "dist(p", 1) });
  assert.match(hover.contents.value, /Distance between two points\./);

  // search by type, for a picker
  const byType = await c.request("tcm/findByType", { query: "(a: Point, b: Point) => number" });
  assert.deepEqual(byType.hits.map((h: any) => [h.path, h.uri]), [["geo.dist", "tcm:/geo/dist.ts"]]);

  // edit: into a free scratch file, which the client then opens
  const edited = await c.request("workspace/executeCommand", { command: "tcm.edit", arguments: ["geo.dist"] });
  assert.equal(edited, pathToFileURL(path.join(dir2, "edit.ts")).href, "scratch.ts is taken");
  assert.match(fs.readFileSync(path.join(dir2, "edit.ts"), "utf8"), /const dist = \(a: Point, b: Point\)/);

  // a change made elsewhere (a terminal) reaches the client
  c.notes.length = 0;
  tcm("mv", "geo.dist", "geo.distance");
  await c.waitFor(() => c.notes.find((n) => n.method === "tcm/changed"));
  const moved = await c.request("tcm/tree", { namespace: "geo" });
  assert.ok(moved.definitions.some((d: any) => d.name === "distance"));
});

test("apps and data in the editor: roles, an app's parts, tables, rows, migrating", async () => {
  const dir3 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm lsp3 ")));
  const tcm = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir3, env, encoding: "utf8" });
  tcm("init");
  fs.writeFileSync(
    path.join(dir3, "scratch.ts"),
    `// tcm: namespace shop
import { table, every } from "#tcm/server";
export type Item = { name: string; price: number };
export const items = table<Item>("items", { migrate: (old: { name: string }) => ({ name: old.name, price: 0 }) });
export async function listItems(): Promise<string[]> {
  return (await items.find()).map((r) => r.value.name);
}
export async function cleanup(): Promise<void> {}
export const nightly = every("0 3 * * *", cleanup);
export const format = (names: string[]) => names.join(", ");
export async function main() {
  document.body.textContent = format(await listItems());
}
export const testFormat = () => {
  if (format(["a", "b"]) !== "a, b") throw new Error("bad");
};
`,
  );
  assert.equal(tcm("add").status, 0, tcm("add").stdout);
  fs.writeFileSync(path.join(dir3, "scratch.ts"), "");
  // rows an app wrote: one of the current type, one of an older one
  const schema = JSON.parse(spawnSync("sqlite3", [path.join(dir3, ".tcm", "codebase.sqlite"), "select value from metadata where key = 'table'"], { encoding: "utf8" }).stdout).hash;
  fs.mkdirSync(path.join(dir3, ".tcm", "data"), { recursive: true });
  const store = new DatabaseSync(path.join(dir3, ".tcm", "data", "store.sqlite"));
  store.exec(`CREATE TABLE rows (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, schema_hash TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id));
    CREATE TABLE schemas (tbl TEXT NOT NULL, hash TEXT NOT NULL, schema TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY (tbl, hash));`);
  store.prepare("INSERT INTO rows VALUES ('items', 'a1', ?, ?, 2)").run(JSON.stringify({ name: "apple", price: 3 }), schema);
  store.prepare("INSERT INTO rows VALUES ('items', 'p1', ?, 'v0', 1)").run(JSON.stringify({ name: "pear" }));
  store.close();

  const c = client();
  await c.request("initialize", { processId: null, rootUri: pathToFileURL(dir3).href, capabilities: {}, clientInfo: { name: "Visual Studio Code" } });
  c.notify("initialized", {});

  // each definition says what it's for
  const shop = await c.request("tcm/tree", { namespace: "shop" });
  const roles = Object.fromEntries(shop.definitions.map((d: any) => [d.name, d.role]));
  assert.deepEqual(roles, { Item: "type", cleanup: "shared", format: "shared", items: "table", listItems: "server", main: "app", nightly: "schedule", testFormat: "test" });
  assert.equal(shop.definitions.find((d: any) => d.name === "listItems").endpoint, true);
  assert.equal(shop.definitions.find((d: any) => d.name === "testFormat").place, undefined, "a test's placement is noise");

  // the app, and what it's made of
  const [app] = await c.request("tcm/apps", {});
  assert.equal(app.path, "shop.main");
  assert.deepEqual(app.endpoints.map((e: any) => e.path), ["shop.listItems"]);
  assert.deepEqual(app.browser.map((e: any) => e.path), ["shop.format", "shop.main"]);
  assert.deepEqual(app.tables.map((t: any) => [t.table, t.rows]), [["items", 2]]);
  assert.deepEqual(app.schedules.map((s: any) => [s.path, s.spec]), [["shop.nightly", "0 3 * * *"]]);
  assert.deepEqual(app.tests.map((t: any) => t.path), ["shop.testFormat"]);

  // the data: tables, a page of rows, a row in full
  const [items] = await c.request("tcm/data", {});
  assert.deepEqual([items.table, items.rows, items.older, items.path], ["items", 2, 1, "shop.items"]);
  // a page for the table viewer: typed columns, cells, older rows marked; sorted and searched in SQL
  const page = await c.request("tcm/rows", { table: "items", offset: 0, limit: 10 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.fields, [{ name: "name", type: "string" }, { name: "price", type: "number" }]);
  assert.deepEqual(page.rows.map((r: any) => [r.id, r.cells.name, r.cells.price, r.older]), [["a1", "apple", "3", false], ["p1", "pear", "", true]]);
  const byName = await c.request("tcm/rows", { table: "items", offset: 0, limit: 10, sort: { field: "name", desc: true } });
  assert.deepEqual(byName.rows.map((r: any) => r.id), ["p1", "a1"]);
  const found = await c.request("tcm/rows", { table: "items", offset: 0, limit: 10, search: "APP" });
  assert.deepEqual([found.total, found.rows.map((r: any) => r.id)], [1, ["a1"]]);
  const rows = page.rows;
  const row = await c.request("tcm/source", { uri: rows[0].uri });
  assert.match(row.text, /^\/\/ table "items", row a1: written .* as row type #/);
  assert.match((await c.request("tcm/source", { uri: "tcm:/.data/items.txt" })).text, /\/\/ table "items": 2 rows\n\na1  \{ name: 'apple', price: 3 \}\np1/);

  // migrate the older row from the editor; the client hears the data changed
  c.notes.length = 0;
  assert.equal(await c.request("workspace/executeCommand", { command: "tcm.dataMigrate", arguments: ["items"] }), true);
  await c.waitFor(() => c.notes.find((n) => n.method === "tcm/dataChanged"));
  const after = await c.request("tcm/data", {});
  assert.equal(after[0].older, 0);
  assert.equal((await c.request("tcm/rows", { table: "items", offset: 0, limit: 10 })).rows.find((r: any) => r.id === "p1").summary, "{ name: 'pear', price: 0 }");
});

test("pages: a definition's rendered doc and linked source, a namespace's README, and the finder", async () => {
  const dir4 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm lsp4 ")));
  const tcm = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir4, env, encoding: "utf8" });
  tcm("init");
  fs.writeFileSync(
    path.join(dir4, "scratch.ts"),
    `// tcm: namespace geo
/** A point on the plane. */
export type Point = { x: number; y: number };
/**
 * Distance between two {@link Point}s.
 *
 * \`\`\`ts
 * dist({ x: 0, y: 0 }, { x: 3, y: 4 })
 * \`\`\`
 */
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
/** Around the outside: the sum of each side's {@link dist}. */
export const perimeter = (ps: Point[]): number => ps.reduce((n, p, i) => n + dist(p, ps[(i + 1) % ps.length]!), 0);
/**
 * # Geometry
 *
 * Points and distances. Start with {@link dist}.
 */
export type README = never;
`,
  );
  assert.equal(tcm("add").status, 0);
  const dist = spawnSync("sqlite3", [path.join(dir4, ".tcm", "codebase.sqlite"), "select hash from names where path = 'geo.dist'"], { encoding: "utf8" }).stdout.trim();
  const pointHash = spawnSync("sqlite3", [path.join(dir4, ".tcm", "codebase.sqlite"), "select hash from names where path = 'geo.Point'"], { encoding: "utf8" }).stdout.trim();

  const c = client();
  await c.request("initialize", { processId: null, rootUri: pathToFileURL(dir4).href, capabilities: {}, clientInfo: { name: "Visual Studio Code" } });
  c.notify("initialized", {});

  // a definition's page: rendered doc (links by hash, the example evaluated), source with references as links
  const page = await c.request("tcm/page", { path: "geo.dist" });
  assert.equal(page.hash, dist);
  assert.deepEqual(page.names, ["geo.dist"]);
  assert.match(page.docMarkdown, new RegExp(`Distance between two \\[\`Point\`\\]\\(tcm-page:${pointHash}\\)s\\.`));
  assert.match(page.docMarkdown, /```text\n⧩ 5\n```/);
  assert.match(page.sourceHtml, new RegExp(`<a class="ref t" data-hash="${pointHash}">Point</a>`));
  assert.match(page.sourceHtml, /<span class="k">const<\/span>/);
  assert.deepEqual(page.uses.map((u: any) => u.name), ["geo.Point"]);
  assert.deepEqual(page.usedBy.map((u: any) => u.name), ["geo.perimeter"]);

  // a namespace's page: its README rendered, then what's in it by role
  const ns = await c.request("tcm/namespace", { namespace: "geo" });
  assert.match(ns.readme, /^# Geometry\n\nPoints and distances\. Start with \[`dist`\]\(tcm-page:/);
  assert.deepEqual(ns.definitions.map((d: any) => [d.name, d.role]), [["Point", "type"], ["dist", "shared"], ["perimeter", "shared"]]);
  assert.equal(ns.definitions[0].summary, "A point on the plane.");

  // the finder: names (best first), words in docs, and types
  const byName = await c.request("tcm/find", { query: "dist" });
  assert.equal(byName[0].path, "geo.dist");
  const byDoc = await c.request("tcm/find", { query: "outside" });
  assert.deepEqual(byDoc.map((i: any) => [i.path, i.match]), [["geo.perimeter", "doc"]]);
  const byType = await c.request("tcm/find", { query: "(a: Point, b: Point) => number" });
  assert.deepEqual(byType.map((i: any) => [i.path, i.match]), [["geo.dist", "type"]]);
});

test("packages in the editor: the lock, what uses each package, a page with its README and API, upgrading", async () => {
  const dir5 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm lsp packages ")));
  const tcm = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir5, env, encoding: "utf8" });
  tcm("init");
  // nothing installed: tcm provides ms
  fs.writeFileSync(path.join(dir5, "scratch.ts"), `// tcm: namespace time\nimport ms from "ms";\nexport const short = (n: number): string => ms(n);\n`);
  assert.equal(tcm("add").status, 0);
  spawnSync("sqlite3", [path.join(dir5, ".tcm", "codebase.sqlite"), "update packages set version = '2.1.1', integrity = null where name = 'ms'"]);

  const c = client();
  await c.request("initialize", { processId: null, rootUri: pathToFileURL(dir5).href, capabilities: {}, clientInfo: { name: "Visual Studio Code" } });
  c.notify("initialized", {});
  const list = await c.request("tcm/packages", {});
  const ms = list.find((p: { name: string }) => p.name === "ms");
  assert.deepEqual(ms.ranges.map((r: { range: string; version: string; users: number; types?: string }) => [r.range, r.version, r.users, !!r.types]), [["2", "2.1.1", 1, true]]);
  assert.deepEqual((await c.request("tcm/packageUsers", { name: "ms", range: "2" })).map((u: { path: string }) => u.path), ["time.short"]);

  const page = await c.request("tcm/packagePage", { name: "ms", range: "2" });
  assert.equal(page.version, "2.1.1");
  assert.match(page.readme, /^# ms/m, "the package's README");
  assert.ok(page.api.some((a: { name: string; kind: string }) => a.name === "default" && a.kind === "function"), "its API, from its types");
  assert.match(page.users[0].uri, /^tcm:\/time\/short\.ts$/);

  const upgraded = await c.request("workspace/executeCommand", { command: "tcm.upgrade", arguments: ["ms"] });
  assert.equal(upgraded, true);
  assert.notEqual((await c.request("tcm/packages", {})).find((p: { name: string }) => p.name === "ms").ranges[0].version, "2.1.1");
  c.child.kill();
});
