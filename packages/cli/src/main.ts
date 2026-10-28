import fs from "node:fs";
import path from "node:path";
import { checkValue, isConflicted, sameSpace, shortHash, type DefKind, type DefRecord } from "@tcm/core";
import { decode } from "./codec.ts";
import type { Analysis, ProjectDef } from "@tcm/core";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { render, run, sendRunnerOutputToStderr } from "@tcm/loader";
import { Codebase, IDENT_PATH } from "./codebase.ts";
import { migrate } from "./migrate.ts";
import { serveLsp } from "./lsp.ts";
import { searchByType } from "./search.ts";
import { checkDocExamples, renderDoc } from "./docs.ts";
import { build, dev, listBuilds, migrateTable, parseHttpFlag, pruneBuilds, start } from "./web.ts";
import { Placement } from "./placement.ts";
import { mergeBranch } from "./merge.ts";
import { evaluateCached, isTestPath, printOutcomes, runCached, summary } from "./tests.ts";
import { listPackages, upgradeTo, upgradeWithin } from "./upgrade.ts";
import { vitestChild } from "./vitest.ts";
import { formatStored, formatText } from "./fmt.ts";
import { LINT_CONFIG, lintDefinitions, lintScratch, locate, type LintIssue } from "./lint.ts";
import { diffNamespaces, printDiff, rewind, stateOf } from "./diff.ts";
import { bold, cyan, dim, green, red, yellow } from "./style.ts";
import { addRemote, listRemotes, newToken, pull, push, runOn, serve, tlsMaterial } from "./sync.ts";


class UsageError extends Error {}

const VALUE_FLAGS = new Set(["into", "file", "on", "as", "port", "host", "token", "fingerprint", "tls-cert", "tls-key", "keep", "http", "exclude"]);

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (VALUE_FLAGS.has(k)) flags[k] = argv[++i] ?? "";
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}


// ---- scratch files: check / add / update ----------------------------------------------------------

type Status = "new" | "identical" | "update" | "alias" | "conflict" | "doc";

interface Row {
  def: DefRecord;
  path: string;
  status: Status;
  note?: string;
}

const joinName = (...parts: string[]) => parts.filter(Boolean).join(".");

function classify(cb: Codebase, defs: DefRecord[], ns: string): Row[] {
  const planned = defs.map((def) => ({ def, path: def.targetPath ?? joinName(ns, def.nameHint) }));
  checkDistinct(planned, (p) => `two definitions in this file are bound to ${p.path}`);
  return classifyPaths(cb, planned);
}

/** No two planned definitions may claim the same path in the same space (a type and a value may share one). */
function checkDistinct<P extends { def: DefRecord; path: string }>(planned: P[], message: (p: P) => string) {
  planned.forEach((p, i) => {
    if (planned.some((q, j) => j < i && q.path === p.path && sameSpace(q.def.kind, p.def.kind))) throw new UsageError(message(p));
  });
}

function classifyPaths(cb: Codebase, planned: { def: DefRecord; path: string }[]): Row[] {
  return planned.map(({ def, path: p }) => {
    // only definitions in the same space compete: `type User` and `const User` live side by side
    const hs = cb.store.hashesAt(p, def.kind);
    if (hs.length === 1 && hs[0] === def.hash) {
      // the same code with a different doc: the doc isn't part of the hash, so saving it updates the definition's doc
      const stored = cb.store.getDef(def.hash)?.doc;
      return def.doc && def.doc !== stored ? { def, path: p, status: "doc", note: stored ? "doc changed" : "doc added" } : { def, path: p, status: "identical" };
    }
    if (hs.length > 1) return { def, path: p, status: "conflict", note: `${hs.length} definitions` };
    if (hs.length === 1) return { def, path: p, status: "update", note: `was ${shortHash(hs[0]!)}` };
    const others = cb.store.pathsOf(def.hash);
    if (others.length) return { def, path: p, status: "alias", note: `same as ${others.join(", ")}` };
    return { def, path: p, status: "new" };
  });
}

const STATUS_LABEL: Record<Status, string> = {
  new: green("  + new      "),
  identical: dim("  = identical"),
  doc: yellow("  ~ doc      "),
  update: yellow("  ~ update   "),
  alias: cyan("  & alias    "),
  conflict: red("  ! conflict "),
};

function printRows(rows: Row[]) {
  for (const r of rows) {
    const sig = r.def.kind === "type" ? dim(r.def.signature) : dim(`: ${r.def.signature}`);
    console.log(`${STATUS_LABEL[r.status]} ${bold(r.path)} ${sig}${r.note ? dim(`  (${r.note})`) : ""}`);
  }
}

function analyzeScratch(cb: Codebase, file: string, into?: string) {
  cb.refreshShim();
  const a = cb.analyze(file, cb.scratchSalts(into));
  for (const w of a.warnings) console.log(yellow(`warning: ${w}`));
  if (a.diagnostics.length || a.errors.length) {
    for (const d of a.diagnostics) process.stdout.write(d.formatted);
    for (const e of a.errors) console.log(red(e));
    console.log(red(`\n${path.basename(file)} has problems; nothing was ${a.diagnostics.length ? "checked" : "hashed"}.`));
    return undefined;
  }
  return a;
}

/** oxlint's findings in a scratch file, printed under its report; whether any is an error. */
function printScratchLint(cb: Codebase, file: string, only?: { start: number; end: number }[]): boolean {
  const text = fs.readFileSync(file, "utf8");
  const issues = lintScratch(cb, file, text).filter((i) => !only || only.some((r) => i.start >= r.start && i.start < r.end));
  if (!issues.length) return false;
  console.log(`\n  ${dim("lint")}`);
  for (const i of issues) printIssue(text, i, "    ");
  return issues.some((i) => i.severity === "error");
}

function printIssue(text: string, i: LintIssue, indent = "  ") {
  const at = locate(text, i.start);
  const mark = i.severity === "error" ? red("error") : yellow("warning");
  console.log(`${indent}${dim(`${at.line}:${at.col}`)}  ${mark}  ${i.message} ${dim(i.rule)}`);
  console.log(`${indent}  ${dim(at.source.trim())}`);
  if (i.help) console.log(`${indent}  ${dim(i.help)}`);
}

