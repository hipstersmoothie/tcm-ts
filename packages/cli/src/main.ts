import fs from "node:fs";
import path from "node:path";
import { isConflicted, sameSpace, shortHash, type DefKind, type DefRecord } from "@ucm/core";
import { evaluateWatches, render, run } from "@ucm/loader";
import { Codebase, IDENT_PATH } from "./codebase.ts";
import { migrate } from "./migrate.ts";
import { mergeBranch } from "./merge.ts";
import { isTestPath, printOutcomes, runCached, summary } from "./tests.ts";
import { diffNamespaces, printDiff, rewind, stateOf } from "./diff.ts";
import { bold, cyan, dim, green, red, yellow } from "./style.ts";
import { addRemote, listRemotes, newToken, pull, push, runOn, serve } from "./sync.ts";


class UsageError extends Error {}

const VALUE_FLAGS = new Set(["into", "file", "on", "as", "port", "host", "token"]);

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

type Status = "new" | "identical" | "update" | "alias" | "conflict";

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
    if (hs.length === 1 && hs[0] === def.hash) return { def, path: p, status: "identical" };
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

function check(cb: Codebase, file: string, into?: string): boolean {
  const a = analyzeScratch(cb, file, into);
  if (!a) return false;
  const rows = classify(cb, a.defs, into ?? a.namespace ?? "");
  console.log(`${bold(path.basename(file))}${a.namespace || into ? dim(` → ${into ?? a.namespace}`) : ""}`);
  if (rows.length) printRows(rows);
  else if (!a.watches.length) console.log(dim("  (no definitions)"));
  if (a.watches.length) {
    const results = evaluateWatches(a.watches, cb.source([...a.defs, ...a.watches]), cb.lay);
    for (const w of a.watches) {
      const r = results.find((x) => x.line === w.line);
      console.log(`\n  ${dim(String(w.line).padStart(3) + " │")} ${w.expression}`);
      console.log(`      ${r?.ok ? cyan("⧩") : red("✗")} ${(r?.value ?? "").split("\n").join("\n        ")}`);
    }
  }
  const tests = rows.filter((r) => r.def.kind !== "type" && isTestPath(r.path));
  if (tests.length) {
    const outcomes = runCached(cb, tests.map((r) => ({ path: r.path, rec: r.def })), cb.source([...a.defs, ...a.watches]), false);
    console.log(`\n  ${dim("tests")}  ${summary(outcomes)}`);
    printOutcomes(outcomes, "    ");
  }
  const pending = rows.filter((r) => r.status !== "identical");
  if (pending.length) {
    const needsUpdate = pending.some((r) => r.status === "update" || r.status === "conflict");
    console.log(dim(`\n  run \`ucm ${needsUpdate ? "update" : "add"}\` to save ${pending.length} definition${pending.length > 1 ? "s" : ""}`));
  }
  return true;
}

function save(cb: Codebase, file: string, mode: "add" | "update", into?: string): boolean {
  const a = analyzeScratch(cb, file, into);
  if (!a) return false;
  return apply(cb, classify(cb, a.defs, into ?? a.namespace ?? ""), mode, `${mode} ${path.basename(file)}`, false);
}

/** Store the analyzed definitions and move names: `add` only binds free names, `update` also replaces. */
function apply(cb: Codebase, rows: Row[], mode: "add" | "update", command: string, quiet: boolean): boolean {
  cb.putDefs(rows.map((r) => r.def));
  const patches = new Map<string, string>();
  const skipped: Row[] = [];
  cb.store.transaction(() => {
    for (const r of rows) {
      if (r.status === "new" || r.status === "alias") cb.store.addName(r.path, r.def.hash, r.def.kind, command);
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
  for (const r of skipped) console.log(`${yellow("  ~ skipped  ")} ${bold(r.path)} ${dim("already names a different definition; use `ucm update`")}`);
  if (patches.size) {
    const { updated, failed } = cb.propagate(patches, new Set(rows.map((r) => r.def.hash)));
    for (const p of updated) console.log(`${yellow("  ~ updated  ")} ${bold(p)} ${dim("(dependent)")}`);
    if (failed.length) console.log(red(`\n  ${failed.length} dependent definition(s) no longer typecheck; see \`ucm todo\``));
  }
  cb.refreshShim();
  return skipped.length === 0;
}

// ---- importing existing projects ---------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "dist", "build"]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith(".") || SKIP_DIRS.has(e.name) ? [] : sourceFiles(p);
    return /\.(m|c)?ts$/.test(e.name) && !/\.d\.(m|c)?ts$|\.(test|spec)\.(m|c)?ts$/.test(e.name) ? [p] : [];
  });
}

