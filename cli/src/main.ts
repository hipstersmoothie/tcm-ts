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
import { serveLsp } from "./lsp.ts";
import { searchByType } from "./search.ts";
import { checkDocExamples, renderDoc } from "./docs.ts";
import { build, dev, listBuilds, migrateTable, parseHttpFlag, pruneBuilds, start } from "./web.ts";
import { Placement } from "./placement.ts";
import { mergeBranch } from "./merge.ts";
import { serveMcp } from "./mcp.ts";
import { checkMirror, joinName, linkMirror, loadMirror, namespaceForFile, recordRelease, releaseCommit, replayReleases, sourceFiles, unlinkMirror } from "./mirror.ts";
import { evaluateCached, isTestPath, printOutcomes, runCached, summary } from "./testing.ts";
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
import { syncMirror } from "./mirror.ts";
import type { Mirror } from "./mirror.ts";
import { changedFiles } from "./mirror.ts";
import { runSuites, suitesIn } from "./suites.ts";
import { isNamespaceImport as ts_isNamespaceImport, isImportDeclaration as ts_isImportDeclaration, isStringLiteral as ts_isStringLiteral } from "typescript/ast";
import { parse as parse_1, isTypeOnlyImport } from "../../core/src/ts.ts";
import { declarations } from "./mirror.ts";
import { commandsIn } from "./suites.ts";
import { isTypeAliasDeclaration as ts_isTypeAliasDeclaration, isInterfaceDeclaration as ts_isInterfaceDeclaration, isClassDeclaration as ts_isClassDeclaration, isFunctionDeclaration as ts_isFunctionDeclaration, isIdentifier as ts_isIdentifier, isVariableStatement as ts_isVariableStatement } from "typescript/ast";
import { scratchNamespace } from "@tcm/core";
import { fileFormat, followMove, linkingTo, fileContent, formatOf, fileDefinition, fileLeaf, isBytes } from "./files.ts";
import { exportFiles } from "./files.ts";
import { assetName, assetFiles } from "./mirror.ts";
import { assetFormat } from "./mirror.ts";
import { FILE_PATH } from "./files.ts";
import { onMirrorBranch } from "./mirror.ts";
import { sessionDirFor } from "./codebase.ts";
import { fileName } from "./files.ts";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { groupImports } from "@tcm/loader";
import { isNamedImports } from "typescript/ast";
import type { ImportDeclaration } from "typescript/ast";
import { pruneImports } from "./mirror.ts";
import { lineDiff } from "./diff.ts";
import { hashesOfViewFile, srcDir } from "./views.ts";
import { superviseMcp, registerMcpServer, liveMcpServers } from "./mcp.ts";


// ---- scratch files: check / add / update ----------------------------------------------------------

type Status = "new" | "identical" | "update" | "alias" | "conflict" | "doc";

interface Row {
  def: DefRecord;
  path: string;
  status: Status;
  note?: string;
}


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
  // what's identical says nothing new: more than a few are one line
  const same = rows.filter((r) => r.status === "identical");
  const quiet = same.length > 3;
  for (const r of rows) {
    if (quiet && r.status === "identical") continue;
    // a report line per definition: a type too long for one is cut (`tcm view` has all of it)
    const sig = dim(cutSignature(r.def.kind === "type" ? r.def.signature : `: ${r.def.signature}`));
    console.log(`${STATUS_LABEL[r.status]} ${bold(r.path)} ${sig}${r.note ? dim(`  (${r.note})`) : ""}`);
  }
  if (quiet) console.log(dim(`  = identical ${same.length}: ${listed(same.map((r) => r.path), 4)}`));
}