function check(cb: Codebase, file: string, into?: string, fresh = false): boolean {
  const a = analyzeScratch(cb, file, into);
  if (!a) return false;
  const rows = classify(cb, a.defs, into ?? a.namespace ?? "");
  console.log(`${bold(path.basename(file))}${a.namespace || into ? dim(` → ${into ?? a.namespace}`) : ""}`);
  if (rows.length) printRows(rows);
  else if (!a.watches.length) console.log(dim("  (no definitions)"));
  printScratchLint(cb, file);
  if (a.watches.length) {
    const results = evaluateCached(cb, a.watches, cb.source([...a.defs, ...a.watches]), fresh);
    for (const w of a.watches) {
      const r = results.get(w.line);
      console.log(`\n  ${dim(String(w.line).padStart(3) + " │")} ${w.expression}${r?.cached ? dim("  (cached)") : ""}`);
      console.log(`      ${r?.ok ? cyan("⧩") : red("✗")} ${(r?.value ?? "").split("\n").join("\n        ")}`);
    }
  }
  const tests = rows.filter((r) => r.def.kind !== "type" && isTestPath(r.path));
  if (tests.length) {
    const outcomes = runCached(cb, tests.map((r) => ({ path: r.path, rec: r.def })), cb.source([...a.defs, ...a.watches]), fresh);
    console.log(`\n  ${dim("tests")}  ${summary(outcomes)}`);
    printOutcomes(outcomes, "    ");
  }
  const pending = rows.filter((r) => r.status !== "identical");
  if (pending.length) {
    const needsUpdate = pending.some((r) => r.status === "update" || r.status === "conflict");
    console.log(dim(`\n  run \`tcm ${needsUpdate ? "update" : "add"}\` to save ${pending.length} definition${pending.length > 1 ? "s" : ""}`));
  }
  return true;
}

function save(cb: Codebase, file: string, mode: "add" | "update", into?: string): boolean {
  const a = analyzeScratch(cb, file, into);
  if (!a) return false;
  const rows = classify(cb, a.defs, into ?? a.namespace ?? "");
  // lint what's being saved: warnings are shown, errors (rules set to "error" in lint.config) stop the save
  const saving = rows.filter((r) => r.status !== "identical").flatMap((r) => (r.def as ProjectDef).range ?? []);
  if (saving.length && printScratchLint(cb, file, saving)) {
    console.log(red(`\n${path.basename(file)} has lint errors; nothing was saved. Fix them, or set the rule to "warn" in ${LINT_CONFIG}.`));
    return false;
  }
  cb.lockPackages(a.packages);
  return apply(cb, formattedRows(cb, file, into, a, rows), mode, `${mode} ${path.basename(file)}`, false);
}

/**
 * What's saved is formatted: the scratch file's definitions as oxfmt formats them (the file itself is left as
 * written). Formatting can't change a hash, and the formatted text is only used if, analyzed again, every
 * definition hashes the same.
 */
function formattedRows(cb: Codebase, file: string, into: string | undefined, a: Analysis, rows: Row[]): Row[] {
  const text = fs.readFileSync(file, "utf8");
  const formatted = formatText(cb, text, file);
  if (formatted === undefined || formatted === text) return rows;
  const b = cb.analyze(file, cb.scratchSalts(into), [], new Map([[file, formatted]]));
  const same = !b.errors.length && !b.diagnostics.length && b.defs.length === a.defs.length && b.defs.every((d, i) => d.hash === a.defs[i]!.hash);
  if (!same) {
    console.log(yellow(`warning: formatting ${path.basename(file)} would change what it means, so it's saved as written (please report this)`));
    return rows;
  }
  const byHash = new Map(b.defs.map((d) => [d.hash, d]));
  return rows.map((r) => ({ ...r, def: byHash.get(r.def.hash) ?? r.def }));
}

/** Store the analyzed definitions and move names: `add` only binds free names, `update` also replaces. */
function apply(cb: Codebase, rows: Row[], mode: "add" | "update", command: string, quiet: boolean): boolean {
  cb.putDefs(rows.map((r) => r.def));
  const patches = new Map<string, string>();
  const skipped: Row[] = [];
  cb.store.transaction(() => {
    for (const r of rows) {
      if (r.status === "new" || r.status === "alias") cb.store.addName(r.path, r.def.hash, r.def.kind, command);
      else if (r.status === "doc") {
        cb.store.setMetadata(r.def.hash, "doc", r.def.doc!);
        cb.store.setMetadata(r.def.hash, "docRefs", JSON.stringify(r.def.docRefs ?? []));
      }
      else if (r.status === "update" || r.status === "conflict") {
        if (mode === "add") {
          skipped.push(r);
          continue;
        }
        const olds = cb.store.hashesAt(r.path, r.def.kind);
        for (const old of olds) {
          patches.set(old, r.def.hash);
          cb.store.addPatch(old, r.def.hash);
          cb.store.clearTodo(old);
        }
        cb.store.replaceNames(r.path, olds, r.def.hash, r.def.kind, command);
      }
    }
  });
  if (quiet) {
    const counts = new Map<Status, number>();
    for (const r of rows) if (!skipped.includes(r)) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    console.log([...counts].map(([s, n]) => `${STATUS_LABEL[s].trim()} ${n}`).join(dim(" · ")) || dim("nothing to do"));
  } else printRows(rows.filter((r) => !skipped.includes(r)));
  for (const r of skipped) console.log(`${yellow("  ~ skipped  ")} ${bold(r.path)} ${dim("already names a different definition; use `tcm update`")}`);
  checkStoredRows(cb, rows.map((r) => r.def));
  if (patches.size) {
    const { updated, failed } = cb.propagate(patches, new Set(rows.map((r) => r.def.hash)));
    for (const p of updated) console.log(`${yellow("  ~ updated  ")} ${bold(p)} ${dim("(dependent)")}`);
    if (failed.length) console.log(red(`\n  ${failed.length} dependent definition(s) no longer typecheck; see \`tcm todo\``));
  }
  cb.refreshShim();
  // examples in docs are code too: the ones just saved, and the ones naming anything just replaced, must still
  // typecheck (an import's library docs are prose for readers, so they're left alone)
  if (!quiet) for (const p of checkDocExamples(cb, rows.map((r) => r.def.hash))) console.log(yellow(`  ! ${p}`));
  return skipped.length === 0;
}

// ---- data ----------------------------------------------------------------------------------------------------

const storeFile = (cb: Codebase) => path.join(cb.lay.tcmDir, "data", "store.sqlite");

/**
 * When a table's row type changes, look at what's already stored, now rather than in production: rows that still
 * fit are fine as is, rows that don't need the table's `migrate`.
 */