/** `core/src/analyze.ts` → `core.analyze`, `store/src/index.ts` → `store` */
function namespaceForFile(root: string, file: string): string {
  const segs = path.relative(root, file).replace(/\.(m|c)?ts$/, "").split(path.sep).filter((s) => s !== "src");
  if (segs.at(-1) === "index") segs.pop();
  return segs.map((s) => s.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1")).join(".");
}

function importProject(cb: Codebase, dir: string, mode: "add" | "update", into: string, verbose: boolean): boolean {
  const root = path.resolve(dir);
  const files = sourceFiles(root);
  if (!files.length) throw new UsageError(`no .ts files under ${dir}`);
  console.log(dim(`analyzing ${files.length} files under ${dir}…`));
  cb.refreshShim();
  const a = cb.analyzeProject(files, (file, name) => cb.lineageSalt(joinName(into, namespaceForFile(root, file), name)), [], cb.compilerOptions(root));
  for (const w of a.warnings) console.log(yellow(`warning: ${w}`));
  if (a.diagnostics.length || a.errors.length) {
    for (const d of a.diagnostics) process.stdout.write(d.formatted);
    for (const e of a.errors) console.log(red(e));
    console.log(red(`\n${a.errors.length + a.diagnostics.length} problem(s); nothing was imported.`));
    return false;
  }
  const planned = a.defs.map((def) => ({ def, path: joinName(into, namespaceForFile(root, def.file), def.nameHint) }));
  checkDistinct(planned, (p) => `${p.path} is defined in more than one file (one of them is ${p.def.file})`);
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
  return `${dim("//")} ${bold(names.join(", ") || "(unnamed)")} ${dim(shortHash(hash))} ${dim(rec.kind === "type" ? rec.signature : ": " + rec.signature)}`;
}

function view(cb: Codebase, targets: string[]) {
  for (const t of targets) {
    for (const h of cb.lookup(t).length ? cb.lookup(t) : [cb.lookupOne(t)]) {
      const rec = cb.store.getDef(h)!;
      console.log(header(cb, h));
      process.stdout.write(render([rec], cb.source(), cb.lay, { style: "scratch" }).text);
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
  const sigOnly = query.startsWith(":");
  const q = (sigOnly ? query.slice(1) : query).trim().toLowerCase();
  const hits = cb.store.names().filter((n) => {
    const sig = cb.store.getDef(n.hash)!.signature.toLowerCase();
    return sigOnly ? sig.includes(q) : n.path.toLowerCase().includes(q) || sig.includes(q);
  });
  if (!hits.length) return console.log(dim("no matches"));
  for (const n of hits) console.log(`${bold(n.path)}  ${dim(shortHash(n.hash))}  ${dim(cb.store.getDef(n.hash)!.signature)}`);
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
    console.log(`${red("conflict")} ${bold(p)}: ${hs.map((h) => shortHash(h)).join(", ")}  ${dim(`ucm resolve ${p} ${shortHash(hs[0]!)}`)}`);
  }
  const live = cb.liveHashes();
  for (const t of cb.store.todos()) {
    if (!live.has(t.hash)) continue;
    n++;
    const names = cb.store.pathsOf(t.hash);
    console.log(`${yellow("needs fixing")} ${bold(names.join(", ") || shortHash(t.hash))}: ${t.message.split("\n")[0]}`);
  }
  console.log(n ? dim(`\nfix with \`ucm edit <name>\`, change the scratch file, then \`ucm update\``) : green("nothing to do"));
}

function edit(cb: Codebase, targets: string[], file: string, force: boolean) {
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
    // references to replaced definitions point at their replacements, so a todo item is edited against the new code
    remap: (h) => cb.store.patched(h),
    // a definition whose path isn't `<namespace>.<declared name>` (other namespace, or renamed while keeping
    // its runtime name) says where it goes, so `update` binds it back to the same path
    annotate: (h, declaredAs) => {
      const p = pathOf.get(h);
      return p && p !== joinName(ns, declaredAs) ? `// ucm: path ${p}` : undefined;
    },
  }).text;
  fs.writeFileSync(file, (ns ? `// ucm: namespace ${ns}\n` : "") + text);
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

function watch(cb: Codebase, into?: string) {
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
        check(cb, f, into);
      } catch (e) {
        console.log(red((e as Error).stack ?? String(e)));
      }
    }
  };
  const initial = fs.readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).map((f) => path.join(root, f));
  console.log(`${bold("ucm")} watching ${root} ${dim("(Ctrl-C to stop)")}`);
  initial.forEach((f) => pending.add(f));
  runChecks();
  fs.watch(root, (_event, filename) => {
    if (!filename || !filename.endsWith(".ts") || filename.endsWith(".d.ts")) return;
    pending.add(path.join(root, filename));
    clearTimeout(timer);
    timer = setTimeout(runChecks, 80);
  });
}

// ---- entry --------------------------------------------------------------------------------------------