function analyzeScratch(cb: Codebase, file: string, into?: string, text?: string) {
  cb.refreshShim();
  const a = cb.analyze(file, cb.scratchSalts(into), [], text === undefined ? undefined : new Map([[file, text]]));
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
  if (fileFormat(file)) {
    const rows = fileRows(cb, file, into);
    if (!rows) return false;
    console.log(bold(path.basename(file)));
    printRows(rows);
    const pending = rows.filter((r) => r.status !== "identical");
    if (pending.length) console.log(dim(`\n  run \`tcm ${pending.some((r) => r.status === "update" || r.status === "conflict") ? "update" : "add"} ${path.relative(process.cwd(), file)}\` to save it`));
    return true;
  }
  const whole = withTheirCycles(cb, file, into);
  if (!whole) return false;
  const { a, rows } = whole;
  console.log(`${bold(path.basename(file))}${a.namespace || into ? dim(` → ${into ?? a.namespace}`) : ""}`);
  if (rows.length) printRows(rows);
  else if (!a.watches.length) console.log(dim("  (no definitions)"));
  printScratchLint(cb, file, a.defs.length ? changedCode(cb, rows) : undefined);
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
  // a file kept as written (Markdown, CSS, an image) is a definition of its own
  if (fileFormat(file)) {
    const rows = fileRows(cb, file, into);
    return !!rows && apply(cb, rows, mode, `${mode} ${path.basename(file)}`, false);
  }
  const whole = withTheirCycles(cb, file, into);
  if (!whole) return false;
  const { a, rows } = whole;
  // lint what's being saved: warnings are shown, errors (rules set to "error" in lint.config) stop the save
  const saving = changedCode(cb, rows);
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
  // a mirrored codebase's code reads as its files do: their style is the project's, not the formatter's
  if (loadMirror(cb)) return rows;
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
    const { updated, failed } = cb.propagate(patches);
    printDependents(updated);
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

function importProject(cb: Codebase, dir: string, mode: "add" | "update", into: string, verbose: boolean, exclude: string[], tests: boolean, mirror: boolean): boolean {
  const root = path.resolve(dir);
  // importing the mirrored directory again (its files changed outside tcm) follows the files, and re-links it
  // rather than writing back to it
  const linked = loadMirror(cb);
  const following = !mirror && linked?.dir === root ? linked : undefined;
  const relink = mirror || !!following;
  if (relink) cb.syncsMirror = false;
  let ok = false;
  try {
    // linking a mirror into a codebase: its releases, kept with its files in git, are made again first
    let made = 0;
    if (mirror) {
      made = replayReleases(
        cb,
        root,
        (at, label) => !!importFiles(cb, at, label, "update", into, false, exclude, tests),
        (pkg) => packagesIn(cb, cb.store.names()).find((p) => p.name === pkg)?.namespace,
      );
      if (made) console.log(dim(`made ${made} release${made > 1 ? "s" : ""} again from git`));
    }
    // after the releases, the files as they are now are an update of the last one
    const held = importFiles(cb, root, dir, made ? "update" : mode, into, verbose, exclude, tests, following);
    ok = !!held;
    if (held && relink) {
      linkMirror(cb, root, into, tests, exclude, following && { log: following.log, held });
      if (mirror) console.log(dim(`mirror: changes made in tcm under ${into || "the root namespace"} are written back to ${dir}`));
    }
  } finally {
    cb.syncsMirror = true;
  }
  // what the codebase changed while the files did (write-back waited for them) is written to them now
  if (ok && following) syncMirror(cb);
  return ok;
}

/**
 * Import the files under `root`: the hash of each definition's code in them, by path, or undefined if they don't
 * import. Following a mirror's files, a definition they haven't changed since tcm last saw them stays as the
 * codebase has it (it may have changed it while write-back waited), and one gone from the files goes from the
 * codebase.
 */
function importFiles(cb: Codebase, root: string, dir: string, mode: "add" | "update", into: string, verbose: boolean, exclude: string[], tests: boolean, following?: Mirror): Map<string, string> | undefined {
  const files = sourceFiles(root, new Set(exclude.map((e) => path.resolve(root, e))), tests);
  if (!files.length) throw new UsageError(`no .ts files under ${dir}`);
  // (files that aren't code come after it: a page's links to code need the code)
  const done = (held: Map<string, string> | undefined) => {
    const assets = held && importAssets(cb, root, dir, mode, into, verbose, exclude, following);
    return held && assets && new Map([...held, ...assets]);
  };
  console.log(dim(`analyzing ${files.length} files under ${dir}…`));
  cb.refreshShim();
  const a = cb.analyzeProject(files, (file, name) => cb.lineageSalt(joinName(into, namespaceForFile(root, file), name)), [], cb.compilerOptions(root, "import"));
  for (const w of a.warnings) console.log(yellow(`warning: ${w}`));
  if (a.diagnostics.length || a.errors.length) {
    for (const d of a.diagnostics) process.stdout.write(d.formatted);
    for (const e of a.errors) console.log(red(e));
    console.log(red(`\n${a.errors.length + a.diagnostics.length} problem(s); nothing was imported.`));
    return undefined;
  }
  const planned = a.defs.map((def) => ({ def, path: joinName(into, namespaceForFile(root, def.file), def.nameHint) }));
  checkDistinct(planned, (p) => `${p.path} is defined in more than one file (one of them is ${p.def.file})`);
  cb.lockPackages(a.packages);
  const held = new Map(planned.map((p) => [p.path, p.def.hash]));
  if (!following) return done(apply(cb, classifyPaths(cb, planned), mode, `import ${dir}`, !verbose) ? held : undefined);
  const was = new Map<string, string>();
  for (const f of Object.values(following.files)) for (const [leaf, h] of Object.entries(f.names)) was.set(joinName(f.ns, leaf), h);
  const changed = planned.filter((p) => was.get(p.path) !== p.def.hash);
  for (const p of changed) {
    const w = was.get(p.path);
    if (w && !cb.store.hashesAt(p.path, p.def.kind).includes(w)) console.log(yellow(`  ! ${p.path} changed in the files and in the codebase; the files' change is kept`));
  }
  const gone = [...was].filter(([p, h]) => !held.has(p) && cb.store.getDef(h)?.kind !== "file" && cb.store.hashesAt(p).includes(h));
  if (!changed.length && !gone.length) console.log(dim("nothing to do"));
  const ok = !changed.length || apply(cb, classifyPaths(cb, changed), mode, `import ${dir}`, !verbose);
  for (const [p, h] of gone) {
    cb.store.removeName(p, h, `import ${dir}`);
    console.log(`${red("  - removed  ")} ${bold(p)} ${dim("(gone from the files)")}`);
  }
  return done(ok ? held : undefined);
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
  const line = `${dim("//")} ${bold(names.join(", ") || "(unnamed)")} ${dim(shortHash(hash))} ${dim(cutSignature(rec.kind === "type" ? rec.signature : ": " + rec.signature))}`;
  if (rec.kind === "type") return line;
  const placement = new Placement(cb);
  return `${line}
${dim(`// ${placement.describe(hash)}`)}`;
}

function view(cb: Codebase, targets: string[]) {
  for (const t of targets) {
    for (const h of cb.lookup(t).length ? cb.lookup(t) : [cb.lookupOne(t)]) {
      const rec = cb.store.getDef(h)!;
      if (rec.kind === "file") {
        const format = formatOf(rec);
        const name = cb.store.pathsOf(h)[0] ?? t;
        console.log(`${dim("//")} ${bold(cb.store.pathsOf(h).join(", ") || "(unnamed)")} ${dim(shortHash(h))} ${dim(format)}`);
        const content = fileContent(cb, rec, name.slice(0, Math.max(0, name.lastIndexOf("."))));
        console.log(isBytes(rec) ? dim(`(${format || "bytes"}, ${content.length} bytes)`) : content.toString("utf8"));
        continue;
      }
      console.log(header(cb, h));
      process.stdout.write(render([rec], cb.source(), cb.lay, { style: "scratch", exportDeclarations: true }).text);
      console.log();
    }
  }
}

function ls(cb: Codebase, ns = "") {
  const rows = cb.store.names(undefined, true).filter((n) => !ns || n.path === ns || n.path.startsWith(ns + "."));
  if (!rows.length) return console.log(dim(ns ? `nothing under ${ns}` : "the codebase is empty"));
  const width = Math.max(...rows.map((r) => r.path.length));
  const kindsAt = new Map<string, DefKind[]>();
  for (const r of rows) kindsAt.set(r.path, [...(kindsAt.get(r.path) ?? []), r.kind]);
  for (const r of rows) {
    const rec = cb.store.getDef(r.hash)!;
    const sig = cutSignature(rec.kind === "type" ? rec.signature : `: ${rec.signature}`, Math.max(40, SIGNATURE_WIDTH - width));
    // conflicted only with definitions in its own space: a type isn't part of a clash between two values
    const conflict = kindsAt.get(r.path)!.filter((k) => sameSpace(k, r.kind)).length > 1 ? red(" (conflicted)") : "";
    console.log(`${r.path.padEnd(width)}  ${dim(shortHash(r.hash))}  ${dim(sig)}${conflict}`);
  }
}

function find(cb: Codebase, query: string) {
  if (query.trim().startsWith(":")) return findByType(cb, query.trim().slice(1));
  const q = query.trim().toLowerCase();
  const hits = cb.store.names(undefined, true).filter((n) => n.path.toLowerCase().includes(q) || cb.store.getDef(n.hash)!.signature.toLowerCase().includes(q));
  if (!hits.length) return console.log(dim("no matches"));
  for (const n of hits) console.log(`${bold(n.path)}  ${dim(shortHash(n.hash))}  ${dim(cutSignature(cb.store.getDef(n.hash)!.signature, Math.max(40, SIGNATURE_WIDTH - n.path.length)))}`);
}

/** `tcm find ':<type>'`: terms whose type has that shape (see search.ts). */
function findByType(cb: Codebase, text: string) {
  const r = searchByType(cb, text);
  if (r.variables.length) console.log(dim(`type variables: ${r.variables.join(", ")}`));
  if (!r.hits.length) return console.log(dim("no matches"));
  for (const h of r.hits) console.log(`${bold(h.path)}  ${dim(shortHash(h.hash))}  ${dim(cutSignature(h.signature, Math.max(40, SIGNATURE_WIDTH - h.path.length)))}${h.cost ? `  ${yellow(h.notes.join(", "))}` : ""}`);
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
  for (const r of cb.store.names(undefined, true)) counts.set(r.path, [...(counts.get(r.path) ?? []), r]);
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
  // files kept as written are edited as the files they are
  if (targets.some((t) => (t.startsWith("#") ? [cb.lookupOne(t)] : cb.lookup(t)).some((h) => cb.store.getDef(h)?.kind === "file"))) {
    return editFiles(cb, targets, typeof target === "string" ? target : undefined, force);
  }
  // JSX only parses in a .tsx file: the default scratch file follows what's being edited
  const jsx = targets.some((t) => (t.startsWith("#") ? [cb.lookupOne(t)] : cb.lookup(t)).some((h) => cb.store.getDef(h)?.jsx));
  const work = (f: string) => fs.existsSync(f) && !!fs.readFileSync(f, "utf8").trim();
  // (a .tsx scratch file holding work takes code without JSX too: one file for all of it)
  const file = typeof target === "string" ? target : !jsx && work(target(true)) && !work(target(false)) ? target(true) : target(jsx);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  // a scratch file holding work keeps it, and what's edited now is added to it; one holding only what's saved has
  // nothing to lose, and starts again (as --force does)
  const adding = !!existing.trim() && !force && !holdsOnlySaved(cb, file);
  const fileNs = adding ? (/^\/\/ tcm: namespace (\S+)/m.exec(existing)?.[1] ?? "") : "";
  // what's in it saved as it is goes: the file holds what's being worked on
  const { text: kept, cleared } = adding ? clearSaved(cb, file, existing) : { text: existing, cleared: [] as string[] };
  const pathOf = new Map<string, string | undefined>();
  for (const t of targets) {
    // a name holding a type and a value edits both
    const hs = t.startsWith("#") ? [cb.lookupOne(t)] : cb.lookup(t);
    if (!hs.length) throw new UsageError(`'${t}' not found`);
    for (const h of hs) if (!pathOf.has(h)) pathOf.set(h, t.startsWith("#") ? cb.store.pathsOf(h)[0] : t);
  }
  // definitions that refer to each other are hashed as one: saving changes to some saves the rest with them, as
  // they are, so the file holds only what was asked for
  const cycle = new Set<string>();
  for (const h of pathOf.keys()) {
    for (const m of cb.store.componentMembers(cb.store.getDef(h)!.componentHash)) {
      const p = cb.store.pathsOf(m.hash)[0];
      if (!pathOf.has(m.hash) && p) cycle.add(p);
    }
  }
  const nsOf = (p: string) => (p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "");
  // already in the file it's added to: there once is enough
  const inFile = (p: string) => {
    const leaf = p.slice(p.lastIndexOf(".") + 1).replaceAll("$", "\\$");
    const declared = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:const|let|var|function\\*?|class|type|interface)\\s+${leaf}\\b`, "m");
    return kept.includes(`// tcm: path ${p}\n`) || (nsOf(p) === fileNs && declared.test(kept));
  };
  if (adding) for (const [h, p] of pathOf) if (p !== undefined && inFile(p)) pathOf.delete(h);
  if (!pathOf.size) {
    console.log(`${targets.join(", ")} ${targets.length > 1 ? "are" : "is"} in ${path.relative(process.cwd(), file)} already`);
    return;
  }
  const nss = new Set([...pathOf.values()].filter((p) => p !== undefined).map(nsOf));
  // (added to a file, the definitions say where they go unless it's the file's namespace)
  const ns = adding ? fileNs : nss.size === 1 ? [...nss][0]! : "";
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
  if (adding) {
    fs.writeFileSync(file, addToScratch(file, kept, text));
    console.log(`added ${targets.join(", ")} to ${path.relative(process.cwd(), file)}${cleared.length ? dim(` (took out ${cleared.join(", ")}: saved as ${cleared.length > 1 ? "they are" : "it is"})`) : ""}`);
  } else {
    fs.writeFileSync(file, (ns ? `// tcm: namespace ${ns}\n` : "") + text);
    // (where it is from here: a session's is in its own directory)
    console.log(`wrote ${targets.join(", ")} to ${path.relative(process.cwd(), file)}`);
  }
  if (cycle.size) {
    const them = [...cycle];
    console.log(dim(`  in a cycle with ${them.slice(0, 5).join(", ")}${them.length > 5 ? `, and ${them.length - 5} more` : ""}: saving ${targets.length > 1 ? "them" : "it"} saves ${them.length > 1 ? "those" : "that"} too, as ${them.length > 1 ? "they are" : "it is"} (\`tcm edit\` ${them.length > 1 ? "them" : "it"} to change ${them.length > 1 ? "them" : "it"} too)`));
  }
}

