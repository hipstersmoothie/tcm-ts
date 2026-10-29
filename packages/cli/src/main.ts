import fs from "node:fs";
import path from "node:path";
import { checkValue, isConflicted, IR_VERSION, sameSpace, shortHash, TS_VERSION, type DefKind, type DefRecord } from "@tcm/core";
import { parse } from "@bomb.sh/router";
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
import { pack } from "./pack.ts";
import { vitestChild } from "./vitest.ts";
import { formatStored, formatText } from "./fmt.ts";
import { LINT_CONFIG, lintDefinitions, lintScratch, locate, type LintIssue } from "./lint.ts";
import { diffNamespaces, keyPath, printDiff, stateOf, type NameState } from "./diff.ts";
import { bold, cyan, dim, green, red, yellow } from "./style.ts";
import { addRemote, contribute, listRemotes, newToken, openRemote, pull, push, reviewUrl, runOn, serve, tlsMaterial } from "./sync.ts";
import { author, printContribution, printContributions } from "./contributions.ts";
import { changelog, contributionsOn, generatedNotes, MARKER, packPackage, parseSpec, planRelease, reasonFor, releasePackage, writeDraft, writtenPart, type Plan } from "./releases.ts";
import { findPackage, packagesIn } from "./manifests.ts";
import { LINTS } from "./semver-checks.ts";
import { commands, root } from "./commands.ts";
import { helpText, suggest, usageError } from "./help.ts";
import { complete } from "./complete.ts";
import { ask, choose, chooseName, confirm, interactive, intro, outro, showInstallProgress, success, UsageError } from "./ui.ts";


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