const HELP = `${bold("ucm")} — a content-addressed codebase manager for TypeScript

  ucm init                       set up a codebase in this directory
  ucm [watch]                    watch *.ts scratch files: typecheck, hash, evaluate watch expressions
  ucm check [file]               one-shot version of watch
  ucm add [file] [--into ns]     add new definitions from a scratch file (default scratch.ts)
  ucm update [file] [--into ns]  add, and replace changed definitions; dependents are re-hashed
  ucm import <dir> [--into ns] [--update] [--verbose]
                                 add an existing project: one namespace per file (src/ and index dropped)
  ucm test [namespace] [--fresh]  run tests (definitions named test… or under \`tests\`); results are cached by hash
  ucm verify                     re-render and re-hash every live definition; must be the identity
  ucm migrate                    rebuild a codebase written with an older hash format (keeps a backup)
  ucm view <name|#hash>...       show definitions with current names
  ucm ls [namespace]             list names
  ucm find <query>               search names and signatures (\`:query\` for signatures only)
  ucm deps <name> / dependents <name>
  ucm run <name> [args...]       run a definition (functions are called with args)
  ucm edit <name>... [--file f] [--force]   write definitions to a scratch file for editing
  ucm mv <from> <to>             rename a definition or namespace (no code changes)
  ucm alias <name> <new>         add another name for a definition
  ucm rm <name> [--force]        remove a name
  ucm todo                       conflicts and dependents that need fixing
  ucm resolve <name> <#hash>     pick one definition for a conflicted name
  ucm docs <name>                show documentation
  ucm diff                       what the last command changed: edits, dependents re-hashed by them, renames
  ucm diff <id> | <branch> | <a> <b>
                                 changes since a history entry, to another branch, or between branches
  ucm history [n] / reset <id>   name changes on this branch / undo back to an entry
  ucm branch [name] / switch <name>
  ucm merge <branch>             three-way merge into this branch; dependents follow the other side's updates

  ucm remote [add <name> <url|dir> [--token t] | rm <name>]
  ucm push [remote] [--as branch] [--force]   send definitions + this branch's names (refuses if the remote moved)
  ucm pull [remote] [branch]     fetch into <remote>/<branch>; fast-forward this branch if it hasn't changed
  ucm run <name> [args] --on <remote|url|dir>   send what the remote lacks, run there, stream output back
  ucm serve [--port 7737] [--host 127.0.0.1] [--token t] [--no-run]
                                 serve this codebase; clients with the token can push, pull and run code
`;

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd = "watch", ...args] = positional;
  const cwd = process.cwd();
  const into = typeof flags.into === "string" ? flags.into : undefined;
  if (into !== undefined && into !== "" && !IDENT_PATH.test(into)) throw new UsageError(`'${into}' is not a valid namespace`);
  const scratch = (f?: string) => path.resolve(cwd, f ?? "scratch.ts");
  const need = (n: number, usage: string) => {
    if (args.length < n) throw new UsageError(`usage: ucm ${usage}`);
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
        `// Definitions here are checked and hashed by \`ucm\`; bare expressions are watch expressions.
// Import saved definitions with: import { name } from "#codebase/namespace"

/** Square a number. */
export const square = (x: number): number => x * x;

square(12);
`,
      );
    }
    console.log(`initialized codebase in ${cb.lay.ucmDir}\nnext: run \`ucm\` and edit scratch.ts`);
    return 0;
  }

  // migrate opens codebases the version guard would refuse
  if (cmd === "migrate") return migrate(Codebase.findRoot(cwd)) ? 0 : 1;

  const cb = Codebase.find(cwd);
  switch (cmd) {
    case "watch":
      watch(cb, into);
      return -1; // keep running
    case "check":
      return check(cb, scratch(args[0]), into) ? 0 : 1;
    case "add":
    case "update":
      return save(cb, scratch(args[0]), cmd, into) ? 0 : 1;
    case "import":
      need(1, "import <dir> [--into ns] [--update]");
      return importProject(cb, args[0]!, flags.update ? "update" : "add", into ?? "", !!flags.verbose) ? 0 : 1;
    case "verify":
      return verify(cb) ? 0 : 1;
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
        if (!name || !url) throw new UsageError("usage: ucm remote add <name> <url|path> [--token t]");
        addRemote(cb, name, url, typeof flags.token === "string" ? flags.token : undefined);
        console.log(`added remote ${name}`);
      } else if (sub === "rm") {
        if (!name) throw new UsageError("usage: ucm remote rm <name>");
        cb.store.deleteSetting(`remote.${name}`);
        console.log(`removed remote ${name}`);
      } else {
        const remotes = listRemotes(cb);
        if (!remotes.length) console.log(dim("no remotes; add one with `ucm remote add <name> <url|path>`"));
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
      const token = typeof flags.token === "string" ? flags.token : (process.env.UCM_TOKEN ?? newToken());
      const port = Number(typeof flags.port === "string" ? flags.port : 7737);
      serve(cb, { host: typeof flags.host === "string" ? flags.host : "127.0.0.1", port, token, allowRun: !flags["no-run"] });
      return -1; // keep running
    }
    case "edit":
      need(1, "edit <name>...");
      edit(cb, args, scratch(typeof flags.file === "string" ? flags.file : undefined), !!flags.force);
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
      console.log(rec.doc ?? dim("no documentation"));
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
      if (process.env.UCM_DEBUG) console.error(e.stack);
    } else throw e;
    process.exitCode = 1;
  }
}