function checkStoredRows(cb: Codebase, defs: DefRecord[]) {
  if (!fs.existsSync(storeFile(cb))) return;
  const db = new DatabaseSync(storeFile(cb), { readOnly: true });
  try {
    for (const d of defs) {
      const t = d.table;
      if (!t?.name) continue;
      const label = `  table "${t.name}"`;
      // a renamed table's rows are still under the old name until it's first used
      const tables = [t.name, ...(t.renamedFrom ? [t.renamedFrom] : [])];
      const inTables = `tbl IN (${tables.map(() => "?").join(", ")})`;
      if (t.renamedFrom) {
        const moving = (db.prepare("SELECT count(*) AS n FROM rows WHERE tbl = ?").get(t.renamedFrom) as { n: number }).n;
        if (moving) console.log(dim(`${label}: renamed from "${t.renamedFrom}"; its ${moving} row(s) move over when the table is first used`));
      }
      const stale = (db.prepare(`SELECT id, data FROM rows WHERE ${inTables} AND schema_hash != ?`).all(...tables, t.hash) as { id: string; data: string }[]).map((r) => ({ id: r.id, value: decode(r.data) }));
      const misfits = stale.map((r) => ({ ...r, why: checkValue(t.s, r.value, "row", t.defs) })).filter((m) => m.why);
      if (stale.length && !misfits.length) console.log(dim(`${label}: ${stale.length} stored row(s) were written as an earlier type and still fit the new one`));
      else if (misfits.length && t.steps?.length) {
        // a migrate step takes a row if the row fits its parameter type
        const untaken = misfits.filter((m) => !t.steps!.some((st) => checkValue(st.s, m.value, "row", st.defs) === undefined));
        if (!untaken.length) console.log(yellow(`${label}: ${misfits.length} stored row(s) don't fit the new type; migrate takes them as they're read (or all now: tcm data migrate ${t.name})`));
        else {
          const e = untaken[0]!;
          console.log(red(`${label}: ${untaken.length} stored row(s) fit neither the new type nor any migrate step's parameter type, e.g. ${e.id}: ${e.why}`));
          console.log(red(`    reading them will fail; add a step that takes them`));
        }
      } else if (misfits.length && t.hasOptions) console.log(yellow(`${label}: ${misfits.length} stored row(s) don't fit the new type; they'll go through migrate() when read`));
      else if (misfits.length) {
        console.log(red(`${label}: ${misfits.length} stored row(s) don't fit the new type, e.g. ${misfits[0]!.id}: ${misfits[0]!.why}`));
        console.log(red(`    reading them will fail until table() gets a migrate function: table<Row>("${t.name}", { migrate: (old) => ... })`));
      }
      for (const f of t.unique ?? []) {
        const dup = db.prepare(`SELECT json_extract(data, '$."${f}"') AS v, count(*) AS n FROM rows WHERE ${inTables} GROUP BY v HAVING n > 1 AND v IS NOT NULL LIMIT 1`).get(...tables) as { v: unknown; n: number } | undefined;
        if (dup) console.log(red(`${label}: ${dup.n} stored rows have ${f} = ${JSON.stringify(dup.v)}, so ${f} can't be unique: using the table will fail until they differ`));
      }
    }
  } finally {
    db.close();
  }
}

function data(cb: Codebase, table?: string, limit = 20) {
  if (!fs.existsSync(storeFile(cb))) return console.log(dim("no tables yet (table<Row>(\"name\") from #tcm/server)"));
  const db = new DatabaseSync(storeFile(cb), { readOnly: true });
  try {
    if (!table) {
      const rows = db.prepare("SELECT tbl, count(*) AS n, count(DISTINCT schema_hash) AS versions FROM rows GROUP BY tbl ORDER BY tbl").all() as { tbl: string; n: number; versions: number }[];
      if (!rows.length) return console.log(dim("no rows stored yet"));
      for (const r of rows) console.log(`${bold(r.tbl.padEnd(20))} ${String(r.n).padStart(6)} row(s)${r.versions > 1 ? yellow(`  written under ${r.versions} row types (tcm data migrate ${r.tbl} upgrades them all)`) : ""}`);
      return;
    }
    const rows = db.prepare("SELECT id, data, schema_hash FROM rows WHERE tbl = ? ORDER BY updated DESC LIMIT ?").all(table, limit) as { id: string; data: string; schema_hash: string }[];
    if (!rows.length) return console.log(dim(`no rows in "${table}"`));
    for (const r of rows) console.log(`${dim(r.id)}  ${inspect(decode(r.data), { colors: true, breakLength: 120, depth: 4 })}  ${dim(`#${r.schema_hash.slice(0, 8)}`)}`);
  } finally {
    db.close();
  }
}

// ---- importing existing projects ---------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "dist", "build"]);

function sourceFiles(dir: string, exclude: Set<string>): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (exclude.has(path.resolve(p))) return [];
    if (e.isDirectory()) return e.name.startsWith(".") || SKIP_DIRS.has(e.name) ? [] : sourceFiles(p, exclude);
    return /\.(m|c)?ts$/.test(e.name) && !/\.d\.(m|c)?ts$|\.(test|spec)(-d)?\.(m|c)?ts$/.test(e.name) ? [p] : [];
  });
}

