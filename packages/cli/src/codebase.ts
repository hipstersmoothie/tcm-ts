import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import {
  analyzeFile,
  analyzeProject,
  IR_VERSION,
  TS_VERSION,
  ucmTypeRoots,
  type Analysis,
  type AnalyzeHost,
  type DefRecord,
  type ProjectAnalysis,
  saltOf,
  scratchNamespace,
  shortHash,
} from "@ucm/core";

type SaltFor = NonNullable<AnalyzeHost["saltFor"]>;
import { Store } from "@ucm/store";
import { ensureExternals, layout, materialize, render, writeShim, type DefSource, type Layout } from "@ucm/loader";

/** A dotted codebase name: `lib.util.sort`. */
export const IDENT_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export class Codebase {
  readonly lay: Layout;
  readonly store: Store;
  private programs = new Map<string, ts.Program>();

  private constructor(root: string) {
    this.lay = layout(root);
    this.store = new Store(this.lay.dbFile);
    const versions = this.store.irVersions().filter((v) => v !== IR_VERSION);
    if (versions.length) {
      this.store.close();
      throw new Error(
        `${root} was written with hash format v${versions.join(", v")}; this ucm uses v${IR_VERSION}. ` +
          `Run \`ucm migrate\` to rebuild it (the old codebase is kept as a backup).`,
      );
    }
  }

  static find(cwd: string): Codebase {
    return new Codebase(Codebase.findRoot(cwd));
  }

  /** The nearest directory at or above `cwd` holding a codebase. */
  static findRoot(cwd: string): string {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".ucm", "codebase.sqlite"))) return dir;
      if (path.dirname(dir) === dir) throw new Error("no ucm codebase here; run `ucm init` first");
    }
  }

  static init(root: string): Codebase {
    fs.mkdirSync(path.join(root, ".ucm", "cache"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ucm", ".gitignore"), "# derived from codebase.sqlite\ncache/\ncodebase/\n");
    const pkgFile = path.join(root, "package.json");
    const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) : { name: path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-"), private: true };
    pkg.type = "module";
    pkg.imports = { ...(pkg.imports ?? {}), "#codebase": "./.ucm/codebase/index.ts", "#codebase/*": "./.ucm/codebase/*.ts" };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    const tsconfig = path.join(root, "tsconfig.json");
    if (!fs.existsSync(tsconfig)) {
      const options = {
        target: "esnext",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        typeRoots: ucmTypeRoots,
        types: ["node"],
      };
      fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: options, include: ["*.ts"] }, null, 2) + "\n");
    }
    const cb = new Codebase(root);
    cb.refreshShim(true);
    return cb;
  }

  /** Definitions from the store, overlaid with in-memory ones (scratch definitions not added yet). */
  source(overlay: DefRecord[] = []): DefSource {
    const byHash = new Map(overlay.map((d) => [d.hash, d]));
    const byComp = new Map<string, DefRecord[]>();
    for (const d of overlay) byComp.set(d.componentHash, [...(byComp.get(d.componentHash) ?? []), d]);
    return {
      get: (h) => byHash.get(h) ?? this.store.getDef(h),
      members: (c) => (byComp.get(c) ?? this.store.componentMembers(c)).sort((a, b) => a.componentIndex - b.componentIndex),
      nameOf: (h) => this.store.pathsOf(h)[0],
    };
  }

  /** Keep `.ucm/codebase` (the `#codebase` import shim) in sync with the branch's names. */
  refreshShim(force = false) {
    const stamp = `${this.store.branch().name}:${this.store.logHead()}`;
    if (!force && this.store.getSetting("shim_stamp") === stamp && fs.existsSync(path.join(this.lay.shimDir, "index.ts"))) return;
    writeShim(this.store.names(), this.source(), this.lay);
    this.store.setSetting("shim_stamp", stamp);
  }

  private host(ignoreDiagnostics: number[], saltFor: SaltFor | undefined, oldProgram?: ts.Program): AnalyzeHost {
    return {
      cacheDir: this.lay.cacheDir,
      ignoreDiagnostics,
      oldProgram,
      saltFor,
      resolveName: (name) => {
        const hs = this.store.hashesAt(name);
        if (hs.length === 0) throw new Error(`'${name}' is not in the codebase`);
        if (hs.length > 1) throw new Error(`'${name}' is conflicted (${hs.length} definitions); resolve it first (\`ucm todo\`)`);
        return hs[0]!;
      },
    };
  }

  analyze(file: string, saltFor: SaltFor | undefined, ignoreDiagnostics: number[] = []): Analysis {
    const a = analyzeFile(file, this.host(ignoreDiagnostics, saltFor, this.programs.get(file)));
    this.programs.set(file, a.program);
    return a;
  }

  analyzeProject(files: string[], saltFor: SaltFor | undefined, ignoreDiagnostics: number[] = []): ProjectAnalysis {
    return analyzeProject(files, this.host(ignoreDiagnostics, saltFor));
  }

  /**
   * The lineage salt for a definition about to be bound at `path`: whatever already lives there keeps its
   * identity (so updates and re-adds reproduce hashes), and anything new is identified by where it was first added.
   */
  lineageSalt(path: string): string {
    for (const h of this.store.hashesAt(path)) {
      const salt = saltOf(this.store.getDef(h)!.ir);
      if (salt !== undefined) return salt;
    }
    return path;
  }

  /** Salts for a scratch file whose definitions go into `into` (or the file's namespace pragma). */
  scratchSalts(into?: string): SaltFor {
    return (file, name, targetPath) => {
      if (targetPath) return this.lineageSalt(targetPath);
      const ns = into ?? scratchNamespace(fs.readFileSync(file, "utf8")) ?? "";
      return this.lineageSalt(ns ? `${ns}.${name}` : name);
    };
  }

  /** Salts for re-analyzing rendered definitions: each keeps the salt it was stored with. */
  private storedSalts(byFile: Map<string, Map<string, DefRecord>>): SaltFor {
    return (file, name) => {
      const rec = byFile.get(file)?.get(name);
      return rec && saltOf(rec.ir);
    };
  }

  /**
   * Re-render every live definition from the store and re-hash it. Rendering is supposed to be the inverse of
   * hashing, so any mismatch means stored source, splicing, or canonicalization lost information.
   */
  verify(): { checked: number; mismatches: { name: string; stored: string; rehashed: string }[]; problems: string[] } {
    const src = this.source();
    const live = this.liveHashes();
    const r = this.rehash(src, new Set([...live].map((h) => src.get(h)!.componentHash)));
    const mismatches = r.mismatches.map((m) => ({ name: this.displayRef(`#${m.stored}`), ...m }));
    return { checked: r.defs.size, mismatches, problems: r.problems };
  }

  /**
   * Render components from `src` the way they will be materialized, then typecheck and hash the result.
   * Returns the freshly analyzed definition for each stored hash.
   */
  private rehash(src: DefSource, comps: Set<string>) {
    materialize([...comps].flatMap((c) => src.members(c).map((m) => m.hash)), src, this.lay);
    const expected = new Map<string, Map<string, string>>();
    const records = new Map<string, Map<string, DefRecord>>();
    for (const c of comps) {
      const r = render(src.members(c), src, this.lay, { style: "internal" });
      const file = path.join(this.lay.cacheDir, `_verify_${c}.ts`);
      fs.writeFileSync(file, r.text);
      expected.set(file, new Map([...r.memberNames].map(([h, n]) => [n, h])));
      records.set(file, new Map([...r.memberNames].map(([h, n]) => [n, src.get(h)!])));
    }
    try {
      // untyped npm packages are fine: types were checked by whoever added the definition
      const a = this.analyzeProject([...expected.keys()], this.storedSalts(records), [7016]);
      const problems = [...a.errors, ...a.diagnostics.map((d) => d.formatted)];
      const defs = new Map<string, DefRecord>();
      const mismatches: { stored: string; rehashed: string }[] = [];
      for (const d of a.defs) {
        const stored = expected.get(d.file)?.get(d.nameHint);
        if (!stored) continue;
        defs.set(stored, d);
        if (stored !== d.hash) mismatches.push({ stored, rehashed: d.hash });
      }
      return { defs, mismatches, problems };
    } finally {
      for (const f of expected.keys()) fs.rmSync(f, { force: true });
    }
  }

  /** Components needed to run or name `hashes`: their own plus everything they reference. */
  closureComponents(hashes: Iterable<string>): Set<string> {
    const comps = new Set<string>();
    const queue = [...hashes];
    while (queue.length) {
      const rec = this.store.getDef(queue.pop()!);
      if (!rec || comps.has(rec.componentHash)) continue;
      comps.add(rec.componentHash);
      for (const m of this.store.componentMembers(rec.componentHash)) for (const d of m.deps) if (d.ref.startsWith("#")) queue.push(d.ref.slice(1));
    }
    return comps;
  }

  /**
   * Accept definitions from another codebase. Nothing is trusted: each component must be complete, every
   * reference must resolve, and rendering + typechecking + hashing locally must reproduce the claimed hashes.
   * Dependencies and signatures are taken from the local analysis, not from the sender.
   */
  receive(records: DefRecord[]): { stored: number } {
    const fresh = records.filter((r) => !this.store.hasDef(r.hash));
    if (!fresh.length) return { stored: 0 };
    const byComp = new Map<string, DefRecord[]>();
    for (const r of fresh) byComp.set(r.componentHash, [...(byComp.get(r.componentHash) ?? []), r]);
    for (const [c, ms] of byComp) {
      const indices = ms.map((m) => m.componentIndex).sort((a, b) => a - b);
      if (ms.some((m) => m.componentSize !== ms.length) || indices.some((v, i) => v !== i)) {
        throw new Error(`component ${shortHash(c)} is incomplete: got ${ms.length} member(s)`);
      }
    }
    const src = this.source(fresh);
    const reject = (why: string): never => {
      // cache modules rendered from rejected definitions must not linger under hashes they don't have
      for (const c of byComp.keys()) fs.rmSync(path.join(this.lay.cacheDir, `${c}.ts`), { force: true });
      throw new Error(`rejected definitions: ${why}`);
    };
    let r: ReturnType<Codebase["rehash"]> | undefined;
    try {
      r = this.rehash(src, new Set(byComp.keys()));
    } catch (e) {
      reject((e as Error).message);
    }
    if (r!.problems.length) reject(`they do not typecheck here:\n${r!.problems.join("\n")}`);
    const misplaced = fresh.filter((d) => {
      const local = r!.defs.get(d.hash);
      return local && (local.componentHash !== d.componentHash || local.componentIndex !== d.componentIndex);
    });
    if (r!.mismatches.length || misplaced.length || r!.defs.size !== fresh.length) {
      const bad = [
        ...r!.mismatches.map((m) => `${shortHash(m.stored)} re-hashes to ${shortHash(m.rehashed)}`),
        ...misplaced.map((d) => `${shortHash(d.hash)} claims the wrong component`),
      ];
      reject(`their source does not match their hashes (${bad.join(", ") || "missing members"})`);
    }
    this.putDefs(fresh.map((d) => ({ ...d, deps: r!.defs.get(d.hash)!.deps, signature: r!.defs.get(d.hash)!.signature })));
    return { stored: fresh.length };
  }

  putDefs(defs: DefRecord[]) {
    this.store.putDefs(defs, TS_VERSION, IR_VERSION);
  }

  /** Resolve `name` or `#hashprefix` to hashes. */
  lookup(target: string): string[] {
    if (target.startsWith("#")) return this.store.hashesWithPrefix(target.slice(1));
    return this.store.hashesAt(target);
  }

  lookupOne(target: string): string {
    const hs = this.lookup(target);
    if (hs.length === 0) throw new Error(`'${target}' not found`);
    if (hs.length > 1) throw new Error(`'${target}' is ambiguous (${hs.length} definitions)`);
    return hs[0]!;
  }

  displayRef(ref: string): string {
    if (!ref.startsWith("#")) return ref;
    const h = ref.slice(1);
    return this.store.pathsOf(h)[0] ?? `#${h.slice(0, 8)}`;
  }

  /** Every hash reachable from a name on the current branch. */
  liveHashes(): Set<string> {
    const live = new Set<string>();
    const queue = this.store.names().map((n) => n.hash);
    while (queue.length) {
      const h = queue.pop()!;
      if (live.has(h)) continue;
      live.add(h);
      for (const d of this.store.getDef(h)?.deps ?? []) if (d.ref.startsWith("#")) queue.push(d.ref.slice(1));
    }
    return live;
  }

  /**
   * After names moved to new hashes (`patches`: old → new), re-derive every live dependent:
   * re-render its stored source against the patched references, typecheck, and re-hash.
   * Dependents that no longer typecheck go to `todo` and keep their old hash.
   */
  propagate(patches: Map<string, string>, exclude: Set<string>): { updated: string[]; failed: string[] } {
    const { store, lay } = this;
    const live = this.liveHashes();
    const affected = new Set<string>();
    const queue = [...patches.keys()];
    while (queue.length) {
      for (const dep of store.dependents(queue.pop()!)) {
        if (live.has(dep) && !patches.has(dep) && !exclude.has(dep) && !affected.has(dep)) {
          affected.add(dep);
          queue.push(dep);
        }
      }
    }

    const comps = new Map<string, DefRecord[]>();
    for (const h of affected) {
      const c = store.getDef(h)!.componentHash;
      if (!comps.has(c)) comps.set(c, store.componentMembers(c));
    }
    const compOf = new Map<string, string>();
    for (const [c, ms] of comps) for (const m of ms) compOf.set(m.hash, c);
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (c: string) => {
      if (seen.has(c)) return;
      seen.add(c);
      for (const m of comps.get(c)!) for (const d of m.deps) {
        const dc = d.ref.startsWith("#") ? compOf.get(d.ref.slice(1)) : undefined;
        if (dc && dc !== c) visit(dc);
      }
      order.push(c);
    };
    [...comps.keys()].forEach(visit);

    const resolve = (h: string) => {
      for (let i = 0; i < 1000 && patches.has(h); i++) h = patches.get(h)!;
      return h;
    };
    const updated: string[] = [];
    const failed = new Set<string>();
    for (const c of order) {
      const members = comps.get(c)!;
      const memberSet = new Set(members.map((m) => m.hash));
      const blocker = members.flatMap((m) => m.deps).find((d) => d.ref.startsWith("#") && failed.has(d.ref.slice(1)));
      if (blocker) {
        for (const m of members) {
          failed.add(m.hash);
          store.setTodo(m.hash, `depends on ${this.displayRef(blocker.ref)}, which needs fixing`);
        }
        continue;
      }
      const src = this.source();
      const deps = members.flatMap((m) => m.spans.filter((s) => s.hash && !memberSet.has(s.hash)).map((s) => resolve(s.hash!)));
      materialize(deps, src, lay);
      ensureExternals(lay, members.flatMap((m) => m.spans.flatMap((s) => (s.ext ? [s.ext] : []))));
      const rendered = render(members, src, lay, { style: "internal", remap: resolve });
      const tmp = path.join(lay.cacheDir, `_update_${c}.ts`);
      fs.writeFileSync(tmp, rendered.text);
      // untyped npm packages are fine here: the definition was already checked against their types when added
      const salts = this.storedSalts(new Map([[tmp, new Map([...rendered.memberNames].map(([h, n]) => [n, src.get(h)!]))]]));
      const a = this.analyze(tmp, salts, [7016]);
      this.programs.delete(tmp);
      fs.rmSync(tmp);
      const problem = a.errors[0] ?? a.diagnostics[0]?.message;
      if (problem) {
        for (const m of members) {
          failed.add(m.hash);
          store.setTodo(m.hash, problem);
        }
        continue;
      }
      const oldByName = new Map([...rendered.memberNames].map(([h, n]) => [n, h]));
      this.putDefs(a.defs);
      store.transaction(() => {
        for (const d of a.defs) {
          const old = oldByName.get(d.nameHint);
          if (!old) continue;
          store.clearTodo(old);
          if (d.hash === old) continue;
          patches.set(old, d.hash);
          store.addPatch(old, d.hash);
          for (const p of store.pathsOf(old)) {
            // only this hash moves: a conflicted name keeps its other definitions
            store.replaceName(p, old, d.hash, d.kind, "update (propagated)");
            updated.push(p);
          }
        }
      });
    }
    return { updated, failed: [...failed] };
  }
}
