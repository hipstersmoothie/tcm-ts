// `ucm lsp`: a Language Server for editors, alongside TypeScript's own. TypeScript keeps doing completions, type
// errors and go-to-definition; this adds what only ucm knows. For each definition in a scratch file: what it is
// to the codebase (new, an update, identical, an alias, a conflict), its hash and placement, with commands that
// save it. Watch values and test results inline, hovers on codebase names, and ucm's own errors.
//
// It speaks JSON-RPC over stdin/stdout, so nothing else may write to stdout: console output goes to stderr, and
// test and watch runners are told to do the same.
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { cacheRefOf, shortHash, type Analysis, type DefRecord, type ProjectDef } from "@ucm/core";
import { render, type Rendered } from "@ucm/loader";
import type { Codebase } from "./codebase.ts";
import { Placement } from "./placement.ts";
import { evaluateCached, isTestPath, runCached } from "./tests.ts";
import { searchByType } from "./search.ts";

/** What the language server needs from the CLI (passed in, so this module doesn't import the CLI's entry). */
export interface LspTools {
  classify(cb: Codebase, defs: DefRecord[], ns: string): { def: DefRecord; path: string; status: string; note?: string }[];
  save(cb: Codebase, file: string, mode: "add" | "update"): boolean;
  mv(cb: Codebase, from: string, to: string): void;
  edit(cb: Codebase, targets: string[], file: string, force: boolean): void;
}

type Json = Record<string, unknown>;
interface Message {
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: unknown;
}
interface Position {
  line: number;
  character: number;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");

/** Content-Length framed JSON-RPC over a pair of streams. */
function connect(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, onMessage: (m: Message) => void) {
  let buf = Buffer.alloc(0);
  input.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString("ascii"))?.[1]);
      if (buf.length < sep + 4 + len) return;
      const body = buf.subarray(sep + 4, sep + 4 + len).toString("utf8");
      buf = buf.subarray(sep + 4 + len);
      onMessage(JSON.parse(body) as Message);
    }
  });
  return (m: Json) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m }), "utf8");
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };
}

/** Offsets ↔ LSP positions (both count UTF-16 code units, as JS strings do). */
function lines(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const pos = (offset: number): Position => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - starts[lo]! };
  };
  const offset = (p: Position) => (starts[p.line] ?? text.length) + p.character;
  const lineEnd = (line: number) => (starts[line + 1] ?? text.length + 1) - 1;
  return { pos, offset, lineEnd };
}

interface Row {
  def: ProjectDef;
  path: string;
  status: string;
  note?: string;
}
interface DocState {
  uri: string;
  file: string;
  text: string;
  version: number;
  /** the analysis of `text`, or why there isn't one */
  analyzed?: {
    text: string;
    analysis?: Analysis;
    rows: Row[];
    problems: { message: string; severity: 1 | 2 }[];
    typeErrors: number;
    watches: Map<number, { ok: boolean; value: string; cached: boolean }>;
    tests: Map<string, { ok: boolean; message: string; cached: boolean }>;
  };
}