/** `core/src/analyze.ts` → `core.analyze`, `store/src/index.ts` → `store` */
function namespaceForFile(root: string, file: string): string {
  const segs = path.relative(root, file).replace(/\.(m|c)?ts$/, "").split(path.sep).filter((s) => s !== "src");
  if (segs.at(-1) === "index") segs.pop();
  return segs.map((s) => s.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1")).join(".");
}

function importProject(cb: Codebase, dir: string, mode: "add" | "update", into: string, verbose: boolean, exclude: string[]): boolean {
  const root = path.resolve(dir);
  const files = sourceFiles(root, new Set(exclude.map((e) => path.resolve(root, e))));
  if (!files.length) throw new UsageError(`no .ts files under ${dir}`);
  console.log(dim(`analyzing ${files.length} files under ${dir}…`));
  cb.refreshShim();
  const a = cb.analyzeProject(files, (file, name) => cb.lineageSalt(joinName(into, namespaceForFile(root, file), name)), [], cb.compilerOptions(root, "import"));
  for (const w of a.warnings) console.log(yellow(`warning: ${w}`));
  if (a.diagnostics.length || a.errors.length) {
    for (const d of a.diagnostics) process.stdout.write(d.formatted);
    for (const e of a.errors) console.log(red(e));
    console.log(red(`\n${a.errors.length + a.diagnostics.length} problem(s); nothing was imported.`));
    return false;
  }
  const planned = a.defs.map((def) => ({ def, path: joinName(into, namespaceForFile(root, def.file), def.nameHint) }));
  checkDistinct(planned, (p) => `${p.path} is defined in more than one file (one of them is ${p.def.file})`);
  cb.lockPackages(a.packages);
  return apply(cb, classifyPaths(cb, planned), mode, `import ${dir}`, !verbose);
}

function verify(cb: Codebase): boolean {
  const r = cb.verify();
  for (const p of r.problems) console.log(red(p));
  for (const m of r.mismatches) console.log(`${red("mismatch")} ${bold(m.name)}: stored ${shortHash(m.stored)}, re-rendered ${shortHash(m.rehashed)}`);
  const ok = !r.problems.length && !r.mismatches.length;
  console.log(ok ? green(`verified ${r.checked} definitions: rendering and re-hashing is the identity`) : red(`\n${r.mismatches.length} mismatch(es), ${r.problems.length} problem(s) in ${r.checked} definitions`));
  return ok;
}

// ---- views --------------------------------------------------------------------------------------------

function header(cb: Codebase, hash: string): string {
  const rec = cb.store.getDef(hash)!;
  const names = cb.store.pathsOf(hash);
  const line = `${dim("//")} ${bold(names.join(", ") || "(unnamed)")} ${dim(shortHash(hash))} ${dim(rec.kind === "type" ? rec.signature : ": " + rec.signature)}`;
  if (rec.kind === "type") return line;
  const placement = new Placement(cb);
  return `${line}
${dim(`// ${placement.describe(hash)}`)}`;
}

function view(cb: Codebase, targets: string[]) {
  for (const t of targets) {
    for (const h of cb.lookup(t).length ? cb.lookup(t) : [cb.lookupOne(t)]) {
      const rec = cb.store.getDef(h)!;
      console.log(header(cb, h));
      process.stdout.write(render([rec], cb.source(), cb.lay, { style: "scratch", exportDeclarations: true }).text);
      console.log();
    }
  }
}

function ls(cb: Codebase, ns = "") {
  const rows = cb.store.names().filter((n) => !ns || n.path === ns || n.path.startsWith(ns + "."));
  if (!rows.length) return console.log(dim(ns ? `nothing under ${ns}` : "the codebase is empty"));
  const width = Math.max(...rows.map((r) => r.path.length));
  const kindsAt = new Map<string, DefKind[]>();
  for (const r of rows) kindsAt.set(r.path, [...(kindsAt.get(r.path) ?? []), r.kind]);
  for (const r of rows) {
    const rec = cb.store.getDef(r.hash)!;
    const sig = rec.kind === "type" ? rec.signature : `: ${rec.signature}`;
    // conflicted only with definitions in its own space: a type isn't part of a clash between two values
    const conflict = kindsAt.get(r.path)!.filter((k) => sameSpace(k, r.kind)).length > 1 ? red(" (conflicted)") : "";
    console.log(`${r.path.padEnd(width)}  ${dim(shortHash(r.hash))}  ${dim(sig)}${conflict}`);
  }
}

function find(cb: Codebase, query: string) {
  if (query.trim().startsWith(":")) return findByType(cb, query.trim().slice(1));
  const q = query.trim().toLowerCase();
  const hits = cb.store.names().filter((n) => n.path.toLowerCase().includes(q) || cb.store.getDef(n.hash)!.signature.toLowerCase().includes(q));
  if (!hits.length) return console.log(dim("no matches"));
  for (const n of hits) console.log(`${bold(n.path)}  ${dim(shortHash(n.hash))}  ${dim(cb.store.getDef(n.hash)!.signature)}`);
}

/** `tcm find ':<type>'`: terms whose type has that shape (see search.ts). */
function findByType(cb: Codebase, text: string) {
  const r = searchByType(cb, text);
  if (r.variables.length) console.log(dim(`type variables: ${r.variables.join(", ")}`));
  if (!r.hits.length) return console.log(dim("no matches"));
  for (const h of r.hits) console.log(`${bold(h.path)}  ${dim(shortHash(h.hash))}  ${dim(h.signature)}${h.cost ? `  ${yellow(h.notes.join(", "))}` : ""}`);
}

function deps(cb: Codebase, target: string) {
  const rec = cb.store.getDef(cb.lookupOne(target))!;
  if (!rec.deps.length) return console.log(dim("no dependencies"));
  for (const d of rec.deps) console.log(`${cb.displayRef(d.ref)}${d.pos === "type" ? dim(" (type)") : ""}`);
}

function dependents(cb: Codebase, target: string) {
  const hs = cb.store.dependents(cb.lookupOne(target));
  if (!hs.length) return console.log(dim("no dependents"));
  for (const h of hs) console.log(cb.displayRef(`#${h}`));
}

function todo(cb: Codebase) {
  let n = 0;
  const counts = new Map<string, { hash: string; kind: DefKind }[]>();
  for (const r of cb.store.names()) counts.set(r.path, [...(counts.get(r.path) ?? []), r]);
  for (const [p, rows] of counts) {
    if (!isConflicted(rows.map((r) => r.kind))) continue;
    const hs = rows.map((r) => r.hash);
    n++;
    console.log(`${red("conflict")} ${bold(p)}: ${hs.map((h) => shortHash(h)).join(", ")}  ${dim(`tcm resolve ${p} ${shortHash(hs[0]!)}`)}`);
  }
  const live = cb.liveHashes();
  for (const t of cb.store.todos()) {
    if (!live.has(t.hash)) continue;
    n++;
    const names = cb.store.pathsOf(t.hash);
    console.log(`${yellow("needs fixing")} ${bold(names.join(", ") || shortHash(t.hash))}: ${t.message.split("\n")[0]}`);
  }
  console.log(n ? dim(`\nfix with \`tcm edit <name>\`, change the scratch file, then \`tcm update\``) : green("nothing to do"));
}

function edit(cb: Codebase, targets: string[], target: string | ((jsx: boolean) => string), force: boolean) {
  // JSX only parses in a .tsx file: the default scratch file follows what's being edited
  const jsx = targets.some((t) => (t.startsWith("#") ? [cb.lookupOne(t)] : cb.lookup(t)).some((h) => cb.store.getDef(h)?.jsx));
  const file = typeof target === "string" ? target : target(jsx);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() && !force) {
    throw new UsageError(`${path.basename(file)} is not empty; pass --force to overwrite or --file <other.ts>`);
  }
  const pathOf = new Map<string, string | undefined>();
  for (const t of targets) {
    // a name holding a type and a value edits both
    const hs = t.startsWith("#") ? [cb.lookupOne(t)] : cb.lookup(t);
    if (!hs.length) throw new UsageError(`'${t}' not found`);
    for (const h of hs) if (!pathOf.has(h)) pathOf.set(h, t.startsWith("#") ? cb.store.pathsOf(h)[0] : t);
  }
  const nsOf = (p: string) => (p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "");
  const nss = new Set([...pathOf.values()].filter((p) => p !== undefined).map(nsOf));
  const ns = nss.size === 1 ? [...nss][0]! : "";
  const recs = [...pathOf.keys()].map((h) => cb.store.getDef(h)!);
  const text = render(recs, cb.source(), cb.lay, {
    style: "scratch",
    // as you'd write it in a scratch file (export doesn't change a definition's hash)
    exportDeclarations: true,
    // references to replaced definitions point at their replacements, so a todo item is edited against the new code
    remap: (h) => cb.store.patched(h),
    // a definition whose path isn't `<namespace>.<declared name>` (other namespace, or renamed while keeping
    // its runtime name) says where it goes, so `update` binds it back to the same path
    annotate: (h, declaredAs) => {
      const p = pathOf.get(h);
      return p && p !== joinName(ns, declaredAs) ? `// tcm: path ${p}` : undefined;
    },
  }).text;
  fs.writeFileSync(file, (ns ? `// tcm: namespace ${ns}\n` : "") + text);
  console.log(`wrote ${targets.join(", ")} to ${path.basename(file)}`);
}

