// `tcm lsp`: a Language Server for editors, alongside TypeScript's own. TypeScript keeps doing completions, type
// errors and go-to-definition; this adds what only tcm knows. For each definition in a scratch file: what it is
// to the codebase (new, an update, identical, an alias, a conflict), its hash and placement, with commands that
// save it. Watch values and test results inline, hovers on codebase names, and tcm's own errors.
//
// It speaks JSON-RPC over stdin/stdout, so nothing else may write to stdout: console output goes to stderr, and
// test and watch runners are told to do the same.
import fs from "node:fs";
import path from "node:path";
import { format, inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ts } from "@tcm/core";
import { cacheRefOf, schemaText, SERVER_API_MODULE, shortHash, type Analysis, type DefRecord, type ProjectDef } from "@tcm/core";
import { nodeArgs, writeRunner } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { Placement } from "./placement.ts";
import { evaluateCached, isTestPath, runCached } from "./testing.ts";
import { searchByType } from "./search.ts";
import { decode } from "./codec.ts";
import { renderDoc } from "./docs.ts";
import { definitionPage, docSummary, find } from "./pages.ts";
import { packageList, packagePage, packageUsers } from "./package-pages.ts";
import { publishingList, releaseCheck, releaseList, releasePage } from "./release-pages.ts";
import { changelog, contributionsOn, generatedNotes, packPackage, planRelease, reasonFor, releasePackage, writeDraft } from "./releases.ts";
import { author } from "./contributions.ts";
import { upgradeTo, upgradeWithin } from "./upgrade.ts";
import { prepareTestRun } from "./vitest.ts";
import { lintScratch, type LintIssue } from "./lint.ts";
import { formatText } from "./fmt.ts";
import { ensureView, hashesOfViewFile, srcDir, viewText, type View } from "./views.ts";
import { resultKey } from "./vitest.ts";
import { searchCode } from "./pages.ts";
import { entryChanges, historyList, branchList } from "./changes.ts";
import { branchChanges } from "./changes.ts";
import { joinName } from "./mirror.ts";