export function serveLsp(findCodebase: (dir: string) => Codebase, tools: LspTools): void {
  // stdout is the protocol channel: anything else printed goes to stderr
  console.log = (...args: unknown[]) => process.stderr.write(format(...args) + "\n");
  let cb: Codebase | undefined;
  let isVsCode = false;
  let canRefresh = { lens: false, hints: false };
  const docs = new Map<string, DocState>();
  let nextId = 1;
  const send = connect(process.stdin, process.stdout, (m) => {
    try {
      handle(m);
    } catch (e) {
      if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32603, message: (e as Error)?.message ?? String(e) } });
      else process.stderr.write(`ucm lsp: ${(e as Error)?.stack ?? e}\n`);
    }
  });
  const notify = (method: string, params: unknown) => send({ method, params });
  const request = (method: string, params?: unknown) => send({ id: `ucm-${nextId++}`, method, params });
  const message = (type: 1 | 2 | 3, text: string) => notify("window/showMessage", { type, message: text });

  /** Only top-level `.ts` files of the codebase are scratch files, as for the watcher. */
  const isScratch = (file: string) => !!cb && path.dirname(file) === cb.lay.root && file.endsWith(".ts") && !file.endsWith(".d.ts");

  const analyze = (doc: DocState, run: boolean) => {
    const c = cb!;
    const problems: { message: string; severity: 1 | 2 }[] = [];
    const state: NonNullable<DocState["analyzed"]> = { text: doc.text, rows: [], problems, typeErrors: 0, watches: new Map(), tests: new Map() };
    doc.analyzed = state;
    let a: Analysis;
    try {
      c.refreshShim();
      a = c.analyze(doc.file, c.scratchSalts(), [], new Map([[doc.file, doc.text]]));
    } catch (e) {
      problems.push({ message: (e as Error).message, severity: 1 });
      return;
    }
    state.analysis = a;
    for (const w of a.warnings) problems.push({ message: w, severity: 2 });
    for (const e of a.errors) problems.push({ message: e, severity: 1 });
    state.typeErrors = a.diagnostics.length;
    if (a.diagnostics.length || a.errors.length) return;
    try {
      state.rows = tools.classify(c, a.defs, a.namespace ?? "") as Row[];
    } catch (e) {
      problems.push({ message: (e as Error).message, severity: 1 });
      return;
    }
    // while typing, show what's cached; run what isn't on open and save
    const node = process.version;
    const src = c.source([...a.defs, ...a.watches]);
    if (run) state.watches = evaluateCached(c, a.watches, src, false);
    else for (const w of a.watches) {
      const r = c.store.watchResult(w.hash, node);
      if (r) state.watches.set(w.line, { ...r, cached: true });
    }
    const tests = state.rows.filter((r) => r.def.kind !== "type" && isTestPath(r.path));
    if (run && tests.length) {
      for (const o of runCached(c, tests.map((r) => ({ path: r.path, rec: r.def })), src, false)) state.tests.set(o.path, { ...o.result, cached: o.cached });
    } else for (const t of tests) {
      const r = c.store.testResult(t.def.hash, node);
      if (r) state.tests.set(t.path, { ...r, cached: true });
    }
  };

  const fresh = (doc: DocState) => {
    if (doc.analyzed?.text !== doc.text) analyze(doc, false);
    return doc.analyzed!;
  };

  const publish = (doc: DocState) => {
    const s = fresh(doc);
    const { pos, lineEnd } = lines(doc.text);
    const diagnostics = s.problems.map((p) => {
      // ucm's errors start with `file:line:col: `
      const m = /^(.*?):(\d+):(\d+): ([\s\S]*)$/.exec(p.message);
      const here = m && path.resolve(m[1]!) === doc.file;
      const line = here ? Number(m[2]) - 1 : 0;
      const start = { line, character: here ? Number(m[3]) - 1 : 0 };
      return { range: { start, end: pos(lineEnd(line)) }, severity: p.severity, source: "ucm", message: here ? m[4]! : p.message };
    });
    notify("textDocument/publishDiagnostics", { uri: doc.uri, version: doc.version, diagnostics });
    if (canRefresh.lens) request("workspace/codeLens/refresh");
    if (canRefresh.hints) request("workspace/inlayHint/refresh");
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (doc: DocState, run: boolean) => {
    clearTimeout(timers.get(doc.uri));
    timers.set(
      doc.uri,
      setTimeout(() => {
        try {
          analyze(doc, run);
          publish(doc);
        } catch (e) {
          process.stderr.write(`ucm lsp: ${(e as Error)?.stack ?? e}\n`);
        }
      }, run ? 0 : 200),
    );
  };

  const codeLenses = (doc: DocState) => {
    const s = fresh(doc);
    const { pos } = lines(doc.text);
    const lens = (offset: number, title: string, command = "", args: unknown[] = []) => {
      const p = pos(offset);
      return { range: { start: p, end: p }, command: { title, command, arguments: args } };
    };
    if (s.typeErrors) return [lens(0, `ucm: ${s.typeErrors} type error${s.typeErrors > 1 ? "s" : ""}; nothing hashed until they're fixed`)];
    const placement = cb ? new Placement(cb) : undefined;
    return s.rows.flatMap((r) => {
      const at = r.def.range.start;
      const short = shortHash(r.def.hash);
      const out = [];
      if (r.status === "new") out.push(lens(at, `+ new ${r.path}`), lens(at, "Add to codebase", "ucm.add", [doc.uri]));
      else if (r.status === "update") out.push(lens(at, `~ update ${r.path} (${r.note})`), lens(at, "Update codebase", "ucm.update", [doc.uri]));
      else if (r.status === "alias") out.push(lens(at, `& ${r.path}: ${r.note}`), lens(at, "Add name", "ucm.add", [doc.uri]));
      else if (r.status === "conflict") out.push(lens(at, `! ${r.path} is conflicted (${r.note}): ucm todo`));
      else {
        const where = r.def.kind === "term" ? placement?.placeOf(r.def.hash) : undefined;
        out.push(lens(at, `${r.path} ${short}${where && where.place !== "anywhere" ? ` · runs ${where.place === "server" ? "on the server" : "in the browser"}` : ""}`));
        if (isVsCode) out.push(lens(at, "Rename", "ucm.rename", [r.path]));
      }
      const t = s.tests.get(r.path);
      if (t) out.push(lens(at, t.ok ? `✓ passed${t.cached ? " (cached)" : ""}` : `✗ failed: ${plain(t.message).split("\n")[0]}`));
      return out;
    });
  };

  const inlayHints = (doc: DocState) => {
    const s = fresh(doc);
    const { pos, lineEnd } = lines(doc.text);
    return (s.analysis?.watches ?? []).flatMap((w) => {
      const r = s.watches.get(w.line);
      if (!r) return [];
      const value = plain(r.value).replace(/\s*\n\s*/g, " ");
      const label = `${r.ok ? "⧩" : "✗"} ${value.length > 120 ? value.slice(0, 117) + "…" : value}`;
      return [{ position: pos(lineEnd(w.line - 1)), label, paddingLeft: true, tooltip: plain(r.value) }];
    });
  };

  /** Markdown describing a stored definition: its names, hash, signature, placement, dependents and docs. */
  const describe = (hash: string, heading?: string) => {
    const c = cb!;
    const rec = c.store.getDef(hash);
    if (!rec) return undefined;
    const names = c.store.pathsOf(hash);
    const lines = [`**${heading ?? (names.join(", ") || "(unnamed)")}** \`${shortHash(hash)}\``, "", "```ts", rec.kind === "type" ? `${rec.signature}` : `: ${rec.signature}`, "```"];
    if (rec.kind === "term") {
      const p = new Placement(c).placeOf(hash);
      lines.push(p.place === "anywhere" ? "Runs anywhere." : `Runs ${p.place === "server" ? "on the server" : "in the browser"}: it ${p.why}.`);
    }
    const users = c.store.dependents(hash).filter((d) => c.store.pathsOf(d).length).length;
    lines.push(`${users} named dependent${users === 1 ? "" : "s"}${names.length > 1 ? ` · also named ${names.slice(1).join(", ")}` : ""}`);
    if (rec.doc) lines.push("", rec.doc);
    return lines.join("\n");
  };

  const identifierAt = (doc: DocState, offset: number): ts.Identifier | undefined => {
    const sf = doc.analyzed?.analysis?.program.getSourceFile(doc.file);
    if (!sf) return undefined;
    let id: ts.Identifier | undefined;
    const find = (n: ts.Node) => {
      if (offset < n.getStart(sf) || offset > n.end) return;
      if (ts.isIdentifier(n)) id = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    return id;
  };

  const hover = (doc: DocState, p: Position) => {
    const s = fresh(doc);
    const a = s.analysis;
    if (!a) return null;
    const offset = lines(doc.text).offset(p);
    // a definition's own name: what saving it would do
    const row = s.rows.find((r) => r.def.range.nameStart !== undefined && offset >= r.def.range.nameStart && offset <= r.def.range.nameEnd!);
    if (row) {
      const stored = describe(row.def.hash, row.path);
      const what = { new: "new: not in the codebase yet", update: `an update (${row.note})`, alias: `an alias (${row.note})`, conflict: `conflicted (${row.note})`, identical: "in the codebase" }[row.status] ?? row.status;
      return { contents: { kind: "markdown", value: stored ?? `**${row.path}** \`${shortHash(row.def.hash)}\`\n\n${what}` } };
    }
    // a name from the codebase: resolve it to the hash it stands for
    const sf = a.program.getSourceFile(doc.file);
    const id = identifierAt(doc, offset);
    if (!sf || !id) return null;
    const checker = a.program.getTypeChecker();
    let sym = checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const hash = sym && cacheRefOf(checker)(sym);
    const value = hash && describe(hash);
    return value ? { contents: { kind: "markdown", value }, range: { start: lines(doc.text).pos(id.getStart(sf)), end: lines(doc.text).pos(id.end) } } : null;
  };

  /** Run a CLI command in-process, collecting what it prints. */
  const capture = (fn: () => boolean | void): { ok: boolean; output: string } => {
    const out: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void out.push(plain(format(...args)));
    try {
      return { ok: fn() !== false, output: out.join("\n").trim() };
    } catch (e) {
      return { ok: false, output: [...out, (e as Error)?.message ?? String(e)].join("\n").trim() };
    } finally {
      console.log = log;
    }
  };

  /**
   * The codebase changes under us too: `ucm add` in a terminal, a pull. Re-check open files then (without running
   * anything: they're only re-classified), and tell the client so its sidebar and views refresh.
   */
  let changeTimer: NodeJS.Timeout | undefined;
  const watchCodebase = () => {
    try {
      fs.watch(cb!.lay.ucmDir, (_e, name) => {
        if (!name?.startsWith("codebase.sqlite")) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          for (const d of docs.values()) {
            d.analyzed = undefined;
            schedule(d, false);
          }
          notify("ucm/changed", {});
        }, 300);
      });
    } catch (e) {
      process.stderr.write(`ucm lsp: not watching the codebase: ${(e as Error).message}\n`);
    }
  };

  const refreshAll = () => {
    for (const d of docs.values()) {
      d.analyzed = undefined;
      schedule(d, true);
    }
  };

  const execute = (command: string, args: unknown[]) => {
    const c = cb!;
    if (command === "ucm.add" || command === "ucm.update") {
      const doc = docs.get(String(args[0]));
      const file = doc?.file ?? fileURLToPath(String(args[0]));
      if (doc && fs.existsSync(file) && fs.readFileSync(file, "utf8") !== doc.text) {
        message(2, `Save ${path.basename(file)} first: ucm ${command.slice(4)} saves what's on disk.`);
        return null;
      }
      const r = capture(() => tools.save(c, file, command === "ucm.add" ? "add" : "update"));
      message(r.ok ? 3 : 1, r.output || (r.ok ? "saved" : "failed"));
      refreshAll();
      return r.ok;
    }
    if (command === "ucm.edit") {
      const file = editFile();
      const r = capture(() => tools.edit(c, args.map(String), file, false));
      if (!r.ok) message(1, r.output);
      return r.ok ? pathToFileURL(file).href : null;
    }
    if (command === "ucm.mv") {
      const r = capture(() => tools.mv(c, String(args[0]), String(args[1])));
      message(r.ok ? 3 : 1, r.output || (r.ok ? "renamed" : "failed"));
      refreshAll();
      return r.ok;
    }
    throw new Error(`unknown command ${command}`);
  };

  // ---- the codebase as documents ------------------------------------------------------------------------------
  // `ucm:/lib/square.ts` is lib.square rendered with current names (`ucm:/@<hash>.ts` for an unnamed one). Its
  // references are known exactly (render reports where each lands), so they navigate like links.

  const viewUri = (hash: string) => {
    const p = cb!.store.pathsOf(hash)[0];
    return p ? `ucm:/${p.replaceAll(".", "/")}.ts` : `ucm:/@${hash}.ts`;
  };
  const hashesOf = (uri: string): string[] => {
    const p = decodeURIComponent(uri.replace(/^ucm:\/*/, "").replace(/[?#].*$/, "")).replace(/\.ts$/, "");
    try {
      return p.startsWith("@") ? cb!.lookup(`#${p.slice(1)}`) : cb!.lookup(p.replaceAll("/", "."));
    } catch {
      return [];
    }
  };
  interface View {
    text: string;
    refs: Rendered["refs"];
    starts: Map<string, number>;
    hashes: string[];
  }
  const view = (uri: string): View | undefined => {
    const c = cb!;
    const hashes = hashesOf(uri).filter((h) => c.store.getDef(h));
    if (!hashes.length) return undefined;
    const recs = hashes.map((h) => c.store.getDef(h)!);
    const placement = new Placement(c);
    const header = recs
      .map((r) => {
        const where = r.kind === "term" ? placement.placeOf(r.hash) : undefined;
        const runs = where && where.place !== "anywhere" ? ` · runs ${where.place === "server" ? "on the server" : "in the browser"}` : "";
        return `// ${c.store.pathsOf(r.hash).join(", ") || "(unnamed)"} ${shortHash(r.hash)}${runs}`;
      })
      .join("\n") + "\n";
    const r = render(recs, c.source(), c.lay, { style: "scratch" });
    const shift = header.length;
    return {
      text: header + r.text,
      refs: r.refs.map((x) => ({ ...x, start: x.start + shift, end: x.end + shift })),
      starts: new Map([...r.starts].map(([h, o]) => [h, o + shift])),
      hashes,
    };
  };
  const span = (text: string, start: number, end: number) => {
    const { pos } = lines(text);
    return { start: pos(start), end: pos(end) };
  };
  /** Where a definition is declared in its own view: its name, or the start of its declaration. */
  const declaration = (hash: string) => {
    const uri = viewUri(hash);
    const v = view(uri);
    if (!v) return undefined;
    const self = v.refs.find((r) => r.hash === hash && r.from === hash);
    const at = v.starts.get(hash) ?? 0;
    return { uri, range: self ? span(v.text, self.start, self.end) : span(v.text, at, at) };
  };
  /** Every place a named definition refers to `hash`, in their views. */
  const usages = (hash: string) => {
    const c = cb!;
    const out: { uri: string; range: ReturnType<typeof span> }[] = [];
    const users = [...new Set(c.store.dependents(hash))].filter((d) => d !== hash && c.store.pathsOf(d).length);
    const views = new Map<string, View | undefined>();
    for (const d of users) {
      const uri = viewUri(d);
      if (!views.has(uri)) views.set(uri, view(uri));
      const v = views.get(uri);
      for (const r of v?.refs ?? []) if (r.hash === hash && r.from === d) out.push({ uri, range: span(v!.text, r.start, r.end) });
    }
    return out;
  };
  const namedDependents = (hash: string) => new Set(cb!.store.dependents(hash).filter((d) => d !== hash && cb!.store.pathsOf(d).length)).size;
  /** The codebase definition at a position: a reference or declaration in a view, or a codebase name in a scratch file. */
  const hashAt = (uri: string, p: Position): string | undefined => {
    if (uri.startsWith("ucm:")) {
      const v = view(uri);
      if (!v) return undefined;
      const offset = lines(v.text).offset(p);
      const ref = v.refs.find((r) => offset >= r.start && offset <= r.end);
      if (ref) return ref.hash;
      return [...v.starts].filter(([, s]) => s <= offset).sort((a, b) => b[1] - a[1])[0]?.[0] ?? v.hashes[0];
    }
    const doc = docs.get(uri);
    if (!doc) return undefined;
    const s = fresh(doc);
    const offset = lines(doc.text).offset(p);
    const row = s.rows.find((r) => offset >= r.def.range.start && offset <= r.def.range.end && r.status === "identical");
    return codebaseNameAt(doc, offset) ?? row?.def.hash;
  };
  /** The codebase definition a name in a scratch file stands for (an import from #codebase, or a use of one). */
  const codebaseNameAt = (doc: DocState, offset: number): string | undefined => {
    const a = fresh(doc).analysis;
    const id = identifierAt(doc, offset);
    if (!id || !a) return undefined;
    const checker = a.program.getTypeChecker();
    let sym = checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return (sym && cacheRefOf(checker)(sym)) || undefined;
  };
  const SYMBOL_KIND = (rec: DefRecord) => (rec.kind === "class" ? 5 : rec.kind === "type" ? 11 : /^(<[^>]*>)?\(|^\{ ?[(<]/.test(rec.signature) ? 12 : 13);
  const viewSymbols = (uri: string) => {
    const v = view(uri);
    if (!v) return [];
    const order = [...v.starts].sort((a, b) => a[1] - b[1]);
    return order.map(([hash, start], i) => {
      const rec = cb!.store.getDef(hash)!;
      const end = order[i + 1]?.[1] ?? v.text.length;
      const self = v.refs.find((r) => r.hash === hash && r.from === hash);
      return { name: rec.nameHint, detail: rec.signature, kind: SYMBOL_KIND(rec), range: span(v.text, start, end), selectionRange: self ? span(v.text, self.start, self.end) : span(v.text, start, start) };
    });
  };
  const workspaceSymbols = (query: string) => {
    const q = query.toLowerCase();
    // the letters of the query in order, as editors' symbol search does
    const fuzzy = (s: string) => {
      let i = 0;
      for (const ch of s.toLowerCase()) if (ch === q[i]) i++;
      return i === q.length;
    };
    return cb!.store
      .names()
      .filter((n) => fuzzy(n.path))
      .slice(0, 200)
      .map((n) => {
        const rec = cb!.store.getDef(n.hash)!;
        const dot = n.path.lastIndexOf(".");
        return { name: n.path.slice(dot + 1), containerName: dot > 0 ? n.path.slice(0, dot) : "", kind: SYMBOL_KIND(rec), location: { uri: viewUri(n.hash), range: span("", 0, 0) } };
      });
  };
  /** One level of the namespace tree: sub-namespaces, and the definitions directly in it. */
  const tree = (ns: string) => {
    const c = cb!;
    const prefix = ns ? `${ns}.` : "";
    const namespaces = new Map<string, number>();
    const defs: { path: string; hash: string; kind: string }[] = [];
    for (const n of c.store.names()) {
      if (!n.path.startsWith(prefix)) continue;
      const rest = n.path.slice(prefix.length);
      const dot = rest.indexOf(".");
      if (dot >= 0) namespaces.set(rest.slice(0, dot), (namespaces.get(rest.slice(0, dot)) ?? 0) + 1);
      else defs.push(n);
    }
    const placement = new Placement(c);
    const node = process.version;
    return {
      namespaces: [...namespaces].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, path: prefix + name, count })),
      definitions: defs
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1))
        .map((n) => {
          const rec = c.store.getDef(n.hash)!;
          const test = rec.kind !== "type" && isTestPath(n.path) ? c.store.testResult(n.hash, node) : undefined;
          return {
            name: n.path.slice(prefix.length),
            path: n.path,
            hash: n.hash,
            kind: rec.kind,
            symbolKind: SYMBOL_KIND(rec),
            signature: rec.signature,
            place: rec.kind === "term" ? placement.placeOf(n.hash).place : undefined,
            test: isTestPath(n.path) && rec.kind !== "type" ? (test ? (test.ok ? "passed" : "failed") : "not run") : undefined,
            doc: rec.doc?.split("\n")[0],
            uri: viewUri(n.hash),
          };
        }),
    };
  };
  /** A scratch file to edit in: scratch.ts if it's empty, else a fresh edit-N.ts. */
  const editFile = () => {
    const root = cb!.lay.root;
    for (let i = 0; ; i++) {
      const f = path.join(root, i === 0 ? "scratch.ts" : i === 1 ? "edit.ts" : `edit-${i}.ts`);
      if (!fs.existsSync(f) || !fs.readFileSync(f, "utf8").trim()) return f;
    }
  };

  /** Lenses on a definition's view: how many definitions use it (click for where), and edit / rename. */
  const viewLenses = (uri: string) => {
    const v = view(uri);
    if (!v) return [];
    const { pos } = lines(v.text);
    return [...v.starts].flatMap(([hash, start]) => {
      const p = pos(start);
      const range = { start: p, end: p };
      const users = namedDependents(hash);
      const name = cb!.store.pathsOf(hash)[0];
      const out: Json[] = [{ range, command: { title: `${users} dependent${users === 1 ? "" : "s"}`, command: isVsCode ? "ucm.findUsages" : "", arguments: [uri, p.line, p.character] } }];
      if (isVsCode && name) {
        out.push({ range, command: { title: "Edit", command: "ucm.editDefinition", arguments: [name] } });
        out.push({ range, command: { title: "Rename", command: "ucm.rename", arguments: [name] } });
      }
      return out;
    });
  };

  const uriOf = (params: Json | undefined) => String((params?.textDocument as Json | undefined)?.uri ?? "");
  const docAt = (params: Json | undefined) => {
    const uri = String((params?.textDocument as Json | undefined)?.uri ?? "");
    const doc = docs.get(uri);
    return doc && cb ? doc : undefined;
  };

  const handle = (m: Message) => {
    const p = m.params;
    switch (m.method) {
      case "initialize": {
        const folders = (p?.workspaceFolders as { uri: string }[] | null | undefined) ?? [];
        const rootUri = (p?.rootUri as string | null | undefined) ?? folders[0]?.uri;
        const dir = rootUri ? fileURLToPath(rootUri) : process.cwd();
        try {
          cb = findCodebase(dir);
        } catch (e) {
          process.stderr.write(`ucm lsp: ${(e as Error).message}\n`);
        }
        isVsCode = /visual studio code/i.test(String((p?.clientInfo as Json | undefined)?.name ?? ""));
        const ws = ((p?.capabilities as Json | undefined)?.workspace ?? {}) as Json;
        canRefresh = { lens: !!(ws.codeLens as Json | undefined)?.refreshSupport, hints: !!(ws.inlayHint as Json | undefined)?.refreshSupport };
        send({
          id: m.id,
          result: {
            capabilities: {
              textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
              hoverProvider: true,
              codeLensProvider: { resolveProvider: false },
              inlayHintProvider: true,
              executeCommandProvider: { commands: ["ucm.add", "ucm.update", "ucm.mv", "ucm.edit"] },
              definitionProvider: true,
              referencesProvider: true,
              documentSymbolProvider: true,
              workspaceSymbolProvider: true,
            },
            serverInfo: { name: "ucm", version: "1" },
          },
        });
        return;
      }
      case "initialized":
        if (!cb) message(2, "ucm: no codebase in this workspace (run `ucm init`)");
        else watchCodebase();
        return;
      case "shutdown":
        send({ id: m.id, result: null });
        return;
      case "exit":
        process.exit(0);
      case "textDocument/didOpen": {
        const td = p!.textDocument as { uri: string; text: string; version: number };
        const file = fileURLToPath(td.uri);
        if (!isScratch(file)) return;
        const doc: DocState = { uri: td.uri, file, text: td.text, version: td.version };
        docs.set(td.uri, doc);
        schedule(doc, true);
        return;
      }
      case "textDocument/didChange": {
        const doc = docAt(p);
        if (!doc) return;
        const changes = p!.contentChanges as { text: string }[];
        doc.text = changes.at(-1)!.text;
        doc.version = (p!.textDocument as { version: number }).version;
        schedule(doc, false);
        return;
      }
      case "textDocument/didSave": {
        const doc = docAt(p);
        if (doc) schedule(doc, true);
        return;
      }
      case "textDocument/didClose": {
        const doc = docAt(p);
        if (!doc) return;
        docs.delete(doc.uri);
        notify("textDocument/publishDiagnostics", { uri: doc.uri, diagnostics: [] });
        return;
      }
      case "textDocument/codeLens": {
        const uri = uriOf(p);
        if (cb && uri.startsWith("ucm:")) return send({ id: m.id, result: viewLenses(uri) });
        const doc = docAt(p);
        send({ id: m.id, result: doc ? codeLenses(doc) : [] });
        return;
      }
      case "textDocument/definition": {
        // a codebase name goes to its source (a ucm: document): in a view, references are links; in a scratch file,
        // names from #codebase (TypeScript would answer with the generated module; the VS Code extension's
        // TypeScript plugin drops that answer). Everything else is TypeScript's.
        const uri = uriOf(p);
        let target: string | undefined;
        if (cb && uri.startsWith("ucm:")) {
          const v = view(uri);
          const offset = v ? lines(v.text).offset(p!.position as Position) : -1;
          target = v?.refs.find((r) => offset >= r.start && offset <= r.end)?.hash;
        } else {
          const doc = docAt(p);
          if (doc) target = codebaseNameAt(doc, lines(doc.text).offset(p!.position as Position));
        }
        send({ id: m.id, result: target ? (declaration(target) ?? null) : null });
        return;
      }
      case "textDocument/references": {
        const uri = uriOf(p);
        const hash = cb ? hashAt(uri, p!.position as Position) : undefined;
        const decl = hash && (p!.context as Json | undefined)?.includeDeclaration ? declaration(hash) : undefined;
        send({ id: m.id, result: hash ? [...(decl ? [decl] : []), ...usages(hash)] : [] });
        return;
      }
      case "textDocument/documentSymbol": {
        const uri = uriOf(p);
        send({ id: m.id, result: cb && uri.startsWith("ucm:") ? viewSymbols(uri) : [] });
        return;
      }
      case "workspace/symbol":
        send({ id: m.id, result: cb ? workspaceSymbols(String(p?.query ?? "")) : [] });
        return;
      // for clients that show the codebase itself (the VS Code extension's sidebar and views)
      case "ucm/tree":
        send({ id: m.id, result: cb ? tree(String(p?.namespace ?? "")) : { namespaces: [], definitions: [] } });
        return;
      case "ucm/source": {
        const v = cb ? view(String(p?.uri)) : undefined;
        send(v ? { id: m.id, result: { text: v.text } } : { id: m.id, error: { code: -32602, message: `${p?.uri} is not in the codebase` } });
        return;
      }
      case "ucm/findByType": {
        const r = searchByType(cb!, String(p?.query ?? ""));
        send({ id: m.id, result: { variables: r.variables, hits: r.hits.map((h) => ({ ...h, uri: viewUri(h.hash) })) } });
        return;
      }
      case "textDocument/inlayHint": {
        const doc = docAt(p);
        send({ id: m.id, result: doc ? inlayHints(doc) : [] });
        return;
      }
      case "textDocument/hover": {
        const uri = uriOf(p);
        if (cb && uri.startsWith("ucm:")) {
          const hash = hashAt(uri, p!.position as Position);
          const value = hash && describe(hash);
          return send({ id: m.id, result: value ? { contents: { kind: "markdown", value } } : null });
        }
        const doc = docAt(p);
        send({ id: m.id, result: doc ? hover(doc, p!.position as Position) : null });
        return;
      }
      case "workspace/executeCommand":
        send({ id: m.id, result: cb ? execute(String(p!.command), (p!.arguments as unknown[]) ?? []) : null });
        return;
      default:
        // requests we don't serve get an error; notifications are ignored, and responses to our requests too
        if (m.method && m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `${m.method} not supported` } });
    }
  };
}