// ---- names --------------------------------------------------------------------------------------------

function mv(cb: Codebase, from: string, to: string) {
  if (!IDENT_PATH.test(to)) throw new UsageError(`'${to}' is not a valid name`);
  const exact = cb.store.names().filter((n) => n.path === from);
  const moves = exact.length ? exact.map((n) => ({ ...n, dest: to })) : cb.store.names().filter((n) => n.path.startsWith(from + ".")).map((n) => ({ ...n, dest: to + n.path.slice(from.length) }));
  if (!moves.length) throw new UsageError(`'${from}' not found`);
  for (const m of moves) if (cb.store.hashesAt(m.dest).length) throw new UsageError(`'${m.dest}' already exists`);
  cb.store.transaction(() => {
    for (const m of moves) {
      cb.store.removeName(m.path, m.hash, `mv ${from} ${to}`);
      cb.store.addName(m.dest, m.hash, m.kind, `mv ${from} ${to}`);
    }
  });
  cb.refreshShim();
  console.log(`moved ${moves.length} name${moves.length > 1 ? "s" : ""}`);
  for (const m of moves) {
    const rec = cb.store.getDef(m.hash)!;
    const runtime = rec.nameHint;
    if (rec.nominal && runtime !== m.dest.slice(m.dest.lastIndexOf(".") + 1)) {
      console.log(dim(`  note: ${m.dest} is still named \`${runtime}\` at runtime (\`.name\` is part of its hash); changing that means editing it`));
    }
  }
}

function alias(cb: Codebase, from: string, to: string) {
  if (!IDENT_PATH.test(to)) throw new UsageError(`'${to}' is not a valid name`);
  const h = cb.lookupOne(from);
  cb.store.addName(to, h, cb.store.getDef(h)!.kind, `alias ${from} ${to}`);
  cb.refreshShim();
  console.log(`${to} is now an alias of ${from}`);
}

function rm(cb: Codebase, name: string, force: boolean) {
  const hs = cb.store.hashesAt(name);
  if (!hs.length) throw new UsageError(`'${name}' not found`);
  for (const h of hs) {
    const otherNames = cb.store.pathsOf(h).filter((p) => p !== name);
    const users = cb.store.dependents(h).filter((d) => cb.store.pathsOf(d).length);
    if (users.length && !otherNames.length && !force) {
      throw new UsageError(`'${name}' is used by ${users.map((u) => cb.displayRef(`#${u}`)).join(", ")}; pass --force to remove the name anyway (they keep working)`);
    }
  }
  cb.store.transaction(() => hs.forEach((h) => cb.store.removeName(name, h, `rm ${name}`)));
  cb.refreshShim();
  console.log(`removed ${name}`);
}

function resolveConflict(cb: Codebase, name: string, keep: string) {
  const k = cb.lookupOne(keep);
  const hs = cb.store.hashesAt(name, cb.store.getDef(k)!.kind);
  if (!hs.includes(k)) throw new UsageError(`${keep} is not one of the definitions named ${name}`);
  cb.store.transaction(() => {
    for (const h of hs) if (h !== k) {
      cb.store.removeName(name, h, `resolve ${name} ${keep}`);
      cb.store.addPatch(h, k);
    }
  });
  cb.refreshShim();
  console.log(`${name} → ${shortHash(k)}`);
}

function diff(cb: Codebase, args: string[]) {
  const now = stateOf(cb.store.names());
  const irOf = (h: string) => cb.store.getDef(h)!.ir;
  const since = (afterId: number) => rewind(now, cb.store.history(Number.MAX_SAFE_INTEGER, afterId));
  if (args.length === 0) {
    const last = cb.store.lastBatch();
    if (!last) return console.log(dim("no changes yet"));
    const before = since(last.firstId - 1);
    return printDiff(cb, diffNamespaces(before, now, irOf), before, now, `changes from \`${last.command}\``);
  }
  if (args.length === 1 && /^\d+$/.test(args[0]!)) {
    const before = since(Number(args[0]));
    return printDiff(cb, diffNamespaces(before, now, irOf), before, now, `changes since history entry ${args[0]}`);
  }
  const [from, to] = args.length === 1 ? [cb.store.branch().name, args[0]!] : [args[0]!, args[1]!];
  for (const b of [from, to]) if (!cb.store.hasBranch(b)) throw new UsageError(`no branch named '${b}' (and not a history entry id)`);
  const [before, after] = [stateOf(cb.store.names(from)), stateOf(cb.store.names(to))];
  printDiff(cb, diffNamespaces(before, after, irOf), before, after, `${from} → ${to}`);
}

function history(cb: Codebase, limit: number) {
  let batch: number | undefined;
  for (const e of cb.store.history(limit)) {
    if (batch !== undefined && e.batch !== batch) console.log(dim("     ·"));
    batch = e.batch;
    const when = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
    const change = e.op === "add" ? green(`+ ${shortHash(e.newHash!)}`) : e.op === "delete" ? red(`- ${shortHash(e.oldHash!)}`) : yellow(`${e.oldHash ? shortHash(e.oldHash) : "∅"} → ${shortHash(e.newHash!)}`);
    console.log(`${dim(String(e.id).padStart(4))} ${dim(when)}  ${e.path.padEnd(24)} ${change}  ${dim(e.command)}`);
  }
}

function reset(cb: Codebase, id: number) {
  const entries = cb.store.history(Number.MAX_SAFE_INTEGER, id);
  const cmd = `reset ${id}`;
  cb.store.transaction(() => {
    for (const e of entries) {
      if (e.op === "add") cb.store.removeName(e.path, e.newHash!, cmd);
      else if (e.op === "delete") cb.store.addName(e.path, e.oldHash!, e.kind, cmd);
      else {
        cb.store.removeName(e.path, e.newHash!, cmd);
        if (e.oldHash) cb.store.addName(e.path, e.oldHash, e.kind, cmd);
      }
    }
  });
  cb.refreshShim();
  console.log(`undid ${entries.length} change${entries.length === 1 ? "" : "s"}`);
}

// ---- watcher ------------------------------------------------------------------------------------------

function watch(cb: Codebase, into?: string, fresh = false) {
  const root = cb.lay.root;
  let timer: NodeJS.Timeout | undefined;
  let pending = new Set<string>();
  const runChecks = () => {
    const files = [...pending];
    pending = new Set();
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      console.log(dim(`\n── ${new Date().toLocaleTimeString()} ${"─".repeat(40)}`));
      try {
        check(cb, f, into, fresh);
      } catch (e) {
        console.log(red((e as Error).stack ?? String(e)));
      }
    }
  };
  const initial = fs.readdirSync(root).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts")).map((f) => path.join(root, f));
  console.log(`${bold("tcm")} watching ${root} ${dim("(Ctrl-C to stop)")}`);
  initial.forEach((f) => pending.add(f));
  runChecks();
  fs.watch(root, (_event, filename) => {
    if (!filename || !/\.tsx?$/.test(filename) || filename.endsWith(".d.ts")) return;
    pending.add(path.join(root, filename));
    clearTimeout(timer);
    timer = setTimeout(runChecks, 80);
  });
}