// ---- names --------------------------------------------------------------------------------------------

function mv(cb: Codebase, from: string, to: string) {
  const exact = cb.store.names(undefined, true).filter((n) => n.path === from);
  const moves = exact.length ? exact.map((n) => ({ ...n, dest: to })) : cb.store.names(undefined, true).filter((n) => n.path.startsWith(from + ".")).map((n) => ({ ...n, dest: to + n.path.slice(from.length) }));
  if (!moves.length) throw new UsageError(`'${from}' not found`);
  // (a file's own name, like `getting-started`, may have dashes)
  for (const m of moves) if (!(m.kind === "file" ? FILE_PATH : IDENT_PATH).test(m.dest)) throw new UsageError(`'${m.dest}' is not a valid name`);
  for (const m of moves) if (cb.store.hashesAt(m.dest).length) throw new UsageError(`'${m.dest}' already exists`);
  cb.store.transaction(() => {
    for (const m of moves) {
      cb.store.removeName(m.path, m.hash, `mv ${from} ${to}`);
      cb.store.addName(m.dest, m.hash, m.kind, `mv ${from} ${to}`);
    }
  });
  // pages linking to a file that moved link to where it is now (and one that moved links from there)
  for (const m of moves.filter((x) => x.kind === "file")) {
    const relinked = followMove(cb, m.path, m.dest);
    cb.putDefs([...relinked.values()]);
    cb.store.transaction(() => {
      for (const [page, rec] of relinked) for (const old of cb.store.hashesAt(page)) cb.store.replaceName(page, old, rec.hash, "file", `mv ${from} ${to} (links)`);
    });
    if (relinked.size) console.log(dim(`  links to it changed in ${[...relinked.keys()].join(", ")}`));
  }
  cb.refreshShim();
  console.log(`moved ${moves.length} name${moves.length > 1 ? "s" : ""}`);
  const mirror = loadMirror(cb);
  for (const m of moves) {
    // a mirror renames the code itself, so the runtime name follows
    if (mirror && m.dest.startsWith(mirror.into ? `${mirror.into}.` : "")) continue;
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
    // what uses it: code, and pages naming it (by hash), or linking to it if it's a file (by its name)
    const users = [...cb.store.dependents(h).filter((d) => cb.store.pathsOf(d).length), ...(cb.store.getDef(h)?.kind === "file" ? linkingTo(cb, name).flatMap((p) => cb.store.hashesAt(p)) : [])];
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
  const now = stateOf(cb.store.names(undefined, true));
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
  // a session's scratch files are its own, in its directory (`tcm mcp --branch`, TCM_BRANCH): a file named by
  // itself is there, and one with a path is where the path says
  // a file given is where the caller says; the default one is the codebase's (or its session's), wherever tcm runs
  const scratch = (f?: string, fallback = "scratch.ts") => {
    if (process.env.TCM_BRANCH && !/[\\/]/.test(f ?? "")) return path.resolve(sessionDirFor(Codebase.findRoot(cwd), process.env.TCM_BRANCH), f ?? fallback);
    if (f !== undefined) return path.resolve(cwd, f);
    try {
      return path.join(Codebase.findRoot(cwd), fallback);
    } catch {
      return path.resolve(cwd, fallback);
    }
  };
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
  // the editor says where the workspace is (initialize), so the codebase is found then
  // agents connect before there may be a codebase; each tool runs tcm itself, so this stays out of the way
  if (cmd === "mcp") {
    const { model } = execute(cmd, parse(commands.mcp, { argv: rest }));
    // a session: every command it runs works on its own branch, made from the codebase's own if it's new (with
    // --session, a new one for each server: every agent sharing one .mcp.json gets its own)
    const root = Codebase.findRoot(cwd);
    // (its tools run tcm in the codebase's directory: paths they're given are the codebase's)
    if (process.env.TCM_MCP_SERVER) {
      await serveMcp(root, [process.execPath, ...process.execArgv, process.argv[1]!], `TypeScript ${TS_VERSION}`, process.env.TCM_BRANCH || undefined);
      return 0;
    }
    // with --session, an agent works on its own branch while another's server is running on this codebase, and on
    // the codebase's own when it's the only one (nothing to keep apart, nothing to merge)
    const alone = model.session && !model.branch && !liveMcpServers(root).length;
    const branch = model.branch ?? (model.session && !alone ? `session/${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}` : undefined);
    if (branch || alone) delete process.env.TCM_BRANCH;
    if (branch) {
      const cb = Codebase.find(cwd);
      if (!cb.store.hasBranch(branch)) cb.store.createBranch(branch);
      cb.store.close();
      process.env.TCM_BRANCH = branch;
    }
    registerMcpServer(root, process.env.TCM_BRANCH || undefined);
    // the server proper, under a supervisor that starts it again when this tcm is replaced
    const env = { ...process.env, TCM_MCP_SERVER: "1", ...(alone ? { TCM_MCP_ALONE: "1" } : {}) };
    return await superviseMcp([process.execPath, ...process.execArgv, process.argv[1]!, "mcp"], env, root, process.argv[1]!);
  }
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
  cb.adoptMirror = (m) => importProject(cb, m.dir, "update", m.into, false, m.exclude, m.tests, false);
  // a mirror's files changed outside tcm come in first (importing them is the command's job, and checking them
  // against the codebase `mirror --check`'s)
  if (cmd !== "import" && cmd !== "mirror") followMirror(cb);
  switch (cmd) {
    case "watch": {
      const { model } = execute(cmd, parse(commands.watch, { argv: rest }));
      watch(cb, checkInto(model.into), model.fresh);
      return -1; // keep running
    }
    case "status": {
      execute(cmd, parse(commands.status, { argv: rest }));
      status(cb);
      return 0;
    }
    case "check": {
      const { model } = execute(cmd, parse(commands.check, { argv: rest }));
      // each file in turn (none: the codebase's scratch.ts)
      let ok = true;
      for (const f of model.files.length ? model.files : [undefined]) ok = check(cb, scratch(f), checkInto(model.into), model.fresh) && ok;
      return ok ? 0 : 1;
    }
    case "add":
    case "update": {
      const { model } = execute(cmd, parse(commands[cmd], { argv: rest }));
      let ok = true;
      for (const f of model.files.length ? model.files : [undefined]) ok = save(cb, scratch(f), cmd, checkInto(model.into)) && ok;
      return ok ? 0 : 1;
    }
    case "import": {
      const { model } = execute(cmd, parse(commands.import, { argv: rest }));
      return importProject(cb, model.dir, model.update ? "update" : "add", checkInto(model.into) ?? "", model.verbose, model.exclude, model.tests, model.mirror) ? 0 : 1;
    }
    case "mirror": {
      const { model } = execute(cmd, parse(commands.mirror, { argv: rest }));
      const m = loadMirror(cb);
      if (!m) throw new UsageError("this codebase has no mirror; link one with `tcm import <dir> --into <ns> --mirror`");
      if (model.unlink) {
        unlinkMirror(cb);
        console.log(`no longer writing back to ${path.relative(cwd, m.dir) || "."}`);
        return 0;
      }
      console.log(`${bold(m.into || "(root)")} is mirrored to ${path.relative(cwd, m.dir) || "."} ${dim(`(${Object.keys(m.files).length} files)`)}`);
      if (!model.check) return 0;
      const problems = checkMirror(cb, m);
      for (const p of problems) console.log(red(`  ${p}`));
      console.log(problems.length ? red(`${problems.length} difference(s) between the files and the codebase`) : green("the files hash to what the codebase holds"));
      return problems.length ? 1 : 0;
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
      // the tests named, or under the namespaces named (all of them, with none)
      const wanted = model.names.length ? model.names : [""];
      const ns = wanted.join(", ");
      const under = (p: string) => wanted.some((w) => !w || p === w || p.startsWith(w + "."));
      // test definitions a package runs its command with are run as programs of their own, with the suites
      const declared = [...new Map(wanted.flatMap((w) => suitesIn(cb, w)).map((s) => [s.path, s])).values()];
      const commandTests = new Set(suitesIn(cb, "").map((s) => s.path));
      const names = cb.store.names().filter((n) => n.kind !== "type" && isTestPath(n.path) && !commandTests.has(n.path) && under(n.path));
      const suites = model.definitions ? [] : declared;
      if (!names.length && !suites.length) {
        console.log(dim(`no tests${ns ? ` under ${ns}` : ""} (tests are definitions named test… or under a \`tests\` namespace)`));
        return 0;
      }
      let ok = true;
      if (names.length) {
        const outcomes = runCached(cb, names.map((n) => ({ path: n.path, rec: cb.store.getDef(n.hash)! })), cb.source(), model.fresh);
        printOutcomes(outcomes);
        console.log(`\n${summary(outcomes)}`);
        ok = outcomes.every((o) => o.result.ok);
      }
      // suites: test files running a package's command, as a program
      if (suites.length) {
        console.log(`${names.length ? "\n" : ""}${bold("suites")} ${dim(`(running ${[...new Set(suites.map((s) => s.bin))].join(", ")})`)}`);
        // each as it finishes: a run can take minutes
        const builds = new Map((model.bin ?? []).map((b) => {
          const at = b.indexOf("=");
          if (at < 1) throw new UsageError(`--bin takes cmd=<path>, not '${b}'`);
          return [b.slice(0, at), path.resolve(cwd, b.slice(at + 1))] as const;
        }));
        const outcomes = await runSuites(cb, suites, model.fresh, (o) => printOutcomes([o]), builds);
        console.log(`\nsuites: ${summary(outcomes)}`);
        ok &&= outcomes.every((o) => o.result.ok);
      }
      return ok ? 0 : 1;
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
      // what it starts can run the codebase's commands, as <CMD>_BIN (a script running tcm, say)
      Object.assign(process.env, commandsIn(cb));
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
      const given = model.token ?? process.env.TCM_TOKEN;
      const token = given ?? newToken();
      const tls = model.tls || model["tls-cert"] ? tlsMaterial(cb, model["tls-cert"], model["tls-key"]) : undefined;
      // --insecure acknowledges clear-text tokens beyond localhost
      const site = model.site ? path.resolve(cwd, model.site) : undefined;
      if (site && !fs.existsSync(path.join(site, "index.html"))) throw new UsageError(`--site ${model.site}: there's no index.html there`);
      serve(cb, { host: model.host, port: model.port, token, allowRun: model.run, tls, showToken: !given, ...(site ? { site } : {}) }, model.insecure);
      return -1; // keep running
    }
    case "at": {
      const { model } = execute(cmd, parse(commands.at, { argv: rest }));
      if (!model.place) throw new UsageError("usage: tcm at <file>[:<line>], e.g. `tcm at scratch.ts:12`");
      at(cb, model.place);
      return 0;
    }
    case "patch": {
      const { model } = execute(cmd, parse(commands.patch, { argv: rest }));
      if (!model.name) throw new UsageError('usage: tcm patch <name> --old <text> --new <text> (or --edits \'[{"old": "…", "new": "…"}]\')');
      let edits: PatchEdit[] = [];
      if (model.edits !== undefined) {
        try {
          edits = (JSON.parse(model.edits) as PatchEdit[]).map((e) => ({ old: String(e.old ?? ""), new: String(e.new ?? "") }));
        } catch (e) {
          throw new UsageError(`--edits isn't JSON: ${(e as Error).message}`);
        }
      }
      if (model.old !== undefined) edits.push({ old: model.old, new: model.new ?? "" });
      if (!edits.length) throw new UsageError("tcm patch needs --old and --new, or --edits");
      return patch(cb, model.name, edits, model.all) ? 0 : 1;
    }
    case "edit": {
      const { model } = execute(cmd, parse(commands.edit, { argv: rest }));
      const names = model.names.length ? model.names : [await chooseName(cb, "edit <name>...", "Edit which definition?")];
      edit(cb, names, model.file !== undefined ? scratch(model.file) : (jsx) => scratch(undefined, jsx ? "scratch.tsx" : "scratch.ts"), model.force);
      return 0;
    }
    case "export": {
      const { model } = execute(cmd, parse(commands.export, { argv: rest }));
      if (!model.namespace || !model.dir) throw new UsageError("usage: tcm export <namespace> <dir>, e.g. `tcm export docs site/docs`");
      const n = exportFiles(cb, model.namespace, path.resolve(cwd, model.dir));
      if (!n) throw new UsageError(`no files under ${model.namespace}`);
      console.log(`wrote ${n} file${n > 1 ? "s" : ""} from ${model.namespace} to ${model.dir}`);
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
      // a mirrored codebase's releases are kept with its files, in git: made from a commit, so they can be made again
      const mirror = loadMirror(cb);
      let commit: string | undefined;
      try {
        commit = mirror && releaseCommit(mirror);
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      const { release: rel, plan } = await releasePackage(cb, { name, version, notesFile: m.notes === undefined ? undefined : path.resolve(cwd, m.notes), remote: m.remote, force: m.force, author: author() });
      console.log(`${green("released")} ${bold(`${rel.package}@${rel.version}`)} ${dim(`as ${shortHash(rel.causal)}${plan.prev ? `, after ${plan.prev.version}` : ""}: ${reasonFor(plan)}`)}\n`);
      console.log(rel.notes.replace(`${MARKER}\n\n`, "").trimEnd());
      if (mirror && commit) {
        recordRelease(mirror, { package: rel.package, version: rel.version, commit, notes: rel.notes, author: rel.author, ts: rel.ts });
        console.log(dim(`\n  recorded in ${path.relative(cwd, path.join(mirror.dir, "tcm-releases.json"))}, from commit ${commit.slice(0, 8)}: commit it, and the release can be made again from git`));
      }
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
  // measured (a suite runs tcm to see what code it runs), a tcm stopped by a signal (a test ending the language
  // server it started) still says what it ran: V8 writes coverage on exit, not when a signal ends the process
  if (process.env.NODE_V8_COVERAGE) for (const [signal, n] of [["SIGTERM", 15], ["SIGINT", 2]] as const) process.on(signal, () => process.exit(128 + n));
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

/**
 * Before a command: a mirror's files changed outside tcm (by hand, a git pull or checkout) are imported first, so
 * the command sees them. Files that don't import yet (an edit half made) wait, and so does writing back to them.
 * What it says goes to stderr: a command's output is its own.
 */
export function followMirror(cb: Codebase) {
  const m = loadMirror(cb);
  // (a session on another branch doesn't take the files' changes: they're the mirror's branch's)
  const changed = m && onMirrorBranch(cb, m) ? changedFiles(m) : [];
  if (!m || !changed.length) return;
  const log = console.log;
  const write = process.stdout.write;
  console.log = console.error;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    console.log(dim(`mirror: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? `, and ${changed.length - 3} more,` : ""} changed outside tcm; importing ${changed.length > 1 ? "them" : "it"}`));
    importProject(cb, m.dir, "update", m.into, false, m.exclude, m.tests, false);
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

/**
 * Where a scratch file's changed code is: definitions new or changed, leaving out ones re-hashed only because they
 * refer to one that changed and back (a cycle's members are hashed together; a member's IR is as it was, but for
 * the positions it refers to the others by, which a change to one can reorder).
 */
export function changedCode(cb: Codebase, rows: Row[]): { start: number; end: number }[] {
  return rows
    .filter((r) => r.status !== "identical" && r.status !== "doc" && !cb.store.hashesAt(r.path, r.def.kind).some((h) => withoutCyclePositions(cb.store.getDef(h)?.ir ?? "") === withoutCyclePositions(r.def.ir)))
    .flatMap((r) => (r.def as ProjectDef).range ?? []);
}

/**
 * Whether every definition in a scratch file is saved as it is (and nothing else is in it: a watch expression, code that doesn't check).
 */
export function holdsOnlySaved(cb: Codebase, file: string): boolean {
  cb.refreshShim();
  const a = cb.analyze(file, cb.scratchSalts());
  if (a.errors.length || a.diagnostics.length || a.watches.length || !a.defs.length) return false;
  return classify(cb, a.defs, a.namespace ?? "").every((r) => r.status === "identical");
}

/**
 * A definition's IR without the positions of the cycle members it refers to.
 */
export const withoutCyclePositions = (ir: string) => ir.replace(/\["Cyc","\d+"\]/g, '["Cyc"]');

/**
 * How much of a definition's type a report line shows.
 */
export const SIGNATURE_WIDTH = 120;

/**
 * A module's text without the imports of these names, blanked (spaces where they were) so nothing else moves.
 */
export function blankImports(file: string, text: string, names: Set<string>): string {
  const sf = parse_1(file, text);
  const blanks: [number, number][] = [];
  for (const st of sf.statements) {
    if (!ts_isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    const b = c.namedBindings;
    const elements = b && !ts_isNamespaceImport(b) ? [...b.elements] : [];
    const locals = [...(c.name ? [c.name.text] : []), ...(b && ts_isNamespaceImport(b) ? [b.name.text] : []), ...elements.map((e) => e.name.text)];
    if (!locals.some((l) => names.has(l))) continue;
    if (locals.every((l) => names.has(l)) || (b && ts_isNamespaceImport(b))) {
      blanks.push([st.getStart(sf), st.end]);
      continue;
    }
    // the default, with its comma
    if (c.name && names.has(c.name.text)) blanks.push([c.name.getStart(sf), text.indexOf(",", c.name.end) + 1]);
    elements.forEach((e, i) => {
      if (!names.has(e.name.text)) return;
      // with the comma between it and the next one kept, or the one before it if it's the last kept
      const next = elements[i + 1];
      if (next) blanks.push([e.getStart(sf), next.getStart(sf)]);
      else blanks.push([elements[i - 1]!.end, e.end]);
    });
  }
  let out = text;
  for (const [from, to] of blanks.sort((x, y) => y[0] - x[0])) out = out.slice(0, from) + out.slice(from, to).replace(/[^\n]/g, " ") + out.slice(to);
  return out;
}

/**
 * What a module's imports bind: local name → the module, and whether only as a type.
 */
export function importBindings(file: string, text: string): Map<string, { module: string; type: boolean }> {
  const out = new Map<string, { module: string; type: boolean }>();
  for (const st of parse_1(file, text).statements) {
    if (!ts_isImportDeclaration(st) || !st.importClause || !ts_isStringLiteral(st.moduleSpecifier)) continue;
    const module = st.moduleSpecifier.text;
    const type = isTypeOnlyImport(st.importClause);
    if (st.importClause.name) out.set(st.importClause.name.text, { module, type });
    const b = st.importClause.namedBindings;
    if (b && ts_isNamespaceImport(b)) out.set(b.name.text, { module, type });
    else if (b) for (const e of b.elements) out.set(e.name.text, { module, type: type || e.isTypeOnly });
  }
  return out;
}

/**
 * A scratch file's text followed by definitions of a cycle it changes, as stored (written as `tcm edit` would). Its
 * imports of them go, and so do their imports of what it declares or imports already: blanked, so positions in
 * the file stay where they were. A name the two would bind differently is a problem.
 */
export function withCycle(cb: Codebase, file: string, text: string, members: string[]): { text: string } | { problem: string } {
  const rendered = render(members.map((h) => cb.store.getDef(h)!), cb.source(), cb.lay, {
    style: "scratch",
    exportDeclarations: true,
    remap: (h) => cb.store.patched(h),
    annotate: (h) => `// tcm: path ${cb.store.pathsOf(h)[0]}`,
  }).text;
  const declared = new Set(declarations(file, text).keys());
  const ours = importBindings(file, text);
  const drop = new Set<string>();
  for (const [local, theirs] of importBindings(file, rendered)) {
    const mine = ours.get(local);
    if (declared.has(local) || (mine && mine.module === theirs.module && mine.type === theirs.type)) drop.add(local);
    else if (mine) return { problem: `${local} is imported from ${mine.module} here, and from ${theirs.module} there` };
  }
  return { text: `${blankImports(file, text, new Set(declarations(file, rendered).keys()))}\n${blankImports(file, rendered, drop)}` };
}

/**
 * A scratch file analyzed with the rest of the cycles it holds members of: definitions that refer to each other
 * are hashed as one, so the members it doesn't hold are saved with it, as they are, against its new code (none
 * goes on using an old one). They're found from the paths it declares, before it's checked: alone, a cycle's
 * member may not even check (a class whose others take the stored one). Undefined, said why, if it can't be.
 */
export function withTheirCycles(cb: Codebase, file: string, into: string | undefined): { a: Analysis; rows: Row[] } | undefined {
  const text = fs.readFileSync(file, "utf8");
  const here = new Set(pathsIn(file, text, into));
  const missing = new Map<string, string>();
  for (const p of here) {
    for (const old of cb.store.hashesAt(p)) {
      for (const m of cb.store.componentMembers(cb.store.getDef(old)!.componentHash)) {
        const mp = cb.store.pathsOf(m.hash)[0];
        if (m.hash !== old && mp && !here.has(mp)) missing.set(m.hash, mp);
      }
    }
  }
  // what the file imports that leads back to what it holds joins the cycle when it's saved (the file uses it,
  // and it uses the file's): saved with it too, as it is
  const holds = new Set([...[...here].flatMap((p) => cb.store.hashesAt(p)), ...missing.keys()]);
  const leadsBack = new Set<string>();
  for (const queue = [...holds]; queue.length; ) {
    for (const d of cb.store.dependents(queue.pop()!)) if (!leadsBack.has(d) && !holds.has(d)) (leadsBack.add(d), queue.push(d));
  }
  const seen = new Set<string>();
  // (which of the file's definitions use them it can't say before it's checked: they're checked with it, below,
  // and kept only if they turn out in a cycle with it)
  const imported = new Set<string>();
  for (const stack = importedPaths(file, text).flatMap((p) => cb.store.hashesAt(p)); stack.length; ) {
    const h = stack.pop()!;
    if (seen.has(h) || holds.has(h) || !leadsBack.has(h)) continue;
    seen.add(h);
    const p = cb.store.pathsOf(h)[0];
    if (p && !here.has(p) && !missing.has(h)) (missing.set(h, p), imported.add(h));
    for (const d of cb.store.getDef(h)?.deps ?? []) if (d.ref.startsWith("#")) stack.push(d.ref.slice(1));
  }
  if (!missing.size) {
    const a = analyzeScratch(cb, file, into);
    return a && { a, rows: classify(cb, a.defs, into ?? a.namespace ?? "") };
  }
  const combined = () => {
    const whole = withCycle(cb, file, text, [...missing.keys()]);
    return { whole, b: "problem" in whole ? undefined : analyzeScratch(cb, file, into, whole.text) };
  };
  let { whole, b } = combined();
  // what the file imports that didn't turn out in a cycle with its definitions isn't saved with them
  if (b && imported.size) {
    const rows = classify(cb, b.defs, into ?? b.namespace ?? "");
    const theirs = new Set(rows.filter((r) => here.has(r.path)).map((r) => r.def.componentHash));
    const apart = rows.filter((r) => [...imported].some((h) => missing.get(h) === r.path) && !theirs.has(r.def.componentHash));
    if (apart.length) {
      for (const r of apart) for (const [h, p] of missing) if (p === r.path && imported.has(h)) missing.delete(h);
      if (!missing.size) {
        const a = analyzeScratch(cb, file, into);
        return a && { a, rows: classify(cb, a.defs, into ?? a.namespace ?? "") };
      }
      ({ whole, b } = combined());
    }
  }
  const names = [...missing.values()];
  const listed = `${names.slice(0, 5).join(", ")}${names.length > 5 ? `, and ${names.length - 5} more` : ""}`;
  if (!b) {
    console.log(red(`${listed}, in a cycle with what ${path.basename(file)} holds, can't be saved with it as ${names.length > 1 ? "they are" : "it is"}${"problem" in whole ? `: ${whole.problem}` : " (above)"}; \`tcm edit\` ${names.length > 1 ? "them" : "it"} too`));
    return undefined;
  }
  const rows = classify(cb, b.defs, into ?? b.namespace ?? "");
  if (rows.some((r) => r.status !== "identical")) console.log(dim(`with ${listed}: in a cycle with what changed, so saved with it, as ${names.length > 1 ? "they are" : "it is"}`));
  return { a: b, rows };
}

/**
 * The codebase paths a scratch file's declarations go to: its namespace and their names, or a `// tcm: path`.
 */
export function pathsIn(file: string, text: string, into: string | undefined): string[] {
  const ns = into ?? scratchNamespace(text) ?? "";
  const out: string[] = [];
  for (const st of parse_1(file, text).statements) {
    const pragma = /\/\/\s*tcm:\s*path\s+(\S+)/.exec(text.slice(st.pos, st.getStart()))?.[1];
    const names = ts_isVariableStatement(st)
      ? st.declarationList.declarations.flatMap((d) => (ts_isIdentifier(d.name) ? [d.name.text] : []))
      : (ts_isFunctionDeclaration(st) || ts_isClassDeclaration(st) || ts_isInterfaceDeclaration(st) || ts_isTypeAliasDeclaration(st)) && st.name ? [st.name.text] : [];
    if (pragma && names.length) out.push(pragma);
    else for (const n of names) out.push(joinName(ns, n));
  }
  return out;
}

/**
 * `tcm edit` of files kept as written: each into a file of its own, named as it is (or `file`). A Markdown
 * file's first line says where it goes back; another's is saved with `--into`.
 */
export function editFiles(cb: Codebase, targets: string[], file: string | undefined, force: boolean) {
  if (file && targets.length > 1) throw new UsageError("--file names one file: edit files one at a time");
  for (const t of targets) {
    const h = cb.lookupOne(t);
    const rec = cb.store.getDef(h)!;
    if (rec.kind !== "file") throw new UsageError(`${t} is code, the others files: edit them apart`);
    const name = cb.store.pathsOf(h)[0] ?? t;
    const ns = name.slice(0, Math.max(0, name.lastIndexOf(".")));
    const format = formatOf(rec);
    // as it's named, here (or in a session's own directory)
    const out = file ?? path.join(cb.sessionDir ?? process.cwd(), fileName(name.slice(name.lastIndexOf(".") + 1), rec));
    const content = fileContent(cb, rec, ns);
    const body = format === "md" ? Buffer.concat([Buffer.from(`<!-- tcm: path ${name} -->\n`), content]) : content;
    // the codebase's own config, where `tcm edit` writes: never over it, --force or not
    if (["package.json", "tsconfig.json"].some((f) => path.resolve(out) === path.join(cb.lay.root, f))) throw new UsageError(`${path.basename(out)} here is the codebase's own: edit ${name} with --file <other>`);
    if (fs.existsSync(out) && !force && !fs.readFileSync(out).equals(body)) throw new UsageError(`${path.basename(out)} exists; pass --force to overwrite it, or --file <other>`);
    fs.writeFileSync(out, body);
    const shown = path.relative(process.cwd(), out);
    console.log(`wrote ${name} to ${shown}${format === "md" ? "" : dim(` (saved with \`tcm update ${shown} --into ${ns}\`)`)}`);
  }
}

/**
 * A file kept as written (Markdown, CSS, an image), as `check` and `save` see it: its definition, where it goes
 * (a Markdown file's first line `<!-- tcm: path a.b.c -->` or `<!-- tcm: namespace a.b -->`, or `--into` and its
 * name), and whether that's new. Undefined, said why, if it can't be saved.
 */
export function fileRows(cb: Codebase, file: string, into: string | undefined): Row[] | undefined {
  const format = fileFormat(file)!;
  let content = fs.readFileSync(file);
  let target: string | undefined;
  let ns = into;
  if (format === "md") {
    const text = content.toString("utf8");
    const pragma = /^<!--\s*tcm:\s*(path|namespace)\s+(\S+)\s*-->\r?\n/.exec(text);
    if (pragma) {
      if (pragma[1] === "path") target = pragma[2];
      else ns ??= pragma[2];
      content = Buffer.from(text.slice(pragma[0].length), "utf8");
    }
  }
  const name = target ?? joinName(ns ?? "", fileLeaf(file));
  const { def, problems, warnings } = fileDefinition(cb, name, format, content);
  for (const w of warnings) console.log(yellow(`warning: ${w}`));
  if (problems.length) {
    for (const p of problems) console.log(red(p));
    console.log(red(`\n${path.basename(file)} has problems; nothing was saved.`));
    return undefined;
  }
  return classifyPaths(cb, [{ def, path: name }]);
}

/**
 * Import the files under `root` that aren't code (Markdown, CSS, images), as files of the codebase: their hashes,
 * by name, or undefined if they don't import. Following a mirror, one it hasn't changed stays as the codebase
 * has it, and one gone from the files goes from the codebase.
 */
export function importAssets(cb: Codebase, root: string, dir: string, mode: "add" | "update", into: string, verbose: boolean, exclude: string[], following?: Mirror): Map<string, string> | undefined {
  let failed = false;
  // a file that can't be named in the codebase (a dot in its name) is a problem with it, said, not a stop
  const named = assetFiles(root, new Set(exclude.map((e) => path.resolve(root, e)))).flatMap((f) => {
    try {
      return [{ f, name: assetName(root, into, f) }];
    } catch (e) {
      console.log(red(`${path.relative(root, f)}: ${(e as Error).message}`));
      failed = true;
      return [];
    }
  });
  const names = new Set(named.map((n) => n.name));
  const planned: { def: DefRecord; path: string; warnings: string[] }[] = [];
  for (const { f, name } of named) {
    const { def, problems, warnings } = fileDefinition(cb, name, assetFormat(f), fs.readFileSync(f), names);
    for (const p of problems) console.log(red(`${path.relative(root, f)}: ${p}`));
    failed ||= problems.length > 0;
    planned.push({ def, path: name, warnings });
  }
  if (failed) return undefined;
  const held = new Map(planned.map((p) => [p.path, p.def.hash]));
  const was = new Map<string, string>();
  // by what the codebase has for them: a removed file's mark (.tcm-files) may be gone with it
  const isFile = (f: Mirror["files"][string]) => Object.values(f.names).some((h) => cb.store.getDef(h)?.kind === "file");
  if (following) for (const f of Object.values(following.files)) if (isFile(f)) for (const [leaf, h] of Object.entries(f.names)) was.set(joinName(f.ns, leaf), h);
  const changed = planned.filter((p) => was.get(p.path) !== p.def.hash);
  // what's wrong with the files that changed (the others said so when they did)
  for (const p of changed) for (const w of p.warnings) console.log(yellow(`warning: ${w}`));
  if (changed.length && !apply(cb, classifyPaths(cb, changed), mode, `import ${dir}`, !verbose)) return undefined;
  for (const [p, h] of was) {
    if (held.has(p) || !cb.store.hashesAt(p).includes(h)) continue;
    cb.store.removeName(p, h, `import ${dir}`);
    console.log(`${red("  - removed  ")} ${bold(p)} ${dim("(gone from the files)")}`);
  }
  return held;
}

/**
 * The codebase paths a scratch file imports (from `#codebase/a/b`: `a.b.<name>`).
 */
export function importedPaths(file: string, text: string): string[] {
  const out: string[] = [];
  for (const st of parse_1(file, text).statements) {
    if (!ts_isImportDeclaration(st) || !st.importClause || !ts_isStringLiteral(st.moduleSpecifier)) continue;
    const m = /^#codebase(?:\/(.+))?$/.exec(st.moduleSpecifier.text);
    const b = st.importClause.namedBindings;
    if (!m || !b || ts_isNamespaceImport(b)) continue;
    const ns = (m[1] ?? "").split("/").filter(Boolean).join(".");
    for (const e of b.elements) out.push(joinName(ns, (e.propertyName ?? e.name).text));
  }
  return out;
}

/**
 * A scratch file's text with more definitions in it (`text`, rendered as `tcm edit` writes them): their imports
 * after the file's own, without the names it imports already, and their code at the end.
 */
export function addToScratch(file: string, existing: string, text: string): string {
  const have = parse_1(file, existing).statements.filter(ts_isImportDeclaration);
  // (names it imports, or declares itself)
  const bound = new Set([...have.flatMap((st) => importedLocals(st)), ...declarations(file, existing).keys()]);
  const added = parse_1(file, text).statements.filter(ts_isImportDeclaration);
  const lines = added.flatMap((st) => importLines(st, text).filter((l) => !bound.has(l.local)).map((l) => l.line));
  const imports = lines.length ? groupImports(lines) : [];
  const code = text.slice(added.at(-1)?.end ?? 0).trim();
  const last = have.at(-1);
  // after the last import, or else the namespace line, or else at the top
  const pragma = /^\/\/ tcm: namespace \S+\n/.exec(existing);
  const at = last ? last.end + (existing[last.end] === "\n" ? 1 : 0) : pragma ? pragma[0].length : 0;
  const head = existing.slice(0, at) + (imports.length ? imports.join("\n") + "\n" : "");
  const rest = existing.slice(at);
  return `${head}${!last && imports.length && rest.trim() ? "\n" : ""}${rest.trimEnd()}\n\n${code}\n`.replace(/\n{3,}/g, "\n\n");
}

/**
 * Definitions added to a scratch file go after what's in it, their imports with its imports, without repeating
 * any it has.
 */
export const testAddToScratch = () => {
  const existing = `// tcm: namespace lib\nimport { a } from "#codebase/lib";\n\nexport const b = (): number => a + 1;\n`;
  const text = `import { a } from "#codebase/lib";\nimport fs from "node:fs";\n\nexport const c = (): string => fs.readFileSync("x", "utf8") + a;\n`;
  assert.equal(addToScratch("s.ts", existing, text), `// tcm: namespace lib\nimport { a } from "#codebase/lib";\nimport fs from "node:fs";\n\nexport const b = (): number => a + 1;\n\nexport const c = (): string => fs.readFileSync("x", "utf8") + a;\n`);
  // a name the file imports already, in an import of several, isn't imported again; the others are, together
  const grouped = `import { a, d } from "#codebase/lib";\nimport type { T } from "#codebase/lib";\n\nexport const e = (t: T): number => a + d + t.n;\n`;
  assert.equal(addToScratch("s.ts", existing, grouped), `// tcm: namespace lib\nimport { a } from "#codebase/lib";\nimport { d } from "#codebase/lib";\nimport type { T } from "#codebase/lib";\n\nexport const b = (): number => a + 1;\n\nexport const e = (t: T): number => a + d + t.n;\n`);
  assert.equal(addToScratch("s.ts", "export const x = 1;\n", `import fs from "node:fs";\n\nexport const y = fs;\n`), `import fs from "node:fs";\n\nexport const x = 1;\n\nexport const y = fs;\n`);
}

/**
 * A scratch file's text without the definitions in it saved as they are (their docs and `// tcm: path` lines
 * with them, and imports only they used), so it holds what's being worked on; one the rest of the file mentions
 * (a watch expression, another definition) stays. The names taken out.
 */
export function clearSaved(cb: Codebase, file: string, text: string): { text: string; cleared: string[] } {
  cb.refreshShim();
  const a = cb.analyze(file, cb.scratchSalts());
  if (a.errors.length || a.diagnostics.length) return { text, cleared: [] };
  const decls = declarations(file, text);
  const spans = classify(cb, a.defs, a.namespace ?? "").flatMap((r) => {
    // (the file's own definitions, as analyzed: each a whole statement, with its doc)
    const def = r.def as ProjectDef;
    const d = decls.get(def.nameHint);
    if (r.status !== "identical" || def.file !== file || !d || d.shared) return [];
    let start = d.doc?.start ?? d.start;
    const pragma = /(?:^|\n)\/\/ tcm: path \S+\n$/.exec(text.slice(0, start));
    if (pragma) start = pragma.index + (text[pragma.index] === "\n" ? 1 : 0);
    let end = d.end;
    while (text[end] === "\n") end++;
    return [{ start, end, name: def.nameHint, path: r.path }];
  });
  const without = (keep: typeof spans) => {
    let out = text;
    for (const sp of [...keep].sort((x, y) => y.start - x.start)) out = out.slice(0, sp.start) + out.slice(sp.end);
    return out;
  };
  const rest = without(spans);
  const gone = spans.filter((sp) => !new RegExp(`\\b${sp.name.replaceAll("$", "\\$")}\\b`).test(rest));
  if (!gone.length) return { text, cleared: [] };
  return { text: pruneImports(file, text, without(gone)).replace(/\n{3,}/g, "\n\n"), cleared: gone.map((sp) => sp.path) };
}

/**
 * An import declaration as one import per name it binds (for grouping), each with the name.
 */
export function importLines(st: ImportDeclaration, text: string): { local: string; line: string }[] {
  const c = st.importClause;
  if (!c) return [];
  const from = text.slice(st.moduleSpecifier.getStart(), st.moduleSpecifier.end);
  const type = isTypeOnlyImport(c) ? "type " : "";
  const b = c.namedBindings;
  return [
    ...(c.name ? [{ local: c.name.text, line: `import ${type}${c.name.text} from ${from};` }] : []),
    ...(b && ts_isNamespaceImport(b) ? [{ local: b.name.text, line: `import ${type}* as ${b.name.text} from ${from};` }] : []),
    ...(b && isNamedImports(b)
      ? b.elements.map((e) => ({ local: e.name.text, line: `import ${type || (e.isTypeOnly ? "type " : "")}{ ${e.propertyName ? `${text.slice(e.propertyName.getStart(), e.propertyName.end)} as ` : ""}${e.name.text} } from ${from};` }))
      : []),
  ];
}

/**
 * The names an import declaration binds.
 */
export function importedLocals(st: ImportDeclaration): string[] {
  const c = st.importClause;
  if (!c) return [];
  const b = c.namedBindings;
  return [...(c.name ? [c.name.text] : []), ...(b && ts_isNamespaceImport(b) ? [b.name.text] : b && isNamedImports(b) ? b.elements.map((e) => e.name.text) : [])];
}

/**
 * A signature on one line, cut at `width` (`tcm view` shows all of it): a long literal type, or an object type
 * written over lines, doesn't flood a listing.
 */
export function cutSignature(sig: string, width = SIGNATURE_WIDTH): string {
  const one = sig.replace(/\s*\n\s*/g, " ");
  return one.length > width ? `${one.slice(0, width - 1)}…` : one;
}

/**
 * Names, the first `n` of them and how many more.
 */
export function listed(names: string[], n: number): string {
  return names.length > n ? `${names.slice(0, n).join(", ")}, and ${names.length - n} more` : names.join(", ");
}

/**
 * Dependents re-hashed by an update: a line each when there are a few, else by namespace, with how many and the
 * first of them (`tcm diff` lists them all).
 */
export function printDependents(paths: string[]) {
  if (!paths.length) return;
  if (paths.length <= 6) {
    for (const p of paths) console.log(`${yellow("  ~ updated  ")} ${bold(p)} ${dim("(dependent)")}`);
    return;
  }
  const byNs = new Map<string, string[]>();
  for (const p of paths) {
    const ns = p.slice(0, Math.max(0, p.lastIndexOf(".")));
    byNs.set(ns, [...(byNs.get(ns) ?? []), p.slice(ns ? ns.length + 1 : 0)]);
  }
  console.log(`${yellow("  ~ updated  ")} ${paths.length} dependents ${dim("(re-hashed: what they use changed; `tcm diff` lists them)")}`);
  for (const [ns, leaves] of [...byNs].sort((a, b) => b[1].length - a[1].length)) console.log(`      ${bold(ns || "(root)")} ${dim(`${leaves.length}: ${listed(leaves, 5)}`)}`);
}

/**
 * Listings cut long signatures to one line; reports say a lot of sameness in a line.
 */
export const testOutputIsShort = () => {
  assert.equal(cutSignature(": { a: number;\n  b: string }"), ": { a: number; b: string }");
  assert.equal(cutSignature("x".repeat(200), 10), "xxxxxxxxx…");
  assert.equal(listed(["a", "b", "c"], 2), "a, b, and 1 more");
  const lines: string[] = [];
  const log = console.log;
  const colour = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  console.log = (s: string) => void lines.push(s.replace(colour, ""));
  try {
    printDependents(["lib.a", "lib.b", "lib.c", "lib.d", "lib.e", "lib.f", "app.g"]);
  } finally {
    console.log = log;
  }
  assert.match(lines[0]!, /~ updated +7 dependents/);
  assert.equal(lines[1]!.trim(), "lib 6: a, b, c, d, e, and 1 more");
  assert.equal(lines[2]!.trim(), "app 1: g");
}

/**
 * A change `tcm patch` makes: text to find, and what replaces it.
 */
export interface PatchEdit {
  old: string;
  new: string;
}

/**
 * The edits made to `text`: each `old` must be in it exactly once (every one, with `all`), else why not.
 */
export function applyPatch(text: string, edits: PatchEdit[], all = false): { text: string } | { problem: string } {
  let out = text;
  for (const e of edits) {
    if (!e.old) return { problem: "an edit has no old text to find" };
    const n = out.split(e.old).length - 1;
    if (!n) return { problem: `not found: ${JSON.stringify(e.old.length > 80 ? `${e.old.slice(0, 79)}…` : e.old)}` };
    if (n > 1 && !all) return { problem: `found ${n} times: ${JSON.stringify(e.old.length > 80 ? `${e.old.slice(0, 79)}…` : e.old)} (give more of the text around it, or --all)` };
    out = all ? out.split(e.old).join(e.new) : out.replace(e.old, () => e.new);
  }
  return { text: out };
}

/**
 * `tcm patch <name>`: change a definition by find-and-replace on its code as `tcm view` shows it (current names),
 * then save it as `tcm update` does: checked, its dependents re-hashed. Nothing is saved if an edit doesn't apply
 * or the result doesn't typecheck. The change is shown as lines removed and added.
 */
export function patch(cb: Codebase, name: string, edits: PatchEdit[], all: boolean): boolean {
  const jsx = cb.lookup(name).some((h) => cb.store.getDef(h)?.jsx);
  // a scratch file of its own, where the codebase's are (so `#codebase` resolves), gone afterwards
  const file = path.join(cb.sessionDir ?? cb.lay.root, `patch-${process.pid}${jsx ? ".tsx" : ".ts"}`);
  const log = console.log;
  try {
    console.log = () => {};
    try {
      edit(cb, [name], file, true);
    } finally {
      console.log = log;
    }
    const before = fs.readFileSync(file, "utf8");
    const r = applyPatch(before, edits, all);
    if ("problem" in r) throw new UsageError(`${name}: ${r.problem}; nothing was changed (\`tcm view ${name}\` shows its code)`);
    if (r.text === before) {
      console.log(dim(`${name}: no change`));
      return true;
    }
    fs.writeFileSync(file, r.text);
    console.log(dim(`${name}:`));
    for (const [op, line] of lineDiff(before.split("\n"), r.text.split("\n"))) {
      if (op === "-") console.log(red(`  - ${line}`));
      else if (op === "+") console.log(green(`  + ${line}`));
    }
    console.log();
    return save(cb, file, "update");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * A patch's edits apply where their text is, once each unless every one is asked for; else nothing changes.
 */
export const testApplyPatch = () => {
  assert.deepEqual(applyPatch("a + b", [{ old: "b", new: "c" }]), { text: "a + c" });
  assert.deepEqual(applyPatch("x = 1; y = 1", [{ old: "1", new: "2" }], true), { text: "x = 2; y = 2" });
  assert.match((applyPatch("x = 1; y = 1", [{ old: "1", new: "2" }]) as { problem: string }).problem, /found 2 times/);
  assert.match((applyPatch("x", [{ old: "z", new: "y" }]) as { problem: string }).problem, /not found/);
  // `$&` in the new text is text, not a pattern
  assert.deepEqual(applyPatch("a", [{ old: "a", new: "$&$&" }]), { text: "$&$&" });
}

/**
 * `tcm at <file>[:<line>]`: the definition at a line of a file, or every definition in it with its lines. For
 * scratch files, definitions' documents, generated modules (what stack traces name) and mirrored files.
 */
export function at(cb: Codebase, arg: string) {
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(arg)!;
  const file = path.resolve(process.cwd(), m[1]!);
  if (!fs.existsSync(file)) throw new UsageError(`no file ${m[1]}`);
  const line = m[2] ? Number(m[2]) : undefined;
  const text = fs.readFileSync(file, "utf8");
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const name = nameAt(cb, file, text);
  const decls = [...declarations(file, text)].map(([leaf, d]) => ({ leaf, from: lineOf(d.doc?.start ?? d.start), to: lineOf(d.end), at: lineOf(d.start) }));
  const shown = line === undefined ? decls : decls.filter((d) => d.from <= line && line <= d.to);
  if (!shown.length) return console.log(dim(line === undefined ? `no definitions in ${m[1]}` : `line ${line} of ${m[1]} isn't in a definition`));
  for (const d of shown.sort((a, b) => a.from - b.from)) {
    const full = name(d.leaf, d.at);
    let hashes: string[] = [];
    try {
      hashes = full ? cb.lookup(full) : [];
    } catch {
      hashes = [];
    }
    const rec = hashes[0] ? cb.store.getDef(hashes[0]) : undefined;
    const what = rec ? `${dim(shortHash(rec.hash))}  ${dim(cutSignature(rec.kind === "type" ? rec.signature : `: ${rec.signature}`, 80))}` : dim("(not in the codebase)");
    console.log(`${bold(full ?? d.leaf)}  ${what}  ${dim(`lines ${d.from}–${d.to}`)}`);
  }
}

/**
 * The codebase name of a definition declared as `leaf` at `line` of `file`: a definition's document (.tcm/src) is
 * one name's, a generated module (.tcm/cache) a component's, a mirrored file its namespace's, and a scratch file's
 * say where they go (`// tcm: path`, or its `// tcm: namespace`).
 */
export function nameAt(cb: Codebase, file: string, text: string): (leaf: string, line: number) => string | undefined {
  const inside = (dir: string) => !path.relative(dir, file).startsWith("..");
  if (inside(srcDir(cb))) {
    const name = hashesOfViewFile(cb, file).map((h) => cb.store.pathsOf(h)[0]).find(Boolean);
    return () => name;
  }
  if (inside(cb.lay.cacheDir)) {
    const members = cb.store.componentMembers(path.basename(file).replace(/\.tsx?$/, "")).flatMap((m) => cb.store.pathsOf(m.hash));
    return (leaf) => members.find((p) => p.slice(p.lastIndexOf(".") + 1) === leaf);
  }
  const m = loadMirror(cb);
  const mirrored = m?.files[path.relative(m.dir, file)];
  if (mirrored) return (leaf) => joinName(mirrored.ns, leaf);
  const lines = text.split("\n");
  const ns = /^\/\/ tcm: namespace (\S+)/m.exec(text)?.[1] ?? "";
  return (leaf, line) => {
    // a `// tcm: path` line above the declaration (and its doc) says where it goes
    for (let i = line - 2; i >= 0 && i >= line - 40; i--) {
      const p = /^\/\/ tcm: path (\S+)/.exec(lines[i]!);
      if (p) return p[1];
      if (lines[i]!.trim() && !/^\s*(\/\/|\/\*|\*)/.test(lines[i]!)) break;
    }
    return joinName(ns, leaf);
  };
}

/**
 * `tcm status`: where things stand. The branch; what's in the codebase, by namespace; what needs fixing; scratch
 * files holding work that isn't saved, and what saving them would do; and whether a mirror's files are in step.
 */
export function status(cb: Codebase) {
  console.log(`${bold("branch")}  ${cb.store.branch().name}${cb.sessionDir ? dim("  (a session: `tcm merge` lands it)") : ""}`);
  const names = cb.store.names(undefined, true);
  // by namespace, as deep as fits in a screenful
  let counts = new Map<string, number>();
  for (let depth = 3; depth > 0; depth--) {
    counts = new Map();
    for (const n of names) {
      const segs = n.path.split(".");
      const ns = segs.slice(0, Math.min(segs.length - 1, depth)).join(".") || "(root)";
      counts.set(ns, (counts.get(ns) ?? 0) + 1);
    }
    if (counts.size <= 20) break;
  }
  console.log(`\n${bold(`${names.length} named definition${names.length === 1 ? "" : "s"}`)}${counts.size > 1 ? dim(", by namespace") : ""}`);
  const width = Math.max(0, ...[...counts.keys()].map((k) => k.length));
  for (const [ns, n] of [...counts].sort()) console.log(`  ${ns.padEnd(width)}  ${dim(String(n))}`);
  // scratch files with what isn't saved yet
  const dir = cb.sessionDir ?? cb.lay.root;
  const scratch = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts")).map((f) => path.join(dir, f));
  const work: string[] = [];
  for (const file of scratch) {
    if (!fs.readFileSync(file, "utf8").trim()) continue;
    const a = cb.analyze(file, cb.scratchSalts());
    const rel = path.relative(process.cwd(), file);
    if (a.errors.length || a.diagnostics.length) {
      work.push(`  ${rel}  ${yellow(`doesn't check (${a.errors.length + a.diagnostics.length} problem${a.errors.length + a.diagnostics.length === 1 ? "" : "s"}): \`tcm check ${rel}\``)}`);
      continue;
    }
    const tally = new Map<string, number>();
    for (const r of classify(cb, a.defs, a.namespace ?? "")) if (r.status !== "identical") tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
    if (tally.size) work.push(`  ${rel}  ${[...tally].map(([s, n]) => `${n} ${s}`).join(", ")}${dim(`: \`tcm ${tally.has("update") || tally.has("conflict") ? "update" : "add"} ${rel}\` saves ${[...tally.values()].reduce((x, y) => x + y, 0) > 1 ? "them" : "it"}`)}`);
  }
  console.log(`\n${bold("scratch files")}`);
  console.log(work.length ? work.join("\n") : dim("  nothing unsaved"));
  console.log(`\n${bold("todo")}`);
  todo(cb);
  const m = loadMirror(cb);
  if (m) {
    const behind = onMirrorBranch(cb, m) && m.log !== cb.store.logHead();
    console.log(`\n${bold("mirror")}  ${path.relative(process.cwd(), m.dir) || "."} ${dim(`(${Object.keys(m.files).length} files)`)}  ${behind ? yellow("behind: the codebase changed since the files were written (the next command writes them, or says why it can't)") : green("in step")}`);
  }
}