async function rm(cb: Codebase, name: string, force: boolean) {
  const hs = cb.store.hashesAt(name);
  if (!hs.length) throw new UsageError(`'${name}' not found`);
  for (const h of hs) {
    const otherNames = cb.store.pathsOf(h).filter((p) => p !== name);
    const users = cb.store.dependents(h).filter((d) => cb.store.pathsOf(d).length);
    if (users.length && !otherNames.length && !force) {
      const used = `'${name}' is used by ${users.map((u) => cb.displayRef(`#${u}`)).join(", ")}`;
      if (!(await confirm(`${used}. Remove the name anyway? (they keep working)`))) throw new UsageError(`${used}; pass --force to remove the name anyway (they keep working)`);
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

/**
 * A history entry: a number, how many entries back on this branch (0 is the latest; `tcm history` shows them),
 * or a hash from any branch's history (a prefix will do; the `#` is optional, since shells read `#…` as a comment).
 */
function causalArg(cb: Codebase, ref: string): string {
  if (/^\d+$/.test(ref)) {
    const n = Number(ref);
    const c = cb.store.causalLog(n + 1)[n];
    if (!c) throw new UsageError(`this branch's history isn't ${n} entries long`);
    return c.hash;
  }
  if (/^(@?[^@]+)?@v?\d+\.\d+\.\d+/.test(ref)) return releaseAt(cb, ref).causal;
  const hs = cb.store.causalsWithPrefix(ref.replace(/^#/, ""));
  if (hs.length !== 1) throw new UsageError(hs.length ? `${ref} matches ${hs.length} history entries; give more of the hash` : `no history entry ${ref} (see \`tcm history\`)`);
  return hs[0]!;
}

const isHistoryRef = (ref: string) => /^(@?[^@]+)?@v?\d+\.\d+\.\d+/.test(ref) || isEntryRef(ref);
const isEntryRef = (ref: string) => /^(\d+|#?[a-z2-7]{4,})$/.test(ref) && (/^\d+$/.test(ref) || ref.startsWith("#") || /[2-7]/.test(ref));
const stateAt = (cb: Codebase, causal: string) => stateOf(cb.store.namespaceRows(cb.store.causal(causal)!.namespace));

function diff(cb: Codebase, args: string[]) {
  const now = stateOf(cb.store.names());
  const irOf = (h: string) => cb.store.getDef(h)!.ir;
  if (args.length === 0) {
    const head = cb.store.causal(cb.store.head())!;
    if (!head.parents.length) return console.log(dim("no changes yet"));
    const before = stateAt(cb, head.parents[0]!);
    return printDiff(cb, diffNamespaces(before, now, irOf), before, now, `changes from \`${head.command}\``);
  }
  if (args.length === 1 && isHistoryRef(args[0]!) && !cb.store.hasBranch(args[0]!)) {
    const c = causalArg(cb, args[0]!);
    const before = stateAt(cb, c);
    const label = /@\d/.test(args[0]!) ? args[0]! : shortHash(c);
    return printDiff(cb, diffNamespaces(before, now, irOf), before, now, `changes since ${label}`);
  }
  const [from, to] = args.length === 1 ? [cb.store.branch().name, args[0]!] : [args[0]!, args[1]!];
  const side = (ref: string) => {
    if (cb.store.hasBranch(ref)) return stateOf(cb.store.names(ref));
    if (isHistoryRef(ref)) return stateAt(cb, causalArg(cb, ref));
    if (!cb.store.hasBranch(ref)) throw new UsageError(`no branch named '${ref}' (or history entry: a number or #hash, see \`tcm history\`)`);
    return stateOf(cb.store.names(ref));
  };
  const [before, after] = [side(from), side(to)];
  printDiff(cb, diffNamespaces(before, after, irOf), before, after, `${from} → ${to}`);
}

/** What changed between two states, name by name. */
function nameChanges(before: NameState, after: NameState): string[] {
  const out: string[] = [];
  const list = (hs: Set<string> | undefined) => [...(hs ?? [])].map((h) => shortHash(h)).join(", ");
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const [b, a] = [before.get(key), after.get(key)];
    if (b && a && b.size === a.size && [...b].every((h) => a.has(h))) continue;
    const change = !b ? green(`+ ${list(a)}`) : !a ? red(`- ${list(b)}`) : yellow(`${list(b)} → ${list(a)}`);
    out.push(`    ${keyPath(key).padEnd(28)} ${change}`);
  }
  return out;
}

/** This branch's history, newest first: each entry, the command that made it, and what it changed. */
function history(cb: Codebase, limit: number) {
  const entries = cb.store.causalLog(limit + 1);
  for (const [i, c] of entries.slice(0, limit).entries()) {
    if (!c.parents.length) break;
    const when = new Date(c.ts).toISOString().replace("T", " ").slice(0, 19);
    const merge = c.parents.length > 1 ? dim(`  merged ${c.parents.slice(1).map((p) => shortHash(p)).join(", ")}`) : "";
    console.log(`${yellow(shortHash(c.hash))} ${dim(String(i).padStart(3))}  ${dim(when)}  ${c.command}${merge}`);
    for (const line of nameChanges(stateAt(cb, c.parents[0]!), stateAt(cb, c.hash))) console.log(line);
  }
}

/** Bring back the names as of a history entry: a new entry on top, so history (pushed or not) is never rewritten. */
function reset(cb: Codebase, target: string) {
  const c = causalArg(cb, target);
  const { added, removed } = cb.store.setBranchNames(cb.store.branch().name, cb.store.namespaceRows(cb.store.causal(c)!.namespace), `reset ${shortHash(c)}`);
  cb.refreshShim();
  console.log(added || removed ? `names as of ${shortHash(c)} ${dim(`(${added} added, ${removed} removed)`)}` : dim(`already as of ${shortHash(c)}`));
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

/** Thrown to finish a command early with output already decided (help, the version). */
class Printed {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/**
 * A parsed command line, if it asks to run the command: help and the version are printed instead, and a line
 * the command doesn't accept is a usage error saying why.
 */
function execute<R extends { ok: boolean }>(cmd: string | undefined, r: R): Extract<R, { method: "execute" }> {
  const x = r as unknown as { ok: boolean; method?: string; path?: string[]; code: string; issues?: { message: string; path?: unknown[] }[] };
  const where = [...(cmd ? [cmd] : []), ...(x.path ?? [])];
  if (!x.ok) throw new UsageError(usageError(where, x));
  if (x.method === "help") throw new Printed(helpText(where));
  if (x.method === "version") throw new Printed(`tcm ${dim(`(hash format v${IR_VERSION}, TypeScript ${TS_VERSION})`)}`);
  return r as never;
}

const words = (literals: Iterable<{ text: string }>) => [...literals].map((l) => l.text);

function checkInto(into: string | undefined): string | undefined {
  if (into !== undefined && into !== "" && !IDENT_PATH.test(into)) throw new UsageError(`'${into}' is not a valid namespace`);
  return into;
}

export async function main(argv: string[]): Promise<number> {
  // code from the codebase that runs in this process (server functions under tcm dev, say) reports errors at
  // its definitions, not its generated modules
  process.setSourceMapsEnabled(true);
  try {
    return await dispatch(argv);
  } catch (e) {
    if (!(e instanceof Printed)) throw e;
    console.log(e.text);
    return 0;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const scratch = (f?: string) => path.resolve(cwd, f ?? "scratch.ts");
  // the test runner's child process (see vitest.ts), not a command anyone types
  if (argv[0] === "internal-vitest") return (await vitestChild(argv[1]!), 0);

  const word = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  if (word === "help") {
    const path = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (path[0] && !Object.hasOwn(commands, path[0])) throw new UsageError(unknownCommand(path[0]));
    throw new Printed(helpText(path));
  }
  if (word && !Object.hasOwn(commands, word)) throw new UsageError(unknownCommand(word));
  const cmd = word as keyof typeof commands | undefined;
  const rest = argv.slice(cmd ? 1 : 0);
  showInstallProgress();

  if (!cmd) {
    const { model } = execute(cmd, parse(root, { argv: rest }));
    watch(Codebase.find(cwd), checkInto(model.into), model.fresh);
    return -1; // keep running
  }
  if (cmd === "init") {
    execute(cmd, parse(commands.init, { argv: rest }));
    intro("tcm init");
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
    success(`initialized codebase in ${cb.lay.tcmDir}`);
    outro(`next: run \`tcm\` and edit scratch.ts${interactive() ? dim(" · `source <(tcm complete zsh)` completes commands and names") : ""}`);
    return 0;
  }
  // migrate opens codebases the version guard would refuse
  if (cmd === "migrate") {
    execute(cmd, parse(commands.migrate, { argv: rest }));
    return migrate(Codebase.findRoot(cwd)) ? 0 : 1;
  }
  // the editor says where the workspace is (initialize), so the codebase is found then
  if (cmd === "lsp") {
    execute(cmd, parse(commands.lsp, { argv: rest }));
    sendRunnerOutputToStderr();
    serveLsp((dir) => Codebase.find(dir), { classify, save: (cb, file, mode) => save(cb, file, mode), mv, edit, migrateTable });
    return -1; // serve until the editor says exit
  }
  // completing a word shouldn't open (or fail to find) the codebase
  if (cmd === "complete") {
    const r = execute(cmd, parse(commands.complete, { argv: rest }));
    const asked = words(r.literals);
    if (!r.model.shell && !rest.includes("--")) throw new UsageError("usage: tcm complete <zsh|bash|fish|powershell>, e.g. `source <(tcm complete zsh)` in ~/.zshrc");
    complete(r.model.shell, asked, cwd);
    return 0;
  }

  // help and usage errors don't need a codebase: check the line before looking for one (parsed again, typed,
  // by the command below)
  execute(cmd, (parse as (definition: unknown, input: { argv: string[] }) => { ok: boolean })(commands[cmd], { argv: rest }));
  const cb = Codebase.find(cwd);
  switch (cmd) {
    case "watch": {
      const { model } = execute(cmd, parse(commands.watch, { argv: rest }));
      watch(cb, checkInto(model.into), model.fresh);
      return -1; // keep running
    }
    case "check": {
      const { model } = execute(cmd, parse(commands.check, { argv: rest }));
      return check(cb, scratch(model.file), checkInto(model.into), model.fresh) ? 0 : 1;
    }
    case "add":
    case "update": {
      const { model } = execute(cmd, parse(commands[cmd], { argv: rest }));
      return save(cb, scratch(model.file), cmd, checkInto(model.into)) ? 0 : 1;
    }
    case "import": {
      const { model } = execute(cmd, parse(commands.import, { argv: rest }));
      return importProject(cb, model.dir, model.update ? "update" : "add", checkInto(model.into) ?? "", model.verbose, model.exclude) ? 0 : 1;
    }
    case "verify":
      execute(cmd, parse(commands.verify, { argv: rest }));
      return verify(cb) ? 0 : 1;
    case "dev": {
      const { model } = execute(cmd, parse(commands.dev, { argv: rest }));
      const app = model.app ?? (await chooseName(cb, "dev <app> [--port 5173]", "Which app?", "value"));
      await dev(cb, app, model.port, model.http === undefined ? undefined : parseHttpFlag(model.http));
      return -1; // keep serving
    }
    case "data": {
      const r = execute(cmd, parse(commands.data, { argv: rest }));
      if (r.route === "/migrate") return (await migrateTable(cb, r.model.table)) ? 0 : 1;
      data(cb, r.model.table, r.model.n);
      return 0;
    }
    case "jobs":
      return jobs(cb, execute(cmd, parse(commands.jobs, { argv: rest })));
    case "apps": {
      const r = execute(cmd, parse(commands.apps, { argv: rest }));
      if (r.route === "/prune") {
        pruneBuilds(cb, r.model.keep);
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
    case "build": {
      const { model } = execute(cmd, parse(commands.build, { argv: rest }));
      await build(cb, model.app ?? (await chooseName(cb, "build <app> [--force]", "Which app?", "value")), { force: model.force });
      return 0;
    }
    case "start": {
      const { model } = execute(cmd, parse(commands.start, { argv: rest }));
      const app = model.app ?? (await chooseName(cb, "start <app> [--port 8080]", "Which app?", "value"));
      const tls = model.tls || model["tls-cert"] ? tlsMaterial(cb, model["tls-cert"], model["tls-key"]) : undefined;
      await start(cb, app, { port: model.port, host: model.host, tls, keep: model.keep, http: model.http === undefined ? undefined : parseHttpFlag(model.http) });
      return -1; // keep serving
    }
    case "fmt": {
      const { model } = execute(cmd, parse(commands.fmt, { argv: rest }));
      const ns = model.namespace ?? "";
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
      const { model } = execute(cmd, parse(commands.lint, { argv: rest }));
      const ns = model.namespace ?? "";
      const live = cb.liveHashes();
      const targets = cb.store.names().filter((n) => n.kind !== "type" && live.has(n.hash) && (!ns || n.path === ns || n.path.startsWith(ns + ".")));
      const results = lintDefinitions(cb, targets, model.fresh);
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
      const { model } = execute(cmd, parse(commands.test, { argv: rest }));
      const ns = model.namespace ?? "";
      const names = cb.store.names().filter((n) => n.kind !== "type" && isTestPath(n.path) && (!ns || n.path === ns || n.path.startsWith(ns + ".")));
      if (!names.length) {
        console.log(dim(`no tests${ns ? ` under ${ns}` : ""} (tests are definitions named test… or under a \`tests\` namespace)`));
        return 0;
      }
      const outcomes = runCached(cb, names.map((n) => ({ path: n.path, rec: cb.store.getDef(n.hash)! })), cb.source(), model.fresh);
      printOutcomes(outcomes);
      console.log(`\n${summary(outcomes)}`);
      return outcomes.every((o) => o.result.ok) ? 0 : 1;
    }
    case "view": {
      const { model } = execute(cmd, parse(commands.view, { argv: rest }));
      view(cb, model.names.length ? model.names : [await chooseName(cb, "view <name|#hash>...", "Which definition?")]);
      return 0;
    }
    case "ls": {
      const { model } = execute(cmd, parse(commands.ls, { argv: rest }));
      ls(cb, model.namespace);
      return 0;
    }
    case "find": {
      const { model } = execute(cmd, parse(commands.find, { argv: rest }));
      find(cb, model.query.length ? model.query.join(" ") : await ask("find <query>", "Search for", "a name, or :<type> like :(xs: T[]) => T"));
      return 0;
    }
    case "deps":
    case "dependents":
    case "docs": {
      const { model } = execute(cmd, parse(commands[cmd], { argv: rest }));
      const name = model.name ?? (await chooseName(cb, `${cmd} <name>`, cmd === "docs" ? "Documentation for?" : cmd === "deps" ? "What uses what?" : "Who uses what?"));
      if (cmd === "deps") deps(cb, name);
      else if (cmd === "dependents") dependents(cb, name);
      else console.log(renderDoc(cb, cb.store.getDef(cb.lookupOne(name))!, { evaluate: true })?.markdown ?? dim("no documentation"));
      return 0;
    }
    case "run": {
      const r = execute(cmd, parse(commands.run, { argv: rest }));
      const name = r.model.name ?? (await chooseName(cb, "run <name> [args...] [--on <remote>]", "Run what?", "value"));
      const args = [...r.model.args, ...words(r.literals)];
      const h = cb.lookupOne(name, "value");
      if (cb.store.getDef(h)!.kind === "type") throw new UsageError(`${name} is a type`);
      if (r.model.on !== undefined) return runOn(cb, r.model.on, h, args);
      return run(h, args, cb.source(), cb.lay);
    }
    case "remote": {
      const r = execute(cmd, parse(commands.remote, { argv: rest }));
      if (r.route === "/add") {
        addRemote(cb, r.model.remote, r.model.url, r.model.token, r.model.fingerprint);
        console.log(`added remote ${r.model.remote}`);
      } else if (r.route === "/rm") {
        cb.store.deleteSetting(`remote.${r.model.remote}`);
        console.log(`removed remote ${r.model.remote}`);
      } else {
        const remotes = listRemotes(cb);
        if (!remotes.length) console.log(dim("no remotes; add one with `tcm remote add <name> <url|path>`"));
        for (const [n, c] of remotes) console.log(`${bold(n)}  ${c.url}${c.token ? dim("  (token)") : ""}`);
      }
      return 0;
    }
    case "push": {
      const { model } = execute(cmd, parse(commands.push, { argv: rest }));
      await push(cb, model.remote, model.as, model.force);
      return 0;
    }
    case "pull": {
      const { model } = execute(cmd, parse(commands.pull, { argv: rest }));
      await pull(cb, model.remote, model.branch);
      return 0;
    }
    case "contribute": {
      const { model } = execute(cmd, parse(commands.contribute, { argv: rest }));
      const title = model.title ?? (interactive() ? await ask("contribute [remote] --title <title>", "What's the change?", cb.store.branch().name) : undefined);
      const r = await contribute(cb, model.remote, { to: model.to, as: model.as, title, description: model.description, author: author() });
      console.log(`${green(r.created ? "opened" : "updated")} contribution ${bold(`#${r.id}`)} on ${model.remote}`);
      const url = reviewUrl(cb, model.remote, r.id);
      console.log(dim(`  review: tcm contribution view ${r.id}${url ? ` · ${url}` : ""}`));
      return 0;
    }
    case "contribution": {
      const r = execute(cmd, parse(commands.contribution, { argv: rest }));
      const { remote } = openRemote(cb, r.model.remote);
      if (r.route === "/") {
        printContributions(await remote.contributions(r.model.all), r.model.remote);
        const url = reviewUrl(cb, r.model.remote);
        if (url) console.log(dim(`\n  ${url}`));
        return 0;
      }
      const id =
        r.model.id ??
        (await choose(
          `contribution ${r.route.slice(1)} <id>`,
          "Which contribution?",
          (await remote.contributions(false)).map((c) => ({ value: c.id, label: `#${c.id} ${c.title}`, hint: `${c.source} → ${c.target}, ${c.author}` })),
          false,
        ));
      if (r.route === "/view") printContribution(await remote.contribution(id));
      else if (r.route === "/comment") {
        const body = r.model.text.length ? r.model.text.join(" ") : await ask(`contribution comment ${id} <text>`, "Comment");
        await remote.comment(id, { author: author(), body, about: r.model.about ?? null });
        console.log(`commented on #${id}`);
      } else if (r.route === "/merge") {
        const m = await remote.mergeContribution(id, author());
        console.log(`${green("merged")} #${id} on ${r.model.remote} as ${shortHash(m.mergedAs)}${m.todo ? yellow(` (${m.todo} definition(s) to fix there: tcm todo)`) : ""}`);
        console.log(dim(`  \`tcm pull ${r.model.remote}\` brings it here`));
      } else {
        await remote.closeContribution(id, author(), r.route === "/reopen");
        console.log(`${r.route === "/reopen" ? "reopened" : "closed"} #${id}`);
      }
      return 0;
    }
    case "serve": {
      const { model } = execute(cmd, parse(commands.serve, { argv: rest }));
      const token = model.token ?? process.env.TCM_TOKEN ?? newToken();
      const tls = model.tls || model["tls-cert"] ? tlsMaterial(cb, model["tls-cert"], model["tls-key"]) : undefined;
      // --insecure acknowledges clear-text tokens beyond localhost
      serve(cb, { host: model.host, port: model.port, token, allowRun: model.run, tls }, model.insecure);
      return -1; // keep running
    }
    case "edit": {
      const { model } = execute(cmd, parse(commands.edit, { argv: rest }));
      const names = model.names.length ? model.names : [await chooseName(cb, "edit <name>...", "Edit which definition?")];
      edit(cb, names, model.file !== undefined ? scratch(model.file) : (jsx) => scratch(jsx ? "scratch.tsx" : "scratch.ts"), model.force);
      return 0;
    }
    case "mv": {
      const { model } = execute(cmd, parse(commands.mv, { argv: rest }));
      const from = model.from ?? (await chooseName(cb, "mv <from> <to>", "Rename what?"));
      mv(cb, from, model.to ?? (await ask("mv <from> <to>", `Rename ${from} to`, from)));
      return 0;
    }
    case "alias": {
      const { model } = execute(cmd, parse(commands.alias, { argv: rest }));
      const name = model.name ?? (await chooseName(cb, "alias <name> <new>", "Add a name for?"));
      alias(cb, name, model.to ?? (await ask("alias <name> <new>", `Another name for ${name}`, name)));
      return 0;
    }
    case "rm": {
      const { model } = execute(cmd, parse(commands.rm, { argv: rest }));
      await rm(cb, model.name ?? (await chooseName(cb, "rm <name> [--force]", "Remove which name?")), model.force);
      return 0;
    }
    case "todo":
      execute(cmd, parse(commands.todo, { argv: rest }));
      todo(cb);
      return 0;
    case "packages":
      execute(cmd, parse(commands.packages, { argv: rest }));
      listPackages(cb);
      return 0;
    case "upgrade": {
      const { model } = execute(cmd, parse(commands.upgrade, { argv: rest }));
      const spec =
        model.package ??
        (await choose(
          "upgrade <package>[@range|@latest] [namespace] [--force]",
          "Upgrade which package?",
          [...new Map(cb.store.lockedPackages().filter((l) => !l.name.startsWith("@types/")).map((l) => [l.name, l])).values()].map((l) => ({ value: l.name, label: l.name, hint: `${l.range} → ${l.version}` })),
        ));
      const at = spec.lastIndexOf("@");
      const [name, target] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
      const ok = target ? upgradeTo(cb, name, target, model.namespace) : upgradeWithin(cb, name, model.force);
      if (ok) cb.refreshShim();
      return ok ? 0 : 1;
    }
    case "release": {
      const r = execute(cmd, parse(commands.release, { argv: rest }));
      if (r.route === "/view") {
        const spec = r.model.release ?? (await choose("release view <package>@<version>", "Which release?", cb.store.releases().map((x) => ({ value: `${x.package}@${x.version}`, label: `${x.package}@${x.version}`, hint: when(x.ts) })), false));
        const rel = releaseAt(cb, spec);
        console.log(rel.notes.replace(`${MARKER}\n\n`, "").trimEnd());
        return 0;
      }
      if (r.route === "/check") {
        printCheck(planRelease(cb, r.model.package, undefined, true));
        return 0;
      }
      const m = r.model;
      const { name, version } = releaseSpec(m.package);
      if (m.draft) {
        const plan = planRelease(cb, name, version, m.force);
        const file = writeDraft(cb, plan, generatedNotes(cb, plan, [...cb.store.contributions(), ...(await contributionsOn(cb, m.remote))]));
        console.log(`wrote ${path.relative(cwd, file)} (${plan.pkg.name}'s next release, ${plan.version} as things stand): write what it's about above the marker, then \`tcm release ${plan.pkg.name}\`; the changes below the marker are regenerated`);
        return 0;
      }
      const { release: rel, plan } = await releasePackage(cb, { name, version, notesFile: m.notes === undefined ? undefined : path.resolve(cwd, m.notes), remote: m.remote, force: m.force, author: author() });
      console.log(`${green("released")} ${bold(`${rel.package}@${rel.version}`)} ${dim(`as ${shortHash(rel.causal)}${plan.prev ? `, after ${plan.prev.version}` : ""}: ${reasonFor(plan)}`)}\n`);
      console.log(rel.notes.replace(`${MARKER}\n\n`, "").trimEnd());
      if (listRemotes(cb).length) console.log(dim(`\n  \`tcm push\` publishes it`));
      return 0;
    }
    case "releases": {
      const { model } = execute(cmd, parse(commands.releases, { argv: rest }));
      const pkgs = packagesIn(cb, cb.store.names());
      const names = model.package ? [model.package] : [...new Set([...pkgs.map((p) => p.name), ...cb.store.releases().map((x) => x.package)])].sort();
      if (!names.length) console.log(dim("no packages yet (a definition named `manifest` makes its namespace one)"));
      for (const n of names) {
        const pkg = pkgs.find((p) => p.name === n);
        const all = cb.store.releases(n);
        console.log(`${bold(n)}${pkg ? dim(`  ${pkg.namespace || "(the codebase)"}`) : dim("  (no longer in this branch)")}`);
        if (!all.length) console.log(dim("  no releases yet"));
        for (const x of all) {
          const summary = writtenPart(x.notes).split("\n").find((l) => l.trim() && !l.startsWith("<!--")) ?? "";
          console.log(`  ${x.version.padEnd(10)} ${dim(`${when(x.ts)}  ${shortHash(x.causal)}  ${x.author}`)}  ${summary}`);
        }
      }
      return 0;
    }
    case "changelog": {
      const { model } = execute(cmd, parse(commands.changelog, { argv: rest }));
      const name = model.package ?? findPackage(packagesIn(cb, cb.store.names()), undefined).name;
      const text = changelog(cb, name);
      if (model.out === undefined) process.stdout.write(text);
      else {
        fs.writeFileSync(path.resolve(cwd, model.out), text);
        console.log(`wrote ${model.out} ${dim(`(${cb.store.releases(name).length} release(s) of ${name})`)}`);
      }
      return 0;
    }
    case "pack": {
      const { model } = execute(cmd, parse(commands.pack, { argv: rest }));
      // a package of the codebase, from its manifest
      if (model.name === undefined && !model.bin.length && model.entries.length <= 1) {
        const spec = model.entries[0] === undefined ? undefined : parseSpec(model.entries[0]);
        const r = packPackage(cb, spec?.name, spec?.version, model.out);
        const deps = Object.keys(r.dependencies);
        const shown = path.relative(cwd, r.dir);
        console.log(`packed ${r.pkg.name}@${r.version} into ${shown.startsWith("..") ? r.dir : shown || "."}: ${r.modules} module(s)${deps.length ? `, depends on ${deps.join(", ")}` : ""}`);
        return 0;
      }

      if (!model.entries.length && !model.bin.length) throw new UsageError("usage: tcm pack [[subpath=]<namespace|name>...] --name <pkg>[@version] [--bin cmd=<name>]");
      const spec = model.name ?? (await ask("pack [[subpath=]<namespace|name>...] --name <pkg>[@version]", "Package name (and version: name@1.0.0)", "my-package"));
      const at = spec.lastIndexOf("@");
      const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "0.0.0"];
      const pair = (s: string, what: string) => {
        const eq = s.indexOf("=");
        if (what === "bin" && eq < 0) throw new UsageError(`--bin wants cmd=<name>, not '${s}'`);
        return eq < 0 ? ["", s] : [s.slice(0, eq), s.slice(eq + 1)];
      };
      const r = pack(cb, {
        name,
        version,
        description: model.description,
        entries: model.entries.map((a) => pair(a, "entry")).map(([subpath, target]) => ({ subpath: subpath ? subpath.replace(/^\.\//, "") : ".", target: target! })),
        bins: model.bin.map((b) => pair(b, "bin")).map(([command, target]) => ({ command: command!, target: target! })),
        with: model.with,
        files: model.files,
        out: model.out ?? path.join(".tcm", "pack", name.replace(/^@/, "").replace("/", "__")),
      });
      const deps = Object.keys(r.dependencies);
      const shown = path.relative(cwd, r.dir);
      console.log(`packed ${name}@${version} into ${shown.startsWith("..") ? r.dir : shown || "."}: ${r.modules} module(s)${deps.length ? `, depends on ${deps.join(", ")}` : ""}`);
      return 0;
    }
    case "diff": {
      const { model } = execute(cmd, parse(commands.diff, { argv: rest }));
      diff(cb, model.refs);
      return 0;
    }
    case "resolve": {
      const { model } = execute(cmd, parse(commands.resolve, { argv: rest }));
      const conflicted = [...new Set(cb.store.names().map((n) => n.path))].filter((p) => cb.store.hashesAt(p).length > 1);
      const name = model.name ?? (await choose("resolve <name> <#hash>", "Which conflict?", conflicted.map((p) => ({ value: p, label: p, hint: `${cb.store.hashesAt(p).length} definitions` }))));
      const keep =
        model.hash ??
        (await choose(
          "resolve <name> <#hash>",
          `Keep which ${name}?`,
          cb.store.hashesAt(name).map((h) => ({ value: `#${h}`, label: `#${shortHash(h)}`, hint: cb.store.getDef(h)?.signature })),
          false,
        ));
      resolveConflict(cb, name, keep);
      return 0;
    }
    case "history": {
      const { model } = execute(cmd, parse(commands.history, { argv: rest }));
      history(cb, model.n);
      return 0;
    }
    case "reset": {
      const { model } = execute(cmd, parse(commands.reset, { argv: rest }));
      reset(cb, model.to ?? (await chooseReset(cb)));
      return 0;
    }
    case "branch": {
      const { model } = execute(cmd, parse(commands.branch, { argv: rest }));
      if (!model.branch) {
        for (const b of cb.store.branches()) console.log(`${b === cb.store.branch().name ? green("* ") : "  "}${b}`);
        return 0;
      }
      cb.store.createBranch(model.branch);
      console.log(`created branch ${model.branch} from ${cb.store.branch().name}`);
      return 0;
    }
    case "merge":
    case "switch": {
      const { model } = execute(cmd, parse(commands[cmd], { argv: rest }));
      const others = cb.store.branches().filter((b) => b !== cb.store.branch().name);
      const branch = model.branch ?? (await choose(`${cmd} <branch>`, cmd === "merge" ? "Merge which branch?" : "Switch to?", others.map((b) => ({ value: b, label: b }))));
      if (cmd === "merge") return mergeBranch(cb, branch).conflicts.length ? 1 : 0;
      cb.store.switchBranch(branch);
      cb.refreshShim(true);
      console.log(`on branch ${branch}`);
      return 0;
    }
  }
}

/** What `tcm release` was given: `<package>[@version]`, or (with one package) `@version`, a bare version, or nothing. */
function releaseSpec(arg: string | undefined): { name?: string; version?: string } {
  if (arg === undefined) return {};
  if (/^v?\d+\.\d+\.\d+/.test(arg)) return { version: arg.replace(/^v/, "") };
  if (/^@v?\d/.test(arg)) return { version: arg.slice(1).replace(/^v/, "") };
  return parseSpec(arg);
}

/** A release: `<package>@<version>`, or `@<version>` when the codebase has one package. */
function releaseAt(cb: Codebase, spec: string) {
  const { name, version } = releaseSpec(spec);
  const pkg = name ?? findPackage(packagesIn(cb, cb.store.names()), undefined).name;
  if (!version) throw new UsageError(`which release of ${pkg}? (${pkg}@<version>; see \`tcm releases\`)`);
  const rel = cb.store.release(pkg, version);
  if (!rel) throw new UsageError(`no release ${pkg}@${version} (see \`tcm releases\`)`);
  return rel;
}

/** `tcm release check`: the next version, and every finding behind it. */
function printCheck(plan: Plan) {
  if (!plan.prev) return console.log(`${plan.pkg.name}'s first release: ${bold(plan.computed)} ${dim(`(${plan.now.exported.size} definition(s))`)}`);
  const findings = plan.report!.findings;
  const level = plan.level ? { major: red("breaking changes"), minor: yellow("additions"), patch: "changes with the same API" }[plan.level] : dim("no API changes");
  console.log(`${plan.pkg.name}'s next release: ${bold(plan.computed)} ${dim(`(after ${plan.prev.version})`)}: ${level}`);
  const tone = { major: red, minor: yellow, patch: dim };
  for (const f of findings) {
    const l = LINTS[f.lint];
    console.log(`\n  ${tone[l.level](l.level.padEnd(5))}  ${bold(f.path)} ${l.summary}${f.detail ? `: ${f.detail}` : ""}`);
    console.log(dim(`         ${f.lint}: ${l.why}`));
  }
  if (plan.report!.following.length) console.log(dim(`\n  and ${plan.report!.following.length} definition(s) that follow those changes (${plan.report!.following.slice(0, 5).join(", ")}${plan.report!.following.length > 5 ? ", …" : ""})`));
}

const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16);

function unknownCommand(word: string): string {
  const close = suggest(word);
  return `unknown command '${word}'${close.length ? `; did you mean ${close.map((c) => `\`tcm ${c}\``).join(" or ")}?` : ""}\n${dim("see `tcm help`")}`;
}

/** `tcm reset` with no entry: which command to undo (it, and everything after it). */
function chooseReset(cb: Codebase): Promise<string> {
  const entries = cb.store.causalLog(100).filter((c) => c.parents.length);
  if (!entries.length) throw new UsageError("nothing to undo on this branch");
  return choose(
    "reset <n|#hash>",
    "Undo back to before which command? (it, and everything after it)",
    entries.map((c) => ({ value: `#${c.parents[0]!}`, label: `tcm ${c.command}`, hint: `${shortHash(c.hash)}, ${new Date(c.ts).toISOString().replace("T", " ").slice(0, 16)}` })),
    false,
  );
}

function jobs(cb: Codebase, r: Extract<ReturnType<typeof parse<typeof commands.jobs>>, { method: "execute" }>): number {
  const file = path.join(cb.lay.tcmDir, "data", "jobs.sqlite");
  if (!fs.existsSync(file)) return (console.log(dim("no jobs yet (enqueue() from a server function, or every() for recurring ones)")), 0);
  const db = new DatabaseSync(file);
  try {
    const find = (prefix: string) => {
      const rows = db.prepare("SELECT id FROM jobs WHERE id LIKE ?").all(`${prefix}%`) as { id: string }[];
      if (rows.length !== 1) throw new UsageError(rows.length ? `'${prefix}' matches ${rows.length} jobs` : `no job '${prefix}'`);
      return rows[0]!.id;
    };
    if (r.route === "/retry") {
      db.prepare("UPDATE jobs SET status = 'queued', run_at = ?, attempts = 0, last_error = NULL, finished = NULL WHERE id = ?").run(Date.now(), find(r.model.id));
      return (console.log("queued again"), 0);
    }
    if (r.route === "/cancel") {
      const c = db.prepare("UPDATE jobs SET status = 'cancelled', finished = ? WHERE id = ? AND status = 'queued'").run(Date.now(), find(r.model.id));
      return (console.log(c.changes ? "cancelled" : dim("not queued (already running or finished)")), 0);
    }
    const rows = db.prepare("SELECT * FROM jobs ORDER BY created DESC LIMIT ?").all(r.model.n) as Record<string, string | number | null>[];
    const colour: Record<string, (s: string) => string> = { done: green, failed: red, queued: yellow, running: cyan, cancelled: dim };
    for (const row of rows) {
      const when = new Date(Number(row.status === "queued" ? row.run_at : (row.finished ?? row.run_at))).toISOString().replace("T", " ").slice(0, 19);
      // a finished job's last error is history; a failed or retrying one's is the news
      const err = row.last_error && row.status !== "done" ? dim(`  ${String(row.last_error).split("\n")[0]}`) : "";
      console.log(`${dim(String(row.id).slice(0, 8))}  ${(colour[String(row.status)] ?? dim)(String(row.status).padEnd(9))} ${String(row.fn_name).padEnd(24)} ${dim(`${row.attempts}/${row.max_attempts}  ${when}`)}${err}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** Process entry point: run a command, report errors, set the exit code. */
export async function runCli(...argv: string[]): Promise<void> {
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