// ---- entry --------------------------------------------------------------------------------------------

const HELP = `${bold("tcm")} — a content-addressed codebase manager for TypeScript

  tcm init                       set up a codebase in this directory
  tcm [watch] [--fresh]          watch *.ts/*.tsx scratch files: typecheck, hash, evaluate watch expressions and tests
                                 (their results are cached by hash; --fresh re-runs them)
  tcm check [file] [--fresh]     one-shot version of watch
  tcm lsp                        language server for editors (stdio): status, watch values, hovers, save commands
  tcm add [file] [--into ns]     add new definitions from a scratch file (default scratch.ts)
  tcm update [file] [--into ns]  add, and replace changed definitions; dependents are re-hashed
  tcm import <dir> [--into ns] [--update] [--exclude a,b] [--verbose]
                                 add an existing project: one namespace per file (src/ and index dropped)
  tcm fmt [namespace]            reformat stored definitions with oxfmt (no hash changes); options in a
                                 \`fmt.config\` definition
  tcm lint [namespace] [--fresh] lint definitions with oxlint (results are cached by hash); configure with a
                                 \`lint.config\` definition, whose imports are its plugins
  tcm test [namespace] [--fresh]  run tests (definitions named test… or under \`tests\`); results are cached by hash
  tcm verify                     re-render and re-hash every live definition; must be the identity
  tcm migrate                    rebuild a codebase written with an older hash format (keeps a backup)
  tcm view <name|#hash>...       show definitions with current names
  tcm ls [namespace]             list names
  tcm find <query>               search names and signature text
  tcm find ':<type>'             search by type, e.g. ':(xs: T[]) => T' (unknown names are type variables)
  tcm deps <name> / dependents <name>
  tcm run <name> [args...]       run a definition (functions are called with args)
  tcm edit <name>... [--file f] [--force]   write definitions to a scratch file for editing
  tcm mv <from> <to>             rename a definition or namespace (no code changes)
  tcm alias <name> <new>         add another name for a definition
  tcm rm <name> [--force]        remove a name
  tcm todo                       conflicts and dependents that need fixing
  tcm packages                   the npm packages the codebase runs: range, locked version, what uses them
  tcm upgrade <pkg> [--force]    newest versions within the ranges in use (and of what's built against it);
                                 no hashes change, everything using them is re-checked
  tcm upgrade <pkg>@<range|latest> [namespace]
                                 re-pin code to another range (a new major): re-hashed, dependents follow
  tcm resolve <name> <#hash>     pick one definition for a conflicted name
  tcm docs <name>                show documentation
  tcm diff                       what the last command changed: edits, dependents re-hashed by them, renames
  tcm diff <id> | <branch> | <a> <b>
                                 changes since a history entry, to another branch, or between branches
  tcm history [n] / reset <id>   name changes on this branch / undo back to an entry
  tcm branch [name] / switch <name>
  tcm dev <app> [--port 5173] [--http <namespace>[=/prefix]]
                                 serve a browser app (a function, or a React component) from the codebase; what needs
                                 the server runs there, called by hash
  tcm build <app> [--force]      production build into .tcm/apps/<hash>/ (immutable; reused if it exists)
  tcm data [table [n]]           typed tables (table<Row>() from #tcm/server): row counts, or a table's rows
  tcm data migrate <table>       upgrade every stored row to the current row type now, through migrate
  tcm jobs [n] | retry <id> | cancel <id>
                                 background jobs: enqueue() / every() from #tcm/server, run by tcm start / tcm dev
  tcm apps [prune [--keep 3]]    list builds (* = current); prune keeps the current build plus the newest N others
                                 (tabs on a pruned build reload themselves onto the current one)
  tcm start <app> [--port 8080] [--host] [--tls] [--keep N] [--http <namespace>[=/prefix]]
                                 serve the app in production; follows its name (deploy and rollback = moving the
                                 name) and keeps earlier builds' assets and server functions working for open tabs
  tcm merge <branch>             three-way merge into this branch; dependents follow the other side's updates

  tcm remote [add <name> <url|dir> [--token t] [--fingerprint sha256] | rm <name>]
  tcm push [remote] [--as branch] [--force]   send definitions + this branch's names (refuses if the remote moved)
  tcm pull [remote] [branch]     fetch into <remote>/<branch>; fast-forward this branch if it hasn't changed
  tcm run <name> [args] --on <remote|url|dir>   send what the remote lacks, run there, stream output back
  tcm serve [--port 7737] [--host 127.0.0.1] [--token t] [--no-run] [--tls [--tls-cert f --tls-key f]] [--insecure]
                                 serve this codebase; clients with the token can push, pull and run code.
                                 --tls without files makes a self-signed certificate; clients pin its fingerprint
`;