/** What the language server needs from the CLI (passed in, so this module doesn't import the CLI's entry). */
export interface LspTools {
  classify(cb: Codebase, defs: DefRecord[], ns: string): { def: DefRecord; path: string; status: string; note?: string }[];
  save(cb: Codebase, file: string, mode: "add" | "update"): boolean;
  mv(cb: Codebase, from: string, to: string): void;
  edit(cb: Codebase, targets: string[], file: string, force: boolean): void;
  migrateTable(cb: Codebase, table: string): Promise<boolean>;
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
    /** oxlint's findings, offsets in `text` */
    lint: LintIssue[];
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
  // a definition's document as a `tcm:` URI, rendered only when the editor asks for it (tcm/source)
  const lazyUri = (hash: string) => `tcm:/@${hash}${cb!.store.getDef(hash)?.jsx ? ".tsx" : ".ts"}`;
  // where the codebase's code runs, worked out once per state of the names (it reads the whole codebase)
  let placed: { at: string; placement: Placement } | undefined;
  const placementNow = (): Placement => {
    const at = `${cb!.store.branch().name}@${cb!.store.logHead()}`;
    if (placed?.at !== at) placed = { at, placement: new Placement(cb!) };
    return placed.placement;
  };
  let nextId = 1;
  const send = connect(process.stdin, process.stdout, (m) => {
    try {
      handle(m);
    } catch (e) {
      if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32603, message: (e as Error)?.message ?? String(e) } });
      else process.stderr.write(`tcm lsp: ${(e as Error)?.stack ?? e}\n`);
    }
  });
  const notify = (method: string, params: unknown) => send({ method, params });
  const request = (method: string, params?: unknown) => send({ id: `tcm-${nextId++}`, method, params });
  const message = (type: 1 | 2 | 3, text: string) => notify("window/showMessage", { type, message: text });

  /** Only top-level `.ts`/`.tsx` files of the codebase are scratch files, as for the watcher. */
  const isScratch = (file: string) => !!cb && path.dirname(file) === cb.lay.root && /\.tsx?$/.test(file) && !file.endsWith(".d.ts");

  const analyze = (doc: DocState, run: boolean) => {
    const c = cb!;
    const problems: { message: string; severity: 1 | 2 }[] = [];
    const state: NonNullable<DocState["analyzed"]> = { text: doc.text, rows: [], problems, typeErrors: 0, lint: [], watches: new Map(), tests: new Map() };
    doc.analyzed = state;
    // lint as written, type errors or not: it's about the code, not whether it checks
    try {
      state.lint = lintScratch(c, doc.file, doc.text);
    } catch (e) {
      problems.push({ message: `lint: ${(e as Error).message}`, severity: 2 });
    }
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
      const r = c.store.testResult(t.def.hash, resultKey(c));
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
      // tcm's errors start with `file:line:col: `
      const m = /^(.*?):(\d+):(\d+): ([\s\S]*)$/.exec(p.message);
      const here = m && path.resolve(m[1]!) === doc.file;
      const line = here ? Number(m[2]) - 1 : 0;
      const start = { line, character: here ? Number(m[3]) - 1 : 0 };
      return { range: { start, end: pos(lineEnd(line)) }, severity: p.severity, source: "tcm", message: here ? m[4]! : p.message };
    });
    for (const i of s.lint) {
      diagnostics.push({
        range: { start: pos(i.start), end: pos(Math.max(i.end, i.start)) },
        severity: i.severity === "error" ? 1 : 2,
        source: "oxlint",
        message: i.help ? `${i.message}\n${i.help}` : i.message,
        code: i.rule,
        ...(i.url ? { codeDescription: { href: i.url } } : {}),
      } as (typeof diagnostics)[number]);
    }
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
          process.stderr.write(`tcm lsp: ${(e as Error)?.stack ?? e}\n`);
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
    if (s.typeErrors) return [lens(0, `tcm: ${s.typeErrors} type error${s.typeErrors > 1 ? "s" : ""}; nothing hashed until they're fixed`)];
    const placement = cb ? placementNow() : undefined;
    return s.rows.flatMap((r) => {
      const at = r.def.range.start;
      const short = shortHash(r.def.hash);
      const out = [];
      if (r.status === "new") out.push(lens(at, `+ new ${r.path}`), lens(at, "Add to codebase", "tcm.add", [doc.uri]));
      else if (r.status === "update") out.push(lens(at, `~ update ${r.path} (${r.note})`), lens(at, "Update codebase", "tcm.update", [doc.uri]));
      else if (r.status === "alias") out.push(lens(at, `& ${r.path}: ${r.note}`), lens(at, "Add name", "tcm.add", [doc.uri]));
      else if (r.status === "doc") out.push(lens(at, `~ ${r.path}: ${r.note}`), lens(at, "Update codebase", "tcm.update", [doc.uri]));
      else if (r.status === "conflict") out.push(lens(at, `! ${r.path} is conflicted (${r.note}): tcm todo`));
      else {
        const where = r.def.kind === "term" ? placement?.label(r.def.hash) : undefined;
        out.push(lens(at, `${r.path} ${short}${where ? ` · ${where}` : ""}`));
        if (isVsCode) out.push(lens(at, "Rename", "tcm.rename", [r.path]));
      }
      const t = s.tests.get(r.path);
      if (t) out.push(lens(at, t.ok ? `✓ passed${t.cached ? " (cached)" : ""}` : `✗ failed: ${plain(t.message).split("\n")[0]}`));
      // run it under the debugger, as it is in this buffer
      if (isVsCode && r.def.kind === "term" && (isTestPath(r.path) || /^(<[^>]*>)?\(\)\s*=>/.test(r.def.signature))) {
        out.push(lens(at, "Debug", isTestPath(r.path) ? "tcm.debugTest" : "tcm.debugDefinition", [r.path, doc.uri]));
      }
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
      const d = placementNow().describe(hash);
      lines.push(`${d[0]!.toUpperCase()}${d.slice(1)}.`);
    }
    const users = c.store.dependents(hash).filter((d) => c.store.pathsOf(d).length).length;
    lines.push(`${users} named dependent${users === 1 ? "" : "s"}${names.length > 1 ? ` · also named ${names.slice(1).join(", ")}` : ""}`);
    // the doc as it renders: current names, embeds; examples are shown (they're evaluated on the page)
    const doc = renderDoc(c, rec, { evaluate: false });
    if (doc) lines.push("", doc.markdown);
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
    const checker = a.checker;
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
   * The codebase changes under us too: `tcm add` in a terminal, a pull. Re-check open files then (without running
   * anything: they're only re-classified), and tell the client so its sidebar and views refresh.
   */
  let changeTimer: NodeJS.Timeout | undefined;
  const watchCodebase = () => {
    try {
      // rows change while an app runs: tell the client (it refreshes its data view), separately from code changes
      let dataTimer: NodeJS.Timeout | undefined;
      fs.watch(cb!.lay.tcmDir, { recursive: true }, (_e, name) => {
        if (name && /^data[\\/]store\.sqlite/.test(name)) {
          clearTimeout(dataTimer);
          dataTimer = setTimeout(() => notify("tcm/dataChanged", {}), 500);
          return;
        }
        if (!name?.startsWith("codebase.sqlite")) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          placed = undefined;
          for (const d of docs.values()) {
            d.analyzed = undefined;
            schedule(d, false);
          }
          notify("tcm/changed", {});
        }, 300);
      });
    } catch (e) {
      process.stderr.write(`tcm lsp: not watching the codebase: ${(e as Error).message}\n`);
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
    if (command === "tcm.add" || command === "tcm.update") {
      const doc = docs.get(String(args[0]));
      const file = doc?.file ?? fileURLToPath(String(args[0]));
      if (doc && fs.existsSync(file) && fs.readFileSync(file, "utf8") !== doc.text) {
        message(2, `Save ${path.basename(file)} first: tcm ${command.slice(4)} saves what's on disk.`);
        return null;
      }
      const r = capture(() => tools.save(c, file, command === "tcm.add" ? "add" : "update"));
      message(r.ok ? 3 : 1, r.output || (r.ok ? "saved" : "failed"));
      refreshAll();
      return r.ok;
    }
    if (command === "tcm.edit") {
      const jsx = args.some((a) => { try { return c.lookup(String(a)).some((h) => c.store.getDef(h)?.jsx); } catch { return false; } });
      const file = editFile(jsx ? ".tsx" : ".ts");
      const r = capture(() => tools.edit(c, args.map(String), file, false));
      if (!r.ok) message(1, r.output);
      return r.ok ? pathToFileURL(file).href : null;
    }
    // releases: [package, version?]; a draft (tcm.releaseDraft) opens in the editor; a release's notes come from its draft, if any
    if (command === "tcm.release" || command === "tcm.releaseDraft" || command === "tcm.pack") {
      const [name, version] = args.map((a) => (a === undefined || a === null || a === "" ? undefined : String(a)));
      return (async () => {
        try {
          if (command === "tcm.releaseDraft") {
            const plan = planRelease(c, name, undefined, true);
            const file = writeDraft(c, plan, generatedNotes(c, plan, [...c.store.contributions(), ...(await contributionsOn(c, undefined))]));
            return pathToFileURL(file).href;
          }
          if (command === "tcm.pack") {
            const r = packPackage(c, name, version, undefined);
            message(3, `packed ${r.pkg.name}@${r.version} into ${path.relative(c.lay.root, r.dir)}: ${r.modules} module(s)`);
            return r.dir;
          }
          const { release, plan } = await releasePackage(c, { name, version, force: false, author: author() });
          message(3, `released ${release.package}@${release.version}: ${reasonFor(plan)}`);
          refreshAll();
          return { package: release.package, version: release.version };
        } catch (e) {
          message(1, (e as Error).message);
          return null;
        }
      })();
    }
    if (command === "tcm.upgrade") {
      // [name] within its ranges; [name, target, namespace?] to another range
      const [name, target, namespace] = args.map((a) => (a === undefined || a === null ? undefined : String(a)));
      const r = capture(() => (target ? upgradeTo(c, name!, target, namespace) : upgradeWithin(c, name!, false)));
      message(r.ok ? 3 : 1, r.output || (r.ok ? "upgraded" : "upgrade failed"));
      c.refreshShim();
      refreshAll();
      return r.ok;
    }
    if (command === "tcm.dataMigrate") {
      return (async () => {
        const out: string[] = [];
        const log = console.log;
        console.log = (...a: unknown[]) => void out.push(plain(format(...a)));
        let ok = false;
        try {
          ok = await tools.migrateTable(c, String(args[0]));
        } catch (e) {
          out.push((e as Error)?.message ?? String(e));
        } finally {
          console.log = log;
        }
        message(ok ? 3 : 1, out.join("\n").trim() || (ok ? "migrated" : "failed"));
        notify("tcm/dataChanged", {});
        return ok;
      })();
    }
    // a definition added to a scratch file (its saved copy on disk: the editor saves it first)
    if (command === "tcm.editInto") {
      const r = capture(() => tools.edit(c, [String(args[1])], fileURLToPath(String(args[0])), false));
      message(r.ok ? 3 : 1, r.output.trim() || (r.ok ? "added" : "failed"));
      return r.ok ? String(args[0]) : null;
    }
    if (command === "tcm.mv") {
      const r = capture(() => tools.mv(c, String(args[0]), String(args[1])));
      message(r.ok ? 3 : 1, r.output || (r.ok ? "renamed" : "failed"));
      refreshAll();
      return r.ok;
    }
    throw new Error(`unknown command ${command}`);
  };

  // ---- the codebase as documents ------------------------------------------------------------------------------
  // A definition's document is its file in .tcm/src (`lib/square.ts` is lib.square rendered with current names,
  // `@<hash>.ts` an unnamed one): a real file, so debuggers can stop in it. `tcm:/lib/square.ts` names the same
  // view for clients that ask for it. Its references are known exactly (render reports where each lands), so they
  // navigate like links.

  const viewUri = (hash: string) => pathToFileURL(ensureView(cb!, hash)).href;
  /** A definition's view: its file in .tcm/src, or a tcm: document */
  const isView = (uri: string) => uri.startsWith("tcm:") || (uri.startsWith("file:") && !!cb && fileURLToPath(uri).startsWith(srcDir(cb) + path.sep));
  const hashesOf = (uri: string): string[] => {
    if (uri.startsWith("file:")) return hashesOfViewFile(cb!, fileURLToPath(uri));
    const p = decodeURIComponent(uri.replace(/^tcm:\/*/, "").replace(/[?#].*$/, "")).replace(/\.tsx?$/, "");
    try {
      return p.startsWith("@") ? cb!.lookup(`#${p.slice(1)}`) : cb!.lookup(p.replaceAll("/", "."));
    } catch {
      return [];
    }
  };
  // the same text as the definition's file in .tcm/src
  const view = (uri: string): View | undefined => viewText(cb!, hashesOf(uri).filter((h) => cb!.store.getDef(h)), placementNow());
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
    if (isView(uri)) {
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
    const checker = a.checker;
    let sym = checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return (sym && cacheRefOf(checker)(sym)) || undefined;
  };
  const SYMBOL_KIND = (rec: DefRecord) => (rec.kind === "file" ? 1 : rec.kind === "class" ? 5 : rec.kind === "type" ? 11 : /^(<[^>]*>)?\(|^\{ ?[(<]/.test(rec.signature) ? 12 : 13);
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
    // (files too: pages, configuration, images)
    for (const n of c.store.names(undefined, true)) {
      if (!n.path.startsWith(prefix)) continue;
      const rest = n.path.slice(prefix.length);
      const dot = rest.indexOf(".");
      if (dot >= 0) namespaces.set(rest.slice(0, dot), (namespaces.get(rest.slice(0, dot)) ?? 0) + 1);
      else defs.push(n);
    }
    const placement = placementNow();
    return {
      namespaces: [...namespaces].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, path: prefix + name, count })),
      definitions: defs
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1))
        .map((n) => ({ ...entry(n.path, n.hash, placement), name: n.path.slice(prefix.length) })),
    };
  };

  /** A function made by `every(...)`: a recurring job. */
  const isSchedule = (rec: DefRecord) => rec.spans.some((s) => s.ext?.module === SERVER_API_MODULE && s.ext.export === "every");
  /**
   * An app's entry point: it runs in the browser, takes no arguments, and nothing named calls it (what `tcm dev`
   * is pointed at, like `app.main`).
   */
  const isApp = (hash: string, rec: DefRecord, placement: Placement) =>
    rec.kind === "term" &&
    placement.placeOf(hash).place === "browser" &&
    namedDependents(hash) === 0 &&
    (rec.params ? rec.params.params.every((p) => p.optional || p.rest) : /^\(\)\s*=>/.test(rec.signature));
  /** One definition as the sidebar shows it: what it is, where it runs, what it's for. */
  const entry = (p: string, hash: string, placement: Placement) => {
    const c = cb!;
    const rec = c.store.getDef(hash)!;
    const isTest = rec.kind !== "type" && isTestPath(p);
    const place = rec.kind === "term" ? placement.placeOf(hash).place : undefined;
    const test = isTest ? c.store.testResult(hash, resultKey(c)) : undefined;
    const role = rec.kind === "file" ? "file"
      : isTest ? "test"
      : rec.kind !== "term" ? "type"
      : rec.table ? "table"
      : isSchedule(rec) ? "schedule"
      : isApp(hash, rec, placement) ? "app"
      : place === "server" ? "server"
      : place === "browser" ? "browser"
      : "shared";
    const endpoint = place === "server" && placement.crossable(hash);
    return {
      name: p,
      path: p,
      hash,
      kind: rec.kind,
      role,
      symbolKind: SYMBOL_KIND(rec),
      signature: rec.signature,
      ...(isTest ? {} : { place }),
      ...(endpoint ? { endpoint: true, ...(placement.streams(hash) ? { streaming: true } : {}) } : {}),
      test: isTest ? (test ? (test.ok ? "passed" : "failed") : "not run") : undefined,
      doc: rec.doc?.split("\n")[0],
      uri: viewUri(hash),
    };
  };

  /** Rows per table, from the app data store (what `tcm data` lists). */
  const rowCounts = (): Map<string, number> => {
    const file = path.join(cb!.lay.tcmDir, "data", "store.sqlite");
    if (!fs.existsSync(file)) return new Map();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return new Map((db.prepare("SELECT tbl, count(*) AS n FROM rows GROUP BY tbl").all() as { tbl: string; n: number }[]).map((r) => [r.tbl, r.n]));
    } finally {
      db.close();
    }
  };

  /**
   * The apps in the codebase, each with what it's made of: the plan `tcm build` makes (browser code, endpoints),
   * the tables its server code uses, and the jobs and tests in its namespace.
   */
  const apps = () => {
    const c = cb!;
    const placement = placementNow();
    const names = c.store.names();
    const rows = rowCounts();
    return names
      .filter((n) => n.kind === "term" && isApp(n.hash, c.store.getDef(n.hash)!, placement))
      .map((app) => {
        const plan = placement.planApp(app.hash);
        const named = (hs: Iterable<string>) => [...hs].flatMap((h) => (c.store.pathsOf(h)[0] ? [entry(c.store.pathsOf(h)[0]!, h, placement)] : [])).sort((a, b) => (a.path < b.path ? -1 : 1));
        // the tables the endpoints' code reaches
        const tables = new Map<string, string>();
        const seen = new Set<string>();
        const queue = [...plan.endpoints];
        while (queue.length) {
          const h = queue.pop()!;
          if (seen.has(h)) continue;
          seen.add(h);
          const rec = c.store.getDef(h);
          if (!rec) continue;
          if (rec.table && c.store.pathsOf(h).length) tables.set(h, rec.table.name ?? c.store.pathsOf(h)[0]!);
          for (const d of rec.deps) if (d.ref.startsWith("#")) queue.push(d.ref.slice(1));
        }
        const ns = app.path.includes(".") ? app.path.slice(0, app.path.lastIndexOf(".") + 1) : "";
        const inNs = names.filter((n) => n.path.startsWith(ns) && !n.path.slice(ns.length).includes("."));
        return {
          path: app.path,
          hash: app.hash,
          uri: viewUri(app.hash),
          endpoints: named(plan.endpoints),
          browser: named(plan.browser),
          tables: named(tables.keys()).map((t) => ({ ...t, table: tables.get(t.hash)!, rows: rows.get(tables.get(t.hash)!) ?? 0 })),
          schedules: inNs
            .filter((n) => n.kind === "term" && isSchedule(c.store.getDef(n.hash)!))
            .map((n) => ({ ...entry(n.path, n.hash, placement), spec: /every\(\s*(["'`])(.*?)\1/.exec(c.store.getDef(n.hash)!.sourceText)?.[2] ?? "" })),
          tests: inNs.filter((n) => n.kind !== "type" && isTestPath(n.path)).map((n) => entry(n.path, n.hash, placement)),
          errors: plan.errors,
        };
      });
  };

  /**
   * How to debug something: a Node launch configuration. Generated modules map to definition files and scratch
   * files, so breakpoints there hit; Node's own code and packages are skipped when stepping.
   */
  const debugConfig = (kind: string, name: string | undefined, uri: string | undefined): Json => {
    const c = cb!;
    const base = {
      type: "node",
      request: "launch",
      cwd: c.lay.root,
      runtimeExecutable: process.execPath,
      skipFiles: ["<node_internals>/**", "**/node_modules/**"],
      resolveSourceMapLocations: ["**", "!**/node_modules/**"],
      sourceMaps: true,
    };
    // a scratch file's own definitions (not saved yet) run as they are in its buffer
    const doc = uri ? docs.get(uri) : undefined;
    const scratch = doc && isScratch(doc.file) ? fresh(doc) : undefined;
    const src = scratch?.analysis ? c.source([...scratch.analysis.defs, ...scratch.analysis.watches]) : c.source();
    const resolve = (n: string) => scratch?.rows.find((r) => r.path === n)?.def ?? c.store.getDef(c.lookupOne(n, "value"));
    if (kind === "run") {
      const rec = resolve(name!);
      if (!rec) throw new Error(`'${name}' not found`);
      return { ...base, name: `tcm run ${name}`, program: writeRunner(rec.hash, src, c.lay), runtimeArgs: nodeArgs(c.lay), console: "integratedTerminal" };
    }
    if (kind === "test") {
      const tests = name
        ? [resolve(name)].filter((r): r is DefRecord => !!r)
        : (scratch?.rows ?? []).filter((r) => r.def.kind !== "type" && isTestPath(r.path)).map((r) => r.def);
      if (!tests.length) throw new Error(name ? `'${name}' not found` : "no tests here");
      const { requestFile } = prepareTestRun(c, tests, src);
      return { ...base, name: `tcm test ${name ?? path.basename(doc!.file)}`, program: process.argv[1], args: ["internal-vitest", requestFile], autoAttachChildProcesses: true };
    }
    if (kind === "app") {
      // the server in Node; when tcm dev prints its URL, the page opens in a Chrome debug session
      return {
        ...base,
        name: `tcm dev ${name}`,
        program: process.argv[1],
        args: ["dev", name!, "--port", "0"],
        console: "integratedTerminal",
        serverReadyAction: { pattern: "url\\s+(https?://\\S+)", uriFormat: "%s", action: "debugWithChrome", webRoot: c.lay.root, killOnServerStop: true },
      };
    }
    throw new Error(`can't debug a ${kind}`);
  };

  /** Open the app data store read-only, or undefined while there's no data yet. */
  const withStore = <T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T | undefined => {
    const file = path.join(cb!.lay.tcmDir, "data", "store.sqlite");
    if (!fs.existsSync(file)) return undefined;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const summary = (v: unknown) => inspect(v, { depth: 2, breakLength: Infinity, maxArrayLength: 5, maxStringLength: 60 });

  /**
   * Every table with data, and every table the codebase declares: rows, how many are stored as an older row type
   * than the declaring definition's, and that definition.
   */
  const dataTables = () => {
    const c = cb!;
    const declared = declaredTables();
    const stored = withStore((db) => db.prepare("SELECT tbl, schema_hash, count(*) AS n FROM rows GROUP BY tbl, schema_hash").all() as { tbl: string; schema_hash: string; n: number }[]) ?? [];
    const names = [...new Set([...declared.keys(), ...stored.map((r) => r.tbl)])].sort();
    return names.map((name) => {
      const d = declared.get(name);
      const rows = stored.filter((r) => r.tbl === name);
      const total = rows.reduce((n, r) => n + r.n, 0);
      const older = d ? rows.filter((r) => r.schema_hash !== d.schema).reduce((n, r) => n + r.n, 0) : 0;
      return { table: name, rows: total, older, ...(d ? { path: d.path, hash: d.hash, uri: viewUri(d.hash), fields: d.fields } : {}) };
    });
  };
  /** Tables the codebase declares: their definition, row schema, and the row type's fields (columns). */
  const declaredTables = () => {
    const c = cb!;
    const out = new Map<string, { path: string; hash: string; schema: string; fields: { name: string; type: string }[] }>();
    for (const n of c.store.names()) {
      const t = n.kind === "term" ? c.store.getDef(n.hash)?.table : undefined;
      if (!t?.name) continue;
      const row = t.s.t === "ref" ? t.defs[t.s.id] : t.s;
      const fields = row?.t === "object" ? Object.entries(row.props).map(([name, p]) => ({ name, type: schemaText(p.s, t.defs) + (p.optional ? "?" : "") })) : [];
      out.set(t.name, { path: n.path, hash: n.hash, schema: t.hash, fields });
    }
    return out;
  };
  const FIELD = /^[A-Za-z_$][\w$]*$/;
  /** A cell: strings as they are, dates as ISO, small things inline, objects as one short line. */
  const cell = (v: unknown): string =>
    v === undefined || v === null ? "" : typeof v === "string" ? v : v instanceof Date ? v.toISOString() : typeof v === "object" ? summary(v) : String(v);
  /**
   * A page of a table's rows for the viewer: searched (anywhere in the row), sorted (by a field, the id or when it
   * was written; newest first by default) and paged in SQLite.
   */
  const dataPage = (table: string, q: { offset: number; limit: number; search?: string; sort?: { field: string; desc?: boolean } }) => {
    const d = declaredTables().get(table);
    return (
      withStore((db) => {
        const where = `tbl = ?${q.search ? " AND instr(lower(data), lower(?)) > 0" : ""}`;
        const args = q.search ? [table, q.search] : [table];
        const total = (db.prepare(`SELECT count(*) AS n FROM rows WHERE ${where}`).get(...args) as { n: number }).n;
        const f = q.sort?.field;
        const by = f === "id" ? "id" : f === "updated" || !f || !FIELD.test(f) ? "updated" : `json_extract(data, '$."${f}"')`;
        const dir = f ? (q.sort?.desc ? "DESC" : "ASC") : "DESC";
        const rows = db.prepare(`SELECT id, data, schema_hash, updated FROM rows WHERE ${where} ORDER BY ${by} ${dir}, id LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset) as {
          id: string;
          data: string;
          schema_hash: string;
          updated: number;
        }[];
        const values = rows.map((r) => decode(r.data) as Record<string, unknown>);
        // an undeclared table's columns are whatever its rows have
        const fields = d?.fields.length ? d.fields : [...new Set(values.flatMap((v) => (v && typeof v === "object" ? Object.keys(v) : [])))].map((name) => ({ name, type: "" }));
        return {
          total,
          fields,
          rows: rows.map((r, i) => {
            const v = values[i]!;
            return {
              id: r.id,
              updated: r.updated,
              older: !!d && r.schema_hash !== d.schema,
              cells: Object.fromEntries(fields.map((fl) => [fl.name, cell(v && typeof v === "object" ? v[fl.name] : undefined)])),
              detail: inspect(v, { depth: null, breakLength: 80 }),
              summary: summary(v),
              uri: `tcm:/.data/${encodeURIComponent(table)}/${encodeURIComponent(r.id)}.txt`,
            };
          }),
        };
      }) ?? { total: 0, fields: d?.fields ?? [], rows: [] }
    );
  };
  /** One row, in full (`tcm:/.data/<table>/<id>.txt`). */
  const rowText = (table: string, id: string) =>
    withStore((db) => {
      const r = db.prepare("SELECT data, schema_hash, updated FROM rows WHERE tbl = ? AND id = ?").get(table, id) as { data: string; schema_hash: string; updated: number } | undefined;
      if (!r) return `// table "${table}" has no row ${id} (any more)\n`;
      return `// table "${table}", row ${id}: written ${new Date(r.updated).toISOString()} as row type #${r.schema_hash.slice(0, 8)}\n\n${inspect(decode(r.data), { depth: null, breakLength: 100 })}\n`;
    }) ?? `// no data yet\n`;

  /** A table's newest rows, as text (`tcm:/.data/<table>.txt`). */
  const tableText = (table: string) => {
    const file = path.join(cb!.lay.tcmDir, "data", "store.sqlite");
    if (!fs.existsSync(file)) return `// table "${table}": no data yet\n`;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const total = (db.prepare("SELECT count(*) AS n FROM rows WHERE tbl = ?").get(table) as { n: number }).n;
      const rows = db.prepare("SELECT id, data, schema_hash FROM rows WHERE tbl = ? ORDER BY updated DESC LIMIT 200").all(table) as { id: string; data: string; schema_hash: string }[];
      const lines = rows.map((r) => `${r.id}  ${inspect(decode(r.data), { depth: 4, breakLength: 120 })}`);
      return `// table "${table}": ${total} row${total === 1 ? "" : "s"}${total > rows.length ? `, newest ${rows.length} shown` : ""}\n\n${lines.join("\n")}\n`;
    } finally {
      db.close();
    }
  };
  /** A scratch file to edit in: scratch.ts if it's empty, else a fresh edit-N.ts (`.tsx` for JSX). */
  // the scratch file what's edited goes to (added to what's in it): scratch.tsx for JSX, and for the rest too while
  // it holds work and scratch.ts doesn't
  const editFile = (ext = ".ts") => {
    const root = cb!.lay.root;
    const work = (f: string) => fs.existsSync(f) && !!fs.readFileSync(f, "utf8").trim();
    const [plain, withJsx] = [path.join(root, "scratch.ts"), path.join(root, "scratch.tsx")];
    return ext === ".tsx" || (work(withJsx) && !work(plain)) ? withJsx : plain;
  };

  /**
   * Quick fixes in a scratch file: a codebase name it doesn't import (TypeScript can't find it), imported from the
   * namespace that has it; and a name it imports from the codebase, edited here too (added to this file).
   */
  const codeActions = (doc: DocState, range: { start: Position; end: Position }) => {
    const c = cb!;
    const s = fresh(doc);
    const out: unknown[] = [];
    const imports = ts.parse(doc.file, doc.text).statements.filter(ts.isImportDeclaration);
    const { pos, offset } = lines(doc.text);
    // a new import goes after the file's others, or its namespace line
    const last = imports.at(-1);
    const pragma = /^\/\/ tcm: namespace \S+\n/.exec(doc.text);
    const at = pos(last ? last.end + (doc.text[last.end] === "\n" ? 1 : 0) : pragma ? pragma[0].length : 0);
    for (const d of s.analysis?.diagnostics ?? []) {
      // "Cannot find name 'x'" (and "… Did you mean"), on these lines
      if (d.code !== 2304 && d.code !== 2552) continue;
      // (where it is: `file:line:col` in the formatted message, without its colours)
      const where = /:(\d+):(\d+)/.exec(d.formatted.replace(/\x1b\[[0-9;]*m/g, ""));
      const name = /'([^']+)'/.exec(d.message)?.[1];
      const line = where ? Number(where[1]) - 1 : -1;
      if (!name || line < range.start.line || line > range.end.line) continue;
      const found = c.store.names().filter((n) => n.path.slice(n.path.lastIndexOf(".") + 1) === name);
      for (const n of found.slice(0, 8)) {
        const ns = n.path.slice(0, Math.max(0, n.path.lastIndexOf(".")));
        const spec = ns ? `#codebase/${ns.replaceAll(".", "/")}` : "#codebase";
        const newText = `import ${n.kind === "type" ? "type " : ""}{ ${name} } from "${spec}";\n`;
        out.push({ title: `Import ${name} from "${spec}"`, kind: "quickfix", isPreferred: found.length === 1, edit: { changes: { [doc.uri]: [{ range: { start: at, end: at }, newText }] } } });
      }
    }
    // the name at the cursor, if the file imports it from the codebase
    const o = offset(range.start);
    const word = /[\w$]*$/.exec(doc.text.slice(0, o))![0] + /^[\w$]*/.exec(doc.text.slice(o))![0];
    for (const st of word ? imports : []) {
      const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
      const b = st.importClause?.namedBindings;
      if (!spec.startsWith("#codebase") || !b || !ts.isNamedImports(b)) continue;
      const e = b.elements.find((x) => x.name.text === word);
      if (!e) continue;
      const target = joinName(spec.slice("#codebase".length).replace(/^\//, "").replaceAll("/", "."), (e.propertyName ?? e.name).text);
      let hashes: string[] = [];
      try {
        hashes = c.lookup(target);
      } catch {
        continue;
      }
      // (a file is edited as the file it is; JSX goes only in a .tsx file)
      const recs = hashes.map((h) => c.store.getDef(h));
      if (!recs.length || recs.some((r) => !r || r.kind === "file" || (r.jsx && !doc.file.endsWith(".tsx")))) continue;
      const title = `Edit ${target} here too`;
      out.push({ title, kind: "refactor", command: { title, command: "tcm.editThisToo", arguments: [doc.uri, target] } });
    }
    return out;
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
      const out: Json[] = [{ range, command: { title: `${users} dependent${users === 1 ? "" : "s"}`, command: isVsCode ? "tcm.findUsages" : "", arguments: [uri, p.line, p.character] } }];
      if (isVsCode && name) {
        out.push({ range, command: { title: "Edit", command: "tcm.editDefinition", arguments: [name] } });
        out.push({ range, command: { title: "Rename", command: "tcm.rename", arguments: [name] } });
        const rec = cb!.store.getDef(hash);
        if (rec?.kind === "term" && (isTestPath(name) || /^(<[^>]*>)?\(\)\s*=>/.test(rec.signature))) {
          out.push({ range, command: { title: "Debug", command: isTestPath(name) ? "tcm.debugTest" : "tcm.debugDefinition", arguments: [name] } });
        }
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
          process.stderr.write(`tcm lsp: ${(e as Error).message}\n`);
        }
        isVsCode = /visual studio code/i.test(String((p?.clientInfo as Json | undefined)?.name ?? ""));
        const ws = ((p?.capabilities as Json | undefined)?.workspace ?? {}) as Json;
        canRefresh = { lens: !!(ws.codeLens as Json | undefined)?.refreshSupport, hints: !!(ws.inlayHint as Json | undefined)?.refreshSupport };
        send({
          id: m.id,
          result: {
            capabilities: {
              // willSaveWaitUntil: scratch files are formatted (oxfmt) as they're saved, with no editor setup
              textDocumentSync: { openClose: true, change: 1, save: { includeText: false }, willSaveWaitUntil: true },
              documentFormattingProvider: true,
              hoverProvider: true,
              codeLensProvider: { resolveProvider: false },
              codeActionProvider: { codeActionKinds: ["quickfix", "refactor"] },
              inlayHintProvider: true,
              executeCommandProvider: { commands: ["tcm.add", "tcm.update", "tcm.mv", "tcm.edit", "tcm.editInto", "tcm.dataMigrate", "tcm.upgrade", "tcm.release", "tcm.releaseDraft", "tcm.pack"] },
              definitionProvider: true,
              referencesProvider: true,
              documentSymbolProvider: true,
              workspaceSymbolProvider: true,
            },
            serverInfo: { name: "tcm", version: "1" },
          },
        });
        return;
      }
      case "initialized":
        if (!cb) message(2, "tcm: no codebase in this workspace (run `tcm init`)");
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
      case "textDocument/codeAction": {
        const doc = docAt(p);
        send({ id: m.id, result: cb && doc && p?.range ? codeActions(doc, p.range as { start: Position; end: Position }) : [] });
        return;
      }
      case "textDocument/codeLens": {
        const uri = uriOf(p);
        if (cb && isView(uri)) return send({ id: m.id, result: viewLenses(uri) });
        const doc = docAt(p);
        send({ id: m.id, result: doc ? codeLenses(doc) : [] });
        return;
      }
      case "textDocument/definition": {
        // a codebase name goes to its source (a tcm: document): in a view, references are links; in a scratch file,
        // names from #codebase (TypeScript would answer with the generated module; the VS Code extension's
        // TypeScript plugin drops that answer). Everything else is TypeScript's.
        const uri = uriOf(p);
        let target: string | undefined;
        if (cb && isView(uri)) {
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
        send({ id: m.id, result: cb && isView(uri) ? viewSymbols(uri) : [] });
        return;
      }
      case "workspace/symbol":
        send({ id: m.id, result: cb ? workspaceSymbols(String(p?.query ?? "")) : [] });
        return;
      // for clients that show the codebase itself (the VS Code extension's sidebar and views)
      case "tcm/tree":
        send({ id: m.id, result: cb ? tree(String(p?.namespace ?? "")) : { namespaces: [], definitions: [] } });
        return;
      case "tcm/data":
        send({ id: m.id, result: cb ? dataTables() : [] });
        return;
      case "tcm/rows":
        send({
          id: m.id,
          result: cb
            ? dataPage(String(p?.table), {
                offset: Math.max(0, Number(p?.offset ?? 0)),
                limit: Math.min(500, Math.max(1, Number(p?.limit ?? 100))),
                search: typeof p?.search === "string" && p.search ? p.search : undefined,
                sort: p?.sort as { field: string; desc?: boolean } | undefined,
              })
            : { total: 0, fields: [], rows: [] },
        });
        return;
      // pages, as in Unison's codebase UI
      case "tcm/page": {
        const target = p?.hash ? String(p.hash) : p?.uri ? hashesOf(String(p.uri))[0] : p?.path ? cb?.lookup(String(p.path))[0] : undefined;
        const placement = cb && placementNow();
        const page = cb && target ? definitionPage(cb, target, placement!, { viewUri }) : undefined;
        // (an app's page starts it, rather than running it as a program)
        const rec = target ? cb?.store.getDef(target) : undefined;
        send(page ? { id: m.id, result: { ...page, app: !!rec && isApp(target!, rec, placement!) } } : { id: m.id, error: { code: -32602, message: "no such definition" } });
        return;
      }
      case "tcm/namespace": {
        if (!cb) return send({ id: m.id, result: null });
        const ns = String(p?.namespace ?? "");
        const t = tree(ns);
        // a namespace's front page is its README definition's doc, as in Unison
        const readme = t.definitions.find((d) => d.name === "README");
        const rec = readme && cb.store.getDef(readme.hash);
        send({
          id: m.id,
          result: {
            namespace: ns,
            readme: rec ? renderDoc(cb, rec, { evaluate: true, link: (h) => `tcm-page:${h}` })?.markdown : undefined,
            namespaces: t.namespaces,
            definitions: t.definitions.filter((d) => d !== readme).map((d) => ({ ...d, summary: docSummary(cb!.store.getDef(d.hash)!) })),
          },
        });
        return;
      }
      case "tcm/find":
        send({ id: m.id, result: cb ? find(cb, String(p?.query ?? ""), viewUri) : [] });
        return;
      // the Changes view: branches, this branch's history, and what an entry changed
      case "tcm/branches":
        send({ id: m.id, result: cb ? branchList(cb) : [] });
        return;
      case "tcm/history":
        send({ id: m.id, result: cb ? historyList(cb, Number(p?.limit ?? 30)) : [] });
        return;
      case "tcm/branchChanges":
        try {
          send({ id: m.id, result: cb ? branchChanges(cb, String(p?.branch ?? ""), lazyUri) : [] });
        } catch (e) {
          send({ id: m.id, error: { code: -32602, message: (e as Error).message } });
        }
        return;
      case "tcm/historyEntry":
        send({ id: m.id, result: cb ? entryChanges(cb, String(p?.hash ?? ""), lazyUri) : [] });
        return;
      // find in files, for the codebase: lines of definitions and pages with the text in them
      case "tcm/searchCode":
        send({ id: m.id, result: cb ? searchCode(cb, String(p?.query ?? ""), { caseSensitive: !!p?.caseSensitive, wholeWord: !!p?.wholeWord, regex: !!p?.regex }, viewUri) : { hits: [], matches: 0, truncated: false } });
        return;
      case "tcm/apps":
        send({ id: m.id, result: cb ? apps() : [] });
        return;
      // a launch configuration for VS Code's JavaScript debugger: run a definition, a test, or an app (server in
      // Node, page in Chrome), with breakpoints in definition files and scratch files
      case "tcm/debug": {
        try {
          send({ id: m.id, result: debugConfig(String(p?.kind), p?.name === undefined ? undefined : String(p.name), p?.uri === undefined ? undefined : String(p.uri)) });
        } catch (e) {
          send({ id: m.id, error: { code: -32602, message: (e as Error).message } });
        }
        return;
      }
      // the codebase's own packages (manifests) and their releases
      case "tcm/publishing":
      case "tcm/releaseCheck":
      case "tcm/releasePage":
      case "tcm/releaseList":
      case "tcm/changelog":
        try {
          const name = String(p?.name ?? "");
          const result =
            !cb ? [] : m.method === "tcm/publishing" ? publishingList(cb) : m.method === "tcm/releaseCheck" ? releaseCheck(cb, name) : m.method === "tcm/releasePage" ? releasePage(cb, name) : m.method === "tcm/releaseList" ? releaseList(cb, name) : { markdown: changelog(cb, name) };
          send({ id: m.id, result });
        } catch (e) {
          send({ id: m.id, error: { code: -32602, message: (e as Error).message } });
        }
        return;
      // the packages the codebase runs: the lock, what uses each, and a page per package and range
      case "tcm/packages":
        send({ id: m.id, result: cb ? packageList(cb) : [] });
        return;
      case "tcm/packageUsers":
        send({ id: m.id, result: cb ? packageUsers(cb, String(p?.name), String(p?.range)) : [] });
        return;
      case "tcm/packagePage":
        try {
          const page = packagePage(cb!, String(p?.name), String(p?.range));
          send({ id: m.id, result: { ...page, users: page.users.map((u) => ({ ...u, uri: viewUri(u.hash) })) } });
        } catch (e) {
          send({ id: m.id, error: { code: -32602, message: (e as Error).message } });
        }
        return;
      case "tcm/source": {
        const row = /^tcm:\/*\.data\/([^/]+)\/([^/]+)\.txt$/.exec(String(p?.uri));
        if (cb && row) return send({ id: m.id, result: { text: rowText(decodeURIComponent(row[1]!), decodeURIComponent(row[2]!)) } });
        const data = /^tcm:\/*\.data\/([^/]+)\.txt$/.exec(String(p?.uri));
        if (cb && data) return send({ id: m.id, result: { text: tableText(decodeURIComponent(data[1]!)) } });
        const v = cb ? view(String(p?.uri)) : undefined;
        send(v ? { id: m.id, result: { text: v.text } } : { id: m.id, error: { code: -32602, message: `${p?.uri} is not in the codebase` } });
        return;
      }
      case "tcm/findByType": {
        const r = searchByType(cb!, String(p?.query ?? ""));
        send({ id: m.id, result: { variables: r.variables, hits: r.hits.map((h) => ({ ...h, uri: viewUri(h.hash) })) } });
        return;
      }
      case "textDocument/inlayHint": {
        const doc = docAt(p);
        send({ id: m.id, result: doc ? inlayHints(doc) : [] });
        return;
      }
      // oxfmt: Format Document, and formatting as a scratch file is saved
      case "textDocument/formatting":
      case "textDocument/willSaveWaitUntil": {
        const doc = docs.get(uriOf(p));
        let edits: Json[] = [];
        if (cb && doc && isScratch(doc.file)) {
          try {
            const formatted = formatText(cb, doc.text, doc.file);
            if (formatted !== undefined && formatted !== doc.text) {
              const { pos } = lines(doc.text);
              edits = [{ range: { start: { line: 0, character: 0 }, end: pos(doc.text.length) }, newText: formatted }];
            }
          } catch (e) {
            message(2, `formatting: ${(e as Error).message}`);
          }
        }
        send({ id: m.id, result: edits });
        return;
      }
      case "textDocument/hover": {
        const uri = uriOf(p);
        if (cb && isView(uri)) {
          const hash = hashAt(uri, p!.position as Position);
          const value = hash && describe(hash);
          return send({ id: m.id, result: value ? { contents: { kind: "markdown", value } } : null });
        }
        const doc = docAt(p);
        send({ id: m.id, result: doc ? hover(doc, p!.position as Position) : null });
        return;
      }
      case "workspace/executeCommand":
        // each command is its own history entry (this process outlives many)
        cb?.store.endBatch();
        // a command may finish later (migrating data runs the table's code)
        Promise.resolve(cb ? execute(String(p!.command), (p!.arguments as unknown[]) ?? []) : null).then(
          (result) => send({ id: m.id, result }),
          (e) => send({ id: m.id, error: { code: -32603, message: (e as Error)?.message ?? String(e) } }),
        );
        return;
      default:
        // requests we don't serve get an error; notifications are ignored, and responses to our requests too
        if (m.method && m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `${m.method} not supported` } });
    }
  };
}