export async function main(argv: string[]): Promise<number> {
  // code from the codebase that runs in this process (server functions under tcm dev, say) reports errors at
  // its definitions, not its generated modules
  process.setSourceMapsEnabled(true);
  const { positional, flags } = parseArgs(argv);
  const [cmd = "watch", ...args] = positional;
  const cwd = process.cwd();
  const into = typeof flags.into === "string" ? flags.into : undefined;
  if (into !== undefined && into !== "" && !IDENT_PATH.test(into)) throw new UsageError(`'${into}' is not a valid namespace`);
  const scratch = (f?: string) => path.resolve(cwd, f ?? "scratch.ts");
  const need = (n: number, usage: string) => {
    if (args.length < n) throw new UsageError(`usage: tcm ${usage}`);
  };

  if (cmd === "help" || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (cmd === "init") {
    const cb = Codebase.init(cwd);
    const file = scratch();
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        `// Definitions here are checked and hashed by \`tcm\`; bare expressions are watch expressions.
// Import saved definitions with: import { name } from "#codebase/namespace"

/** Square a number. */
export const square = (x: number): number => x * x;

square(12);
`,
      );
    }
    console.log(`initialized codebase in ${cb.lay.tcmDir}\nnext: run \`tcm\` and edit scratch.ts`);
    return 0;
  }

  // migrate opens codebases the version guard would refuse
  if (cmd === "migrate") return migrate(Codebase.findRoot(cwd)) ? 0 : 1;
  // the editor says where the workspace is (initialize), so the codebase is found then
  if (cmd === "lsp") {
    sendRunnerOutputToStderr();
    serveLsp((dir) => Codebase.find(dir), { classify, save: (cb, file, mode) => save(cb, file, mode), mv, edit, migrateTable });
    return -1; // serve until the editor says exit
  }

  const cb = Codebase.find(cwd);
  switch (cmd) {
    case "watch":
      watch(cb, into, !!flags.fresh);
      return -1; // keep running
    case "check":
      return check(cb, scratch(args[0]), into, !!flags.fresh) ? 0 : 1;
    case "add":
    case "update":
      return save(cb, scratch(args[0]), cmd, into) ? 0 : 1;
    case "import":
      need(1, "import <dir> [--into ns] [--update]");
      return importProject(cb, args[0]!, flags.update ? "update" : "add", into ?? "", !!flags.verbose, typeof flags.exclude === "string" ? flags.exclude.split(",") : []) ? 0 : 1;
    case "verify":
      return verify(cb) ? 0 : 1;
    case "dev":
      need(1, "dev <app> [--port 5173]");
      await dev(cb, args[0]!, Number(typeof flags.port === "string" ? flags.port : 5173), typeof flags.http === "string" ? parseHttpFlag(flags.http) : undefined);
      return -1; // keep serving
    case "data":
      if (args[0] === "migrate") {
        need(2, "data migrate <table>");
        return (await migrateTable(cb, args[1]!)) ? 0 : 1;
      }
      data(cb, args[0], Number(args[1] ?? 20));
      return 0;
    case "jobs": {
      const file = path.join(cb.lay.tcmDir, "data", "jobs.sqlite");
      if (!fs.existsSync(file)) return (console.log(dim("no jobs yet (enqueue() from a server function, or every() for recurring ones)")), 0);
      const db = new DatabaseSync(file);
      try {
        const find = (prefix: string) => {
          const rows = db.prepare("SELECT id FROM jobs WHERE id LIKE ?").all(`${prefix}%`) as { id: string }[];
          if (rows.length !== 1) throw new UsageError(rows.length ? `'${prefix}' matches ${rows.length} jobs` : `no job '${prefix}'`);
          return rows[0]!.id;
        };
        if (args[0] === "retry") {
          need(2, "jobs retry <id>");
          db.prepare("UPDATE jobs SET status = 'queued', run_at = ?, attempts = 0, last_error = NULL, finished = NULL WHERE id = ?").run(Date.now(), find(args[1]!));
          return (console.log("queued again"), 0);
        }
        if (args[0] === "cancel") {
          need(2, "jobs cancel <id>");
          const r = db.prepare("UPDATE jobs SET status = 'cancelled', finished = ? WHERE id = ? AND status = 'queued'").run(Date.now(), find(args[1]!));
          return (console.log(r.changes ? "cancelled" : dim("not queued (already running or finished)")), 0);
        }
        const rows = db.prepare("SELECT * FROM jobs ORDER BY created DESC LIMIT ?").all(Number(args[0] ?? 30)) as Record<string, string | number | null>[];
        const colour: Record<string, (s: string) => string> = { done: green, failed: red, queued: yellow, running: cyan, cancelled: dim };
        for (const r of rows) {
          const when = new Date(Number(r.status === "queued" ? r.run_at : (r.finished ?? r.run_at))).toISOString().replace("T", " ").slice(0, 19);
          // a finished job's last error is history; a failed or retrying one's is the news
          const err = r.last_error && r.status !== "done" ? dim(`  ${String(r.last_error).split("\n")[0]}`) : "";
          console.log(`${dim(String(r.id).slice(0, 8))}  ${(colour[String(r.status)] ?? dim)(String(r.status).padEnd(9))} ${String(r.fn_name).padEnd(24)} ${dim(`${r.attempts}/${r.max_attempts}  ${when}`)}${err}`);
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case "apps": {
      if (args[0] === "prune") {
        pruneBuilds(cb, Number(typeof flags.keep === "string" ? flags.keep : 3));
        return 0;
      }
      const builds = listBuilds(cb);
      if (!builds.length) return (console.log(dim("no builds yet (`tcm build <app>`)")), 0);
      for (const b of builds) {
        let current = false;
        try {
          current = cb.lookupOne(b.app, "value") === b.hash;
        } catch {}
        console.log(`${current ? green("* ") : "  "}${b.app.padEnd(16)} ${dim(shortHash(b.hash))}  ${b.builtAt.replace("T", " ").slice(0, 19)}  ${dim(`${b.endpoints.length} endpoint(s)`)}`);
      }
      return 0;
    }
    case "build":
      need(1, "build <app> [--force]");
      await build(cb, args[0]!, { force: !!flags.force });
      return 0;
    case "start": {
      need(1, "start <app> [--port 8080] [--host 127.0.0.1] [--tls [--tls-cert f --tls-key f]]");
      const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
      const tls = flags.tls || str("tls-cert") ? tlsMaterial(cb, str("tls-cert"), str("tls-key")) : undefined;
      await start(cb, args[0]!, {
        port: Number(str("port") ?? 8080),
        host: str("host") ?? "127.0.0.1",
        tls,
        keep: str("keep") === undefined ? undefined : Number(str("keep")),
        http: str("http") === undefined ? undefined : parseHttpFlag(str("http")!),
      });
      return -1; // keep serving
    }
    // the test runner's child process (see vitest.ts)
    case "internal-vitest":
      await vitestChild(args[0]!);
      return 0;
    case "fmt": {
      const ns = args[0] ?? "";
      const live = cb.liveHashes();
      const hashes = cb.store.names().filter((n) => live.has(n.hash) && (!ns || n.path === ns || n.path.startsWith(ns + "."))).map((n) => n.hash);
      const r = formatStored(cb, [...new Set(hashes)]);
      for (const h of r.formatted) console.log(`  ${green("~")} ${cb.store.pathsOf(h).join(", ") || shortHash(h)}`);
      for (const h of r.skipped) console.log(yellow(`  skipped ${cb.store.pathsOf(h)[0] ?? shortHash(h)}: formatting it would change its hash (please report this)`));
      console.log(`${r.formatted.length ? `reformatted ${r.formatted.length} definition(s)` : green("everything is formatted")}${dim(`; no hashes changed`)}`);
      if (r.formatted.length) cb.refreshShim(true);
      return r.skipped.length ? 1 : 0;
    }
    case "lint": {
      const ns = args[0] ?? "";
      const live = cb.liveHashes();
      const targets = cb.store.names().filter((n) => n.kind !== "type" && live.has(n.hash) && (!ns || n.path === ns || n.path.startsWith(ns + ".")));
      const results = lintDefinitions(cb, targets, !!flags.fresh);
      let warnings = 0;
      let errors = 0;
      for (const r of results) {
        if (!r.issues.length) continue;
        console.log(`${bold(r.path)} ${dim(shortHash(r.hash))}`);
        for (const i of r.issues) {
          printIssue(r.text, i);
          if (i.severity === "error") errors++;
          else warnings++;
        }
      }
      const cached = results.filter((r) => r.cached).length;
      console.log(
        `${errors ? red(`${errors} error(s)`) : green("no errors")}, ${warnings} warning(s) in ${results.length} definition(s)${cached ? dim(` (${cached} cached)`) : ""}`,
      );
      return errors ? 1 : 0;
    }
    case "test": {
      const ns = args[0] ?? "";
      const names = cb.store.names().filter((n) => n.kind !== "type" && isTestPath(n.path) && (!ns || n.path === ns || n.path.startsWith(ns + ".")));
      if (!names.length) {
        console.log(dim(`no tests${ns ? ` under ${ns}` : ""} (tests are definitions named test… or under a \`tests\` namespace)`));
        return 0;
      }
      const outcomes = runCached(cb, names.map((n) => ({ path: n.path, rec: cb.store.getDef(n.hash)! })), cb.source(), !!flags.fresh);
      printOutcomes(outcomes);
      console.log(`\n${summary(outcomes)}`);
      return outcomes.every((o) => o.result.ok) ? 0 : 1;
    }
    case "view":
      need(1, "view <name|#hash>...");
      view(cb, args);
      return 0;
    case "ls":
      ls(cb, args[0]);
      return 0;
    case "find":
      need(1, "find <query>");
      find(cb, args.join(" "));
      return 0;
    case "deps":
      need(1, "deps <name>");
      deps(cb, args[0]!);
      return 0;
    case "dependents":
      need(1, "dependents <name>");
      dependents(cb, args[0]!);
      return 0;
    case "run": {
      need(1, "run <name> [args...] [--on <remote>]");
      const h = cb.lookupOne(args[0]!, "value");
      if (cb.store.getDef(h)!.kind === "type") throw new UsageError(`${args[0]} is a type`);
      if (typeof flags.on === "string") return runOn(cb, flags.on, h, args.slice(1));
      return run(h, args.slice(1), cb.source(), cb.lay);
    }
    case "remote": {
      const [sub, name, url] = args;
      if (sub === "add") {
        if (!name || !url) throw new UsageError("usage: tcm remote add <name> <url|path> [--token t]");
        addRemote(cb, name, url, typeof flags.token === "string" ? flags.token : undefined, typeof flags.fingerprint === "string" ? flags.fingerprint : undefined);
        console.log(`added remote ${name}`);
      } else if (sub === "rm") {
        if (!name) throw new UsageError("usage: tcm remote rm <name>");
        cb.store.deleteSetting(`remote.${name}`);
        console.log(`removed remote ${name}`);
      } else {
        const remotes = listRemotes(cb);
        if (!remotes.length) console.log(dim("no remotes; add one with `tcm remote add <name> <url|path>`"));
        for (const [n, c] of remotes) console.log(`${bold(n)}  ${c.url}${c.token ? dim("  (token)") : ""}`);
      }
      return 0;
    }
    case "push":
      await push(cb, args[0] ?? "origin", typeof flags.as === "string" ? flags.as : undefined, !!flags.force);
      return 0;
    case "pull":
      await pull(cb, args[0] ?? "origin", args[1]);
      return 0;
    case "serve": {
      const token = typeof flags.token === "string" ? flags.token : (process.env.TCM_TOKEN ?? newToken());
      const port = Number(typeof flags.port === "string" ? flags.port : 7737);
      const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
      const tls = flags.tls || str("tls-cert") ? tlsMaterial(cb, str("tls-cert"), str("tls-key")) : undefined;
      const host = str("host") ?? "127.0.0.1";
      // --insecure acknowledges clear-text tokens beyond localhost
      serve(cb, { host, port, token, allowRun: !flags["no-run"], tls }, !!flags.insecure);
      return -1; // keep running
    }
    case "edit":
      need(1, "edit <name>...");
      edit(cb, args, typeof flags.file === "string" ? scratch(flags.file) : (jsx) => scratch(jsx ? "scratch.tsx" : "scratch.ts"), !!flags.force);
      return 0;
    case "mv":
      need(2, "mv <from> <to>");
      mv(cb, args[0]!, args[1]!);
      return 0;
    case "alias":
      need(2, "alias <name> <new>");
      alias(cb, args[0]!, args[1]!);
      return 0;
    case "rm":
      need(1, "rm <name>");
      rm(cb, args[0]!, !!flags.force);
      return 0;
    case "todo":
      todo(cb);
      return 0;
    case "packages":
      listPackages(cb);
      return 0;
    case "upgrade": {
      need(1, "upgrade <package>[@range|@latest] [namespace] [--force]");
      const spec = args[0]!;
      const at = spec.lastIndexOf("@");
      const [name, target] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
      const ok = target ? upgradeTo(cb, name, target, args[1]) : upgradeWithin(cb, name, !!flags.force);
      if (ok) cb.refreshShim();
      return ok ? 0 : 1;
    }
    case "diff":
      diff(cb, args);
      return 0;
    case "resolve":
      need(2, "resolve <name> <#hash>");
      resolveConflict(cb, args[0]!, args[1]!);
      return 0;
    case "docs": {
      need(1, "docs <name>");
      const rec = cb.store.getDef(cb.lookupOne(args[0]!))!;
      console.log(renderDoc(cb, rec, { evaluate: true })?.markdown ?? dim("no documentation"));
      return 0;
    }
    case "history":
      history(cb, Number(args[0] ?? 30));
      return 0;
    case "reset":
      need(1, "reset <id>");
      reset(cb, Number(args[0]));
      return 0;
    case "branch":
      if (!args[0]) {
        for (const b of cb.store.branches()) console.log(`${b === cb.store.branch().name ? green("* ") : "  "}${b}`);
        return 0;
      }
      cb.store.createBranch(args[0]);
      console.log(`created branch ${args[0]} from ${cb.store.branch().name}`);
      return 0;
    case "merge":
      need(1, "merge <branch>");
      return mergeBranch(cb, args[0]!).conflicts.length ? 1 : 0;
    case "switch":
      need(1, "switch <branch>");
      cb.store.switchBranch(args[0]!);
      cb.refreshShim(true);
      console.log(`on branch ${args[0]}`);
      return 0;
    default:
      throw new UsageError(`unknown command '${cmd}'\n\n${HELP}`);
  }
}

/** Process entry point: run a command, report errors, set the exit code. */
export async function runCli(argv: string[]): Promise<void> {
  try {
    const code = await main(argv);
    if (code >= 0) process.exitCode = code;
  } catch (e) {
    if (e instanceof UsageError || (e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError))) {
      console.error(red(e.message));
      if (process.env.TCM_DEBUG) console.error(e.stack);
    } else throw e;
    process.exitCode = 1;
  }
}
