import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sameSpace, type DefKind, type DefRecord, type Dep, type InitKind, type RefPos, type Span } from "@tcm/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS components (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, ir_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS definitions (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('term','type','class')),
  component_hash TEXT NOT NULL REFERENCES components(hash),
  component_index INTEGER NOT NULL,
  ir TEXT NOT NULL,
  source_text TEXT NOT NULL,
  ref_spans TEXT NOT NULL,
  reserved_names TEXT NOT NULL,
  init_kind TEXT NOT NULL CHECK (init_kind IN ('hoisted','strict')),
  name_hint TEXT NOT NULL,
  nominal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS definitions_by_component ON definitions(component_hash, component_index);
CREATE TABLE IF NOT EXISTS deps (
  from_hash TEXT NOT NULL, to_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('value','type')), strict INTEGER NOT NULL,
  PRIMARY KEY (from_hash, to_ref, ref_kind)
);
CREATE INDEX IF NOT EXISTS deps_by_target ON deps(to_ref);
CREATE TABLE IF NOT EXISTS externals (ref TEXT PRIMARY KEY, module TEXT NOT NULL, subpath TEXT NOT NULL, export_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signatures (hash TEXT PRIMARY KEY, display TEXT NOT NULL, ts_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (hash TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (hash, key));
CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, head TEXT NOT NULL);
-- history, as Unison keeps it: a namespace is a tree of nodes hashed from their names and children, and a causal
-- is a namespace state with the causals it came from; a branch is a pointer to its head causal. Hashes don't
-- depend on which codebase made them, so two codebases share history by sending what the other lacks.
CREATE TABLE IF NOT EXISTS namespaces (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS causals (hash TEXT PRIMARY KEY, namespace TEXT NOT NULL, ts INTEGER NOT NULL, command TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS causal_parents (child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY (child, parent));
CREATE INDEX IF NOT EXISTS causal_children ON causal_parents(parent);
-- contributions: a branch proposed for merging into another, with its review (Unison Share's, on tcm serve)
CREATE TABLE IF NOT EXISTS contributions (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
  author TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','merged','closed')), created INTEGER NOT NULL,
  updated INTEGER NOT NULL, merged_from TEXT, merged_as TEXT
);
-- releases: a package's version names a point in history, for good (the package being the namespace it was then);
-- its notes are markdown kept with it
CREATE TABLE IF NOT EXISTS releases (
  package TEXT NOT NULL, version TEXT NOT NULL, namespace TEXT NOT NULL, causal TEXT NOT NULL, notes TEXT NOT NULL,
  author TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (package, version)
);
CREATE TABLE IF NOT EXISTS contribution_comments (
  id INTEGER PRIMARY KEY, contribution INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, about TEXT, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS names (branch_id INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (branch_id, path, hash));
CREATE INDEX IF NOT EXISTS names_by_hash ON names(branch_id, hash);
CREATE TABLE IF NOT EXISTS name_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('add','delete','update')),
  path TEXT NOT NULL, old_hash TEXT, new_hash TEXT, kind TEXT NOT NULL, command TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS patches (branch_id INTEGER NOT NULL, old_hash TEXT NOT NULL, new_hash TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (branch_id, old_hash));
CREATE TABLE IF NOT EXISTS todo (branch_id INTEGER NOT NULL, hash TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (branch_id, hash));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- the package lock: definitions pin a package by compatible range (npm:ms@2); the codebase runs one version of each
-- integrity: the registry's hash of the version's tarball (sha512-…), recorded when first installed and checked after
CREATE TABLE IF NOT EXISTS packages (name TEXT NOT NULL, range TEXT NOT NULL, version TEXT NOT NULL, integrity TEXT, PRIMARY KEY (name, range));
CREATE TABLE IF NOT EXISTS test_results (
  hash TEXT NOT NULL, node_version TEXT NOT NULL, ok INTEGER NOT NULL, message TEXT NOT NULL,
  output TEXT NOT NULL, duration_ms INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (hash, node_version)
);
-- oxlint's findings for a definition, by the linter version and configuration they were found with
CREATE TABLE IF NOT EXISTS lint_results (hash TEXT NOT NULL, key TEXT NOT NULL, issues TEXT NOT NULL, PRIMARY KEY (hash, key));
CREATE TABLE IF NOT EXISTS watch_results (
  hash TEXT NOT NULL, node_version TEXT NOT NULL, ok INTEGER NOT NULL, value TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (hash, node_version)
);
`;

export interface NameRow {
  path: string;
  hash: string;
  kind: DefKind;
}

export interface TestResult {
  hash: string;
  ok: boolean;
  message: string;
  /** console output captured while the test ran */
  output: string;
  ms: number;
}

export interface LogEntry {
  id: number;
  /** entries written by one command share a batch */
  batch: number;
  ts: number;
  op: "add" | "delete" | "update";
  path: string;
  oldHash: string | null;
  newHash: string | null;
  kind: DefKind;
  command: string;
}

type Row = Record<string, string | number | null>;

/** A point in history: a namespace state, the causals it was made from, and (not hashed) what made it, when. */
export interface Causal {
  hash: string;
  namespace: string;
  parents: string[];
  ts: number;
  command: string;
}

/** A branch proposed for merging into another. */
export interface Contribution {
  id: number;
  title: string;
  description: string;
  /** the branch with the changes, and the one they're proposed for */
  source: string;
  target: string;
  author: string;
  status: "open" | "merged" | "closed";
  created: number;
  updated: number;
  /** once merged: the target's head before, and the history entry the merge made it */
  mergedFrom: string | null;
  mergedAs: string | null;
}

/** A package's version: an immutable name for a history entry, with its release notes (markdown). */
export interface Release {
  package: string;
  version: string;
  /** where the package was, in that entry's namespace */
  namespace: string;
  causal: string;
  notes: string;
  author: string;
  ts: number;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
  /** the definition (name) it's about, if any */
  about: string | null;
  ts: number;
}

/** A namespace node: `["ns", [[name, [hashes]]...], [[child, nodeHash]...]]`, both lists sorted by name. */
type NamespaceBody = ["ns", [string, string[]][], [string, string][]];

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function hash32(domain: string, text: string): string {
  const bytes = createHash("sha256").update(`${domain}\0${text}`).digest();
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The hash of a namespace node's body. */
export const namespaceHash = (body: string) => hash32("tcm-namespace-v1", body);
/** A causal's hash: its namespace and its parents (in order of hash), nothing else. */
export const causalHash = (namespace: string, parents: string[]) => hash32("tcm-causal-v1", JSON.stringify(["causal", namespace, [...new Set(parents)].sort()]));

const EMPTY_BODY = JSON.stringify(["ns", [], []] satisfies NamespaceBody);
/** The empty namespace, and the causal every history starts from: the same in every codebase. */
export const EMPTY_NAMESPACE = namespaceHash(EMPTY_BODY);
export const ROOT_CAUSAL = causalHash(EMPTY_NAMESPACE, []);

/** The JSX runtime a definition compiles to: part of its IR (and so its hash), read from there. */
function jsxOf(ir: string): { jsx?: string } {
  const m = /^\["Def","[^"]*"(?:,\["Salt","[^"]*"\])?,\["Jsx","([^"]+)"\]/.exec(ir);
  return m ? { jsx: m[1]! } : {};
}

export class Store {
  readonly db: DatabaseSync;
  private branchCache: { id: number; name: string } | undefined;
  /** one batch per Store instance (per CLI command), or per editor command (endBatch); allocated on the first logged change */
  private batch: number | undefined;
  /** branches whose names changed since their head causal was made */
  private dirty = new Set<number>();
  /** causals this batch made, by branch: a command's changes are one causal however many transactions it takes */
  private made = new Map<number, string>();
  /** extra parents for a branch's next causal (what a merge brought in) */
  private pendingParents = new Map<number, Set<string>>();
  private depth = 0;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO namespaces (hash, body) VALUES (?, ?)").run(EMPTY_NAMESPACE, EMPTY_BODY);
    this.db.prepare("INSERT OR IGNORE INTO causals (hash, namespace, ts, command) VALUES (?, ?, 0, 'init')").run(ROOT_CAUSAL, EMPTY_NAMESPACE);
    this.db.prepare("INSERT OR IGNORE INTO branches (name, head) VALUES ('main', ?)").run(ROOT_CAUSAL);
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('branch', 'main')").run();
  }

  close() {
    this.db.close();
  }

  /** Run `fn` in a transaction (joining the enclosing one, if any); branches it changed get a new head causal. */
  transaction<T>(fn: () => T): T {
    if (this.depth) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN");
    this.depth = 1;
    try {
      const r = fn();
      this.commitHistory();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.dirty.clear();
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  /**
   * End this batch: the next change starts a new history entry. A CLI command is one batch; the language server,
   * which lives across many commands, ends one after each.
   */
  endBatch() {
    this.batch = undefined;
    this.made.clear();
  }

  // ---- content ---------------------------------------------------------------

  putDefs(records: DefRecord[], tsVersion: string, irVersion: number) {
    const now = Date.now();
    const comp = this.db.prepare("INSERT OR IGNORE INTO components (hash, size, ir_version, created_at) VALUES (?, ?, ?, ?)");
    const def = this.db.prepare(
      `INSERT OR IGNORE INTO definitions (hash, kind, component_hash, component_index, ir, source_text, ref_spans, reserved_names, init_kind, name_hint, nominal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const dep = this.db.prepare("INSERT OR IGNORE INTO deps (from_hash, to_ref, ref_kind, strict) VALUES (?, ?, ?, ?)");
    const ext = this.db.prepare("INSERT OR IGNORE INTO externals (ref, module, subpath, export_name) VALUES (?, ?, ?, ?)");
    const sig = this.db.prepare("INSERT OR IGNORE INTO signatures (hash, display, ts_version) VALUES (?, ?, ?)");
    const meta = this.db.prepare("INSERT OR IGNORE INTO metadata (hash, key, value) VALUES (?, ?, ?)");
    this.transaction(() => {
      for (const r of records) {
        comp.run(r.componentHash, r.componentSize, irVersion, now);
        const inserted = def.run(
          r.hash, r.kind, r.componentHash, r.componentIndex, r.ir, r.sourceText,
          JSON.stringify(r.spans), JSON.stringify(r.reservedNames), r.initKind, r.nameHint, r.nominal ? 1 : 0,
        );
        if (!inserted.changes) continue; // identical definition already stored: first text wins
        for (const d of r.deps) dep.run(r.hash, d.ref, d.pos, d.strict ? 1 : 0);
        for (const s of r.spans) if (s.ext) ext.run(`${s.ext.module}${s.ext.subpath ? "/" + s.ext.subpath : ""}#${s.ext.export}`, s.ext.module, s.ext.subpath, s.ext.export);
        sig.run(r.hash, r.signature, tsVersion);
        if (r.doc) meta.run(r.hash, "doc", r.doc);
        if (r.params) meta.run(r.hash, "params", JSON.stringify(r.params));
        if (r.shape) meta.run(r.hash, "shape", JSON.stringify(r.shape));
        if (r.docRefs?.length) meta.run(r.hash, "docRefs", JSON.stringify(r.docRefs));
        if (r.table) meta.run(r.hash, "table", JSON.stringify(r.table));
        if (r.transform) meta.run(r.hash, "transform", "1");
        if (r.checked) meta.run(r.hash, "checked", JSON.stringify(r.checked));
        if (r.globalNames) meta.run(r.hash, "globals", JSON.stringify(r.globalNames));
      }
    });
  }

  /** Hash format versions of stored definitions. */
  irVersions(): number[] {
    return (this.db.prepare("SELECT DISTINCT ir_version AS v FROM components").all() as { v: number }[]).map((r) => r.v);
  }

  getMetadata(hash: string, key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM metadata WHERE hash = ? AND key = ?").get(hash, key) as { value: string } | undefined)?.value;
  }

  setMetadata(hash: string, key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO metadata (hash, key, value) VALUES (?, ?, ?)").run(hash, key, value);
  }

  hasDef(hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM definitions WHERE hash = ?").get(hash);
  }

  getDef(hash: string): DefRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT d.*, c.size, s.display, m.value AS doc, p.value AS params, t.value AS table_schema, x.value AS transform, k.value AS checked, g.value AS globals, sh.value AS shape, dr.value AS doc_refs FROM definitions d
         JOIN components c ON c.hash = d.component_hash
         LEFT JOIN signatures s ON s.hash = d.hash
         LEFT JOIN metadata m ON m.hash = d.hash AND m.key = 'doc'
         LEFT JOIN metadata p ON p.hash = d.hash AND p.key = 'params'
         LEFT JOIN metadata t ON t.hash = d.hash AND t.key = 'table'
         LEFT JOIN metadata x ON x.hash = d.hash AND x.key = 'transform'
         LEFT JOIN metadata k ON k.hash = d.hash AND k.key = 'checked'
         LEFT JOIN metadata g ON g.hash = d.hash AND g.key = 'globals'
         LEFT JOIN metadata sh ON sh.hash = d.hash AND sh.key = 'shape'
         LEFT JOIN metadata dr ON dr.hash = d.hash AND dr.key = 'docRefs'
         WHERE d.hash = ?`,
      )
      .get(hash) as Row | undefined;
    return row && this.toRecord(row);
  }

  componentMembers(componentHash: string): DefRecord[] {
    const hashes = this.db
      .prepare("SELECT hash FROM definitions WHERE component_hash = ? ORDER BY component_index")
      .all(componentHash) as { hash: string }[];
    return hashes.map((h) => this.getDef(h.hash)!);
  }

  private toRecord(row: Row): DefRecord {
    const deps = (this.db.prepare("SELECT to_ref, ref_kind, strict FROM deps WHERE from_hash = ?").all(row.hash) as Row[]).map(
      (d): Dep => ({ ref: d.to_ref as string, pos: d.ref_kind as RefPos, strict: d.strict === 1 }),
    );
    return {
      hash: row.hash as string,
      kind: row.kind as DefKind,
      componentHash: row.component_hash as string,
      componentIndex: row.component_index as number,
      componentSize: row.size as number,
      ir: row.ir as string,
      sourceText: row.source_text as string,
      spans: JSON.parse(row.ref_spans as string) as Span[],
      reservedNames: JSON.parse(row.reserved_names as string) as string[],
      initKind: row.init_kind as InitKind,
      nameHint: row.name_hint as string,
      nominal: row.nominal === 1,
      deps,
      signature: (row.display as string | null) ?? "?",
      doc: (row.doc as string | null) ?? undefined,
      params: row.params ? JSON.parse(row.params as string) : undefined,
      ...(row.shape ? { shape: JSON.parse(row.shape as string) } : {}),
      ...(row.doc_refs ? { docRefs: JSON.parse(row.doc_refs as string) } : {}),
      table: row.table_schema ? JSON.parse(row.table_schema as string) : undefined,
      ...(row.transform ? { transform: true } : {}),
      ...jsxOf(row.ir as string),
      ...(row.checked ? { checked: JSON.parse(row.checked as string) } : {}),
      ...(row.globals ? { globalNames: JSON.parse(row.globals as string) } : {}),
    };
  }

  /** Full hashes starting with a prefix. */
  hashesWithPrefix(prefix: string): string[] {
    return (this.db.prepare("SELECT hash FROM definitions WHERE hash LIKE ? LIMIT 10").all(`${prefix}%`) as { hash: string }[]).map((r) => r.hash);
  }

  /** Hashes of stored definitions that reference `hash`. */
  dependents(hash: string): string[] {
    return (this.db.prepare("SELECT DISTINCT from_hash FROM deps WHERE to_ref = ?").all(`#${hash}`) as { from_hash: string }[]).map((r) => r.from_hash);
  }

  // ---- branches --------------------------------------------------------------

  branch(): { id: number; name: string } {
    if (!this.branchCache) {
      const name = (this.db.prepare("SELECT value FROM settings WHERE key = 'branch'").get() as { value: string }).value;
      const row = this.db.prepare("SELECT id FROM branches WHERE name = ?").get(name) as { id: number };
      this.branchCache = { id: row.id, name };
    }
    return this.branchCache;
  }

  /** Re-read the current branch on next use (another process may have switched it). */
  forgetBranch() {
    this.branchCache = undefined;
  }

  branches(): string[] {
    return (this.db.prepare("SELECT name FROM branches ORDER BY id").all() as { name: string }[]).map((r) => r.name);
  }

  createBranch(name: string) {
    const from = this.branch();
    this.transaction(() => {
      const { lastInsertRowid } = this.db.prepare("INSERT INTO branches (name, head) VALUES (?, ?)").run(name, this.head(from.name));
      this.db.prepare("INSERT INTO names (branch_id, path, hash, kind) SELECT ?, path, hash, kind FROM names WHERE branch_id = ?").run(lastInsertRowid, from.id);
      this.db.prepare("INSERT INTO patches (branch_id, old_hash, new_hash, ts) SELECT ?, old_hash, new_hash, ts FROM patches WHERE branch_id = ?").run(lastInsertRowid, from.id);
    });
  }

  switchBranch(name: string) {
    if (!this.db.prepare("SELECT 1 FROM branches WHERE name = ?").get(name)) throw new Error(`no branch named '${name}'`);
    this.db.prepare("UPDATE settings SET value = ? WHERE key = 'branch'").run(name);
    this.branchCache = undefined;
  }

  // ---- names -----------------------------------------------------------------

  names(branch?: string): NameRow[] {
    const id = branch === undefined ? this.branch().id : this.branchId(branch);
    return this.db.prepare("SELECT path, hash, kind FROM names WHERE branch_id = ? ORDER BY path, hash").all(id) as unknown as NameRow[];
  }

  private branchId(name: string): number {
    const row = this.db.prepare("SELECT id FROM branches WHERE name = ?").get(name) as { id: number } | undefined;
    if (!row) throw new Error(`no branch named '${name}'`);
    return row.id;
  }

  ensureBranch(name: string) {
    this.db.prepare("INSERT OR IGNORE INTO branches (name, head) VALUES (?, ?)").run(name, ROOT_CAUSAL);
  }

  /** Fingerprint of a branch's namespace, for detecting concurrent changes during sync. */
  stateHash(branch?: string): string {
    return stateHashOf(this.names(branch));
  }

  /** Make `branch` name exactly `rows`, logging each change on that branch (a new causal follows). */
  setBranchNames(branch: string, rows: NameRow[], command: string): { added: number; removed: number } {
    this.ensureBranch(branch);
    const id = this.branchId(branch);
    return this.transaction(() => this.replaceBranchNames(id, rows, command));
  }

  hasBranch(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM branches WHERE name = ?").get(name);
  }

  /** Hashes named `path`; with `kind`, only those in the same space (a type and a value can share a path). */
  hashesAt(path: string, kind?: DefKind): string[] {
    const rows = this.db.prepare("SELECT hash, kind FROM names WHERE branch_id = ? AND path = ? ORDER BY hash").all(this.branch().id, path) as { hash: string; kind: DefKind }[];
    return rows.filter((r) => kind === undefined || sameSpace(r.kind, kind)).map((r) => r.hash);
  }

  /** Point `path` at `newHash` instead of `oldHashes`, leaving other hashes on it (the other space) alone. */
  replaceNames(path: string, oldHashes: string[], newHash: string, kind: DefKind, command: string) {
    this.transaction(() => {
      const b = this.branch().id;
      for (const o of oldHashes) this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(b, path, o);
      this.db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, newHash, kind);
      for (const o of oldHashes.length ? oldHashes : [null]) this.log("update", path, o, newHash, kind, command);
    });
  }

  pathsOf(hash: string): string[] {
    return (this.db.prepare("SELECT path FROM names WHERE branch_id = ? AND hash = ? ORDER BY path").all(this.branch().id, hash) as { path: string }[]).map((r) => r.path);
  }

  addName(path: string, hash: string, kind: DefKind, command: string) {
    this.transaction(() => {
      const b = this.branch().id;
      const r = this.db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, hash, kind);
      if (r.changes) this.log("add", path, null, hash, kind, command);
    });
  }

  removeName(path: string, hash: string, command: string) {
    this.transaction(() => {
      const b = this.branch().id;
      const row = this.db.prepare("SELECT kind FROM names WHERE branch_id = ? AND path = ? AND hash = ?").get(b, path, hash) as { kind: DefKind } | undefined;
      if (!row) return;
      this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(b, path, hash);
      this.log("delete", path, hash, null, row.kind, command);
    });
  }

  /** Point `path` at `newHash`, replacing whatever it pointed to. */
  updateName(path: string, newHash: string, kind: DefKind, command: string) {
    this.transaction(() => {
      const b = this.branch().id;
      const old = this.hashesAt(path);
      this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ?").run(b, path);
      this.db.prepare("INSERT INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, newHash, kind);
      for (const o of old.length ? old : [null]) this.log("update", path, o, newHash, kind, command);
    });
  }

  /** Swap one hash on `path` for another, leaving any other hashes there (a conflict) alone. */
  replaceName(path: string, oldHash: string, newHash: string, kind: DefKind, command: string) {
    this.transaction(() => {
      const b = this.branch().id;
      const r = this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(b, path, oldHash);
      if (!r.changes) return;
      this.db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, newHash, kind);
      this.log("update", path, oldHash, newHash, kind, command);
    });
  }

  private log(op: LogEntry["op"], path: string, oldHash: string | null, newHash: string | null, kind: DefKind, command: string, branchId = this.branch().id) {
    this.dirty.add(branchId);
    this.batch ??= ((this.db.prepare("SELECT coalesce(max(batch), 0) + 1 AS b FROM name_log").get() as { b: number }).b);
    this.db
      .prepare("INSERT INTO name_log (branch_id, ts, op, path, old_hash, new_hash, kind, command, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(branchId, Date.now(), op, path, oldHash, newHash, kind, command, this.batch);
  }

  // ---- history ---------------------------------------------------------------

  /** A branch's head causal (default: the current branch's). */
  head(branch?: string): string {
    const id = branch === undefined ? this.branch().id : this.branchId(branch);
    return (this.db.prepare("SELECT head FROM branches WHERE id = ?").get(id) as { head: string }).head;
  }

  causal(hash: string): Causal | undefined {
    const row = this.db.prepare("SELECT * FROM causals WHERE hash = ?").get(hash) as Row | undefined;
    if (!row) return undefined;
    // in the order they were recorded: a merge's own branch first
    const parents = (this.db.prepare("SELECT parent FROM causal_parents WHERE child = ? ORDER BY rowid").all(hash) as { parent: string }[]).map((r) => r.parent);
    return { hash, namespace: row.namespace as string, parents, ts: row.ts as number, command: row.command as string };
  }

  hasCausal(hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM causals WHERE hash = ?").get(hash);
  }

  /** Causals whose hash starts with `prefix`. */
  causalsWithPrefix(prefix: string): string[] {
    return (this.db.prepare("SELECT hash FROM causals WHERE hash LIKE ? LIMIT 10").all(`${prefix}%`) as { hash: string }[]).map((r) => r.hash);
  }

  /** Store a namespace for these names, node by node; its hash. */
  namespaceOf(rows: { path: string; hash: string }[]): string {
    interface Tree {
      names: Map<string, Set<string>>;
      children: Map<string, Tree>;
    }
    const tree = (): Tree => ({ names: new Map(), children: new Map() });
    const root = tree();
    for (const r of rows) {
      const segs = r.path.split(".");
      let t = root;
      for (const seg of segs.slice(0, -1)) {
        if (!t.children.has(seg)) t.children.set(seg, tree());
        t = t.children.get(seg)!;
      }
      const last = segs.at(-1)!;
      t.names.set(last, (t.names.get(last) ?? new Set()).add(r.hash));
    }
    const put = this.db.prepare("INSERT OR IGNORE INTO namespaces (hash, body) VALUES (?, ?)");
    const write = (t: Tree): string => {
      const names = [...t.names].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, hs]): [string, string[]] => [n, [...hs].sort()]);
      const children = [...t.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, c]): [string, string] => [n, write(c)]);
      const body = JSON.stringify(["ns", names, children] satisfies NamespaceBody);
      const h = namespaceHash(body);
      put.run(h, body);
      return h;
    };
    return write(root);
  }

  /** The names a stored namespace holds, with each definition's kind. */
  namespaceRows(namespace: string): NameRow[] {
    const kind = this.db.prepare("SELECT kind FROM definitions WHERE hash = ?");
    const out: NameRow[] = [];
    const walk = (h: string, prefix: string) => {
      const row = this.db.prepare("SELECT body FROM namespaces WHERE hash = ?").get(h) as { body: string } | undefined;
      if (!row) throw new Error(`namespace ${h.slice(0, 8)} is missing from this codebase`);
      const [, names, children] = JSON.parse(row.body) as NamespaceBody;
      for (const [n, hs] of names) for (const d of hs) out.push({ path: prefix + n, hash: d, kind: ((kind.get(d) as { kind: DefKind } | undefined)?.kind ?? "term") as DefKind });
      for (const [n, c] of children) walk(c, `${prefix}${n}.`);
    };
    walk(namespace, "");
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.hash < b.hash ? -1 : 1));
  }

  /** Record a causal (its hash follows from namespace and parents); returns the hash. */
  putCausal(namespace: string, parents: string[], ts: number, command: string): string {
    const h = causalHash(namespace, parents);
    const r = this.db.prepare("INSERT OR IGNORE INTO causals (hash, namespace, ts, command) VALUES (?, ?, ?, ?)").run(h, namespace, ts, command);
    if (r.changes) for (const p of new Set(parents)) this.db.prepare("INSERT OR IGNORE INTO causal_parents (child, parent) VALUES (?, ?)").run(h, p);
    return h;
  }

  /** Make the next causal on the current branch also descend from `causal` (a merge brings its history in). */
  addParent(causal: string) {
    const b = this.branch().id;
    this.pendingParents.set(b, (this.pendingParents.get(b) ?? new Set()).add(causal));
    this.dirty.add(b);
  }

  /**
   * A new head causal for each branch whose names changed. Within a batch (a command) there is one: a later
   * transaction replaces the causal an earlier one made, keeping its parents.
   */
  private commitHistory() {
    for (const id of this.dirty) {
      const name = (this.db.prepare("SELECT name FROM branches WHERE id = ?").get(id) as { name: string } | undefined)?.name;
      if (name === undefined) continue;
      const head = this.head(name);
      const current = this.causal(head)!;
      const namespace = this.namespaceOf(this.names(name));
      const extra = [...(this.pendingParents.get(id) ?? [])].filter((p) => p !== head);
      if (namespace === current.namespace && !extra.length) continue;
      const mine = this.made.get(id) === head;
      const parents = [...new Set([...(mine ? current.parents : [head]), ...extra])];
      const command = mine ? current.command : this.batchCommand(id);
      const next = this.putCausal(namespace, parents, Date.now(), command);
      this.db.prepare("UPDATE branches SET head = ? WHERE id = ?").run(next, id);
      // the causal this one replaces was only ever this batch's: drop it unless something else points at it
      if (mine && next !== head && !this.db.prepare("SELECT 1 FROM branches WHERE head = ?").get(head) && !this.db.prepare("SELECT 1 FROM causal_parents WHERE parent = ?").get(head)) {
        this.db.prepare("DELETE FROM causal_parents WHERE child = ?").run(head);
        this.db.prepare("DELETE FROM causals WHERE hash = ?").run(head);
      }
      this.made.set(id, next);
      this.pendingParents.delete(id);
    }
    this.dirty.clear();
  }

  /** The command that made this batch's changes on a branch: the first logged. */
  private batchCommand(branchId: number): string {
    const row = this.db.prepare("SELECT command FROM name_log WHERE branch_id = ? AND batch = ? ORDER BY id LIMIT 1").get(branchId, this.batch ?? -1) as { command: string } | undefined;
    return row?.command ?? "change";
  }

  /**
   * Point a branch at a causal this codebase has: its names become that causal's namespace (logged as changes,
   * like any), and its head becomes that causal, with no new history entry.
   */
  setHead(branch: string, causal: string, command: string) {
    const c = this.causal(causal);
    if (!c) throw new Error(`no history entry ${causal.slice(0, 8)} in this codebase`);
    this.ensureBranch(branch);
    const id = this.branchId(branch);
    this.transaction(() => {
      this.replaceBranchNames(id, this.namespaceRows(c.namespace), command);
      this.db.prepare("UPDATE branches SET head = ? WHERE id = ?").run(causal, id);
      this.dirty.delete(id);
      this.made.delete(id);
    });
  }

  /** Whether `ancestor` is `of` or in its history. */
  isAncestor(ancestor: string, of: string): boolean {
    if (ancestor === of || ancestor === ROOT_CAUSAL) return true;
    const parents = this.db.prepare("SELECT parent FROM causal_parents WHERE child = ?");
    const seen = new Set<string>();
    const queue = [of];
    while (queue.length) {
      const h = queue.pop()!;
      if (h === ancestor) return true;
      if (seen.has(h)) continue;
      seen.add(h);
      for (const r of parents.all(h) as { parent: string }[]) queue.push(r.parent);
    }
    return false;
  }

  /** Every causal in a causal's history, itself included (newest first, by time). */
  ancestors(of: string): string[] {
    const parents = this.db.prepare("SELECT parent FROM causal_parents WHERE child = ?");
    const seen = new Set<string>();
    const queue = [of];
    while (queue.length) {
      const h = queue.pop()!;
      if (seen.has(h) || !this.hasCausal(h)) continue;
      seen.add(h);
      for (const r of parents.all(h) as { parent: string }[]) queue.push(r.parent);
    }
    return [...seen];
  }

  /**
   * The best common ancestor of two causals, which a three-way merge starts from: one both histories contain
   * that isn't behind another such one. With several (criss-cross merges), the newest.
   */
  mergeBase(a: string, b: string): string {
    const inA = new Set(this.ancestors(a));
    const parents = this.db.prepare("SELECT parent FROM causal_parents WHERE child = ?");
    const candidates: string[] = [];
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const h = queue.shift()!;
      if (seen.has(h)) continue;
      seen.add(h);
      if (inA.has(h)) {
        candidates.push(h);
        continue;
      }
      for (const r of parents.all(h) as { parent: string }[]) queue.push(r.parent);
    }
    const best = candidates.filter((c) => !candidates.some((o) => o !== c && this.isAncestor(c, o)));
    return best.map((h) => this.causal(h)!).sort((x, y) => y.ts - x.ts)[0]?.hash ?? ROOT_CAUSAL;
  }

  /**
   * A branch's history from its head back, first parents only: what happened on it, with each merge as one step.
   * A merge's first parent is the head of the branch it was made on.
   */
  causalLog(limit = 50, branch?: string): Causal[] {
    const out: Causal[] = [];
    for (let h: string | undefined = this.head(branch); h && out.length < limit; h = out.at(-1)!.parents[0]) {
      const c = this.causal(h);
      if (!c) break;
      out.push(c);
    }
    return out;
  }

  // ---- history, between codebases -------------------------------------------

  missingCausals(hashes: string[]): string[] {
    return hashes.filter((h) => !this.hasCausal(h));
  }

  missingNamespaces(hashes: string[]): string[] {
    const q = this.db.prepare("SELECT 1 FROM namespaces WHERE hash = ?");
    return hashes.filter((h) => !q.get(h));
  }

  getCausals(hashes: string[]): Causal[] {
    return hashes.map((h) => this.causal(h)).filter((c): c is Causal => !!c);
  }

  getNamespaces(hashes: string[]): { hash: string; body: string }[] {
    const q = this.db.prepare("SELECT body FROM namespaces WHERE hash = ?");
    return hashes.flatMap((h) => {
      const r = q.get(h) as { body: string } | undefined;
      return r ? [{ hash: h, body: r.body }] : [];
    });
  }

  /** The nodes a namespace node points at. */
  namespaceChildren(hash: string): string[] {
    const r = this.db.prepare("SELECT body FROM namespaces WHERE hash = ?").get(hash) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as NamespaceBody)[2].map(([, c]) => c) : [];
  }

  /** The definitions a namespace node names directly. */
  namespaceDefinitions(hash: string): string[] {
    const r = this.db.prepare("SELECT body FROM namespaces WHERE hash = ?").get(hash) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as NamespaceBody)[1].flatMap(([, hs]) => hs) : [];
  }

  /** Namespace nodes from another codebase: each must hash to what it claims, and be well formed. */
  putNamespaces(rows: { hash: string; body: string }[]) {
    this.transaction(() => {
      for (const r of rows) {
        if (namespaceHash(r.body) !== r.hash) throw new Error(`namespace ${String(r.hash).slice(0, 8)} doesn't hash to its claimed hash`);
        const b = JSON.parse(r.body) as NamespaceBody;
        if (b[0] !== "ns" || !Array.isArray(b[1]) || !Array.isArray(b[2])) throw new Error(`namespace ${r.hash.slice(0, 8)} is malformed`);
        this.db.prepare("INSERT OR IGNORE INTO namespaces (hash, body) VALUES (?, ?)").run(r.hash, r.body);
      }
    });
  }

  /** Causals from another codebase, oldest first: each must hash to what it claims, with its namespace and parents here. */
  putCausals(rows: Causal[]) {
    this.transaction(() => {
      for (const c of rows) {
        if (causalHash(c.namespace, c.parents) !== c.hash) throw new Error(`history entry ${String(c.hash).slice(0, 8)} doesn't hash to its claimed hash`);
        if (this.missingNamespaces([c.namespace]).length) throw new Error(`history entry ${c.hash.slice(0, 8)}: its namespace wasn't sent`);
        for (const p of c.parents) if (!this.hasCausal(p)) throw new Error(`history entry ${c.hash.slice(0, 8)}: its parent ${p.slice(0, 8)} wasn't sent`);
        this.putCausal(c.namespace, c.parents, Number(c.ts) || 0, String(c.command ?? ""));
      }
    });
  }

  /** Make a branch's names exactly `rows`, logging each change on that branch. */
  private replaceBranchNames(id: number, rows: NameRow[], command: string): { added: number; removed: number } {
    const key = (r: { path: string; hash: string }) => `${r.path} ${r.hash}`;
    const current = new Map((this.db.prepare("SELECT path, hash, kind FROM names WHERE branch_id = ?").all(id) as unknown as NameRow[]).map((r) => [key(r), r]));
    const wanted = new Map(rows.map((r) => [key(r), r]));
    let added = 0;
    let removed = 0;
    for (const [k, r] of current) {
      if (wanted.has(k)) continue;
      this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(id, r.path, r.hash);
      this.log("delete", r.path, r.hash, null, r.kind, command, id);
      removed++;
    }
    for (const [k, r] of wanted) {
      if (current.has(k)) continue;
      this.db.prepare("INSERT INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(id, r.path, r.hash, r.kind);
      this.log("add", r.path, null, r.hash, r.kind, command, id);
      added++;
    }
    return { added, removed };
  }

  // ---- releases ------------------------------------------------------------

  release(pkg: string, version: string): Release | undefined {
    return this.db.prepare("SELECT * FROM releases WHERE package = ? AND version = ?").get(pkg, version) as unknown as Release | undefined;
  }

  /** Releases (of one package, or all), newest first. */
  releases(pkg?: string): Release[] {
    const q = "SELECT * FROM releases" + (pkg === undefined ? "" : " WHERE package = ?") + " ORDER BY ts DESC, version DESC";
    return (pkg === undefined ? this.db.prepare(q).all() : this.db.prepare(q).all(pkg)) as unknown as Release[];
  }

  /** Record a release; one that exists must be identical (a version names one thing, for good). */
  putRelease(r: Release) {
    const had = this.release(r.package, r.version);
    if (had) {
      if (had.causal !== r.causal || had.notes !== r.notes) throw new Error(`${r.package}@${r.version} is already released here as ${had.causal.slice(0, 8)}, differently; a version can't change`);
      return;
    }
    if (!this.hasCausal(r.causal)) throw new Error(`release ${r.package}@${r.version}: its history entry ${r.causal.slice(0, 8)} isn't here`);
    this.db
      .prepare("INSERT INTO releases (package, version, namespace, causal, notes, author, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.package, r.version, r.namespace, r.causal, r.notes, r.author, r.ts);
  }

  // ---- contributions -------------------------------------------------------

  createContribution(c: { title: string; description: string; source: string; target: string; author: string }): number {
    const now = Date.now();
    return Number(
      this.db
        .prepare("INSERT INTO contributions (title, description, source, target, author, status, created, updated) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)")
        .run(c.title, c.description, c.source, c.target, c.author, now, now).lastInsertRowid,
    );
  }

  contribution(id: number): Contribution | undefined {
    const r = this.db.prepare("SELECT * FROM contributions WHERE id = ?").get(id) as Row | undefined;
    return r && contributionOf(r);
  }

  /** Contributions, newest first; by status if given. */
  contributions(status?: Contribution["status"]): Contribution[] {
    const rows = (status ? this.db.prepare("SELECT * FROM contributions WHERE status = ? ORDER BY id DESC").all(status) : this.db.prepare("SELECT * FROM contributions ORDER BY id DESC").all()) as Row[];
    return rows.map(contributionOf);
  }

  /** The open contribution of `source` into `target`, if there is one. */
  openContribution(source: string, target: string): Contribution | undefined {
    const r = this.db.prepare("SELECT * FROM contributions WHERE source = ? AND target = ? AND status = 'open'").get(source, target) as Row | undefined;
    return r && contributionOf(r);
  }

  setContributionStatus(id: number, status: Contribution["status"], merged?: { from: string; as: string }) {
    this.db.prepare("UPDATE contributions SET status = ?, merged_from = ?, merged_as = ?, updated = ? WHERE id = ?").run(status, merged?.from ?? null, merged?.as ?? null, Date.now(), id);
  }

  touchContribution(id: number) {
    this.db.prepare("UPDATE contributions SET updated = ? WHERE id = ?").run(Date.now(), id);
  }

  addComment(contribution: number, c: { author: string; body: string; about?: string | null }): number {
    this.touchContribution(contribution);
    return Number(this.db.prepare("INSERT INTO contribution_comments (contribution, author, body, about, ts) VALUES (?, ?, ?, ?, ?)").run(contribution, c.author, c.body, c.about ?? null, Date.now()).lastInsertRowid);
  }

  comments(contribution: number): Comment[] {
    return this.db.prepare("SELECT id, author, body, about, ts FROM contribution_comments WHERE contribution = ? ORDER BY id").all(contribution) as unknown as Comment[];
  }

  /** The most recent batch of changes on this branch: its first entry and the command that made it. */
  lastBatch(): { firstId: number; command: string } | undefined {
    const b = this.branch().id;
    const { first } = this.db
      .prepare("SELECT min(id) AS first FROM name_log WHERE branch_id = ? AND batch = (SELECT max(batch) FROM name_log WHERE branch_id = ?)")
      .get(b, b) as { first: number | null };
    if (first === null) return undefined;
    const { command } = this.db.prepare("SELECT command FROM name_log WHERE id = ?").get(first) as { command: string };
    return { firstId: first, command };
  }

  logHead(): number {
    return ((this.db.prepare("SELECT max(id) AS id FROM name_log").get() as { id: number | null }).id ?? 0) as number;
  }

  /** Id of the latest name change on a branch, 0 if none. */
  branchLogHead(branch: string): number {
    return ((this.db.prepare("SELECT max(id) AS id FROM name_log WHERE branch_id = ?").get(this.branchId(branch)) as { id: number | null }).id ?? 0) as number;
  }

  /** Name changes on a branch (default: the current one), newest first. */
  history(limit = 50, afterId = 0, branch?: string): LogEntry[] {
    const id = branch === undefined ? this.branch().id : this.branchId(branch);
    return (
      this.db
        .prepare("SELECT * FROM name_log WHERE branch_id = ? AND id > ? ORDER BY id DESC LIMIT ?")
        .all(id, afterId, limit) as Row[]
    ).map((r) => ({
      id: r.id as number,
      batch: r.batch as number,
      ts: r.ts as number,
      op: r.op as LogEntry["op"],
      path: r.path as string,
      oldHash: r.old_hash as string | null,
      newHash: r.new_hash as string | null,
      kind: r.kind as DefKind,
      command: r.command as string,
    }));
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  settings(prefix: string): [string, string][] {
    return (this.db.prepare("SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key").all(`${prefix}%`) as { key: string; value: string }[]).map((r) => [r.key, r.value]);
  }

  deleteSetting(key: string) {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  setSetting(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  /**
   * Replace a stored definition's text, keeping its hash: for reformatting, which never changes what code means.
   * The caller has checked that the new text hashes the same.
   */
  replaceSource(hash: string, sourceText: string, spans: Span[], reservedNames: string[]) {
    this.db.prepare("UPDATE definitions SET source_text = ?, ref_spans = ?, reserved_names = ? WHERE hash = ?").run(sourceText, JSON.stringify(spans), JSON.stringify(reservedNames), hash);
  }

  // ---- lint results --------------------------------------------------------------------------------------------

  lintResult(hash: string, key: string): string | undefined {
    return (this.db.prepare("SELECT issues FROM lint_results WHERE hash = ? AND key = ?").get(hash, key) as { issues: string } | undefined)?.issues;
  }

  putLintResult(hash: string, key: string, issues: string) {
    this.db.prepare("INSERT OR REPLACE INTO lint_results (hash, key, issues) VALUES (?, ?, ?)").run(hash, key, issues);
  }

  // ---- the package lock ----------------------------------------------------------------------------------------

  /** The version the codebase runs for package `name` within compatible range `range`. */
  lockedVersion(name: string, range: string): string | undefined {
    return (this.db.prepare("SELECT version FROM packages WHERE name = ? AND range = ?").get(name, range) as { version: string } | undefined)?.version;
  }

  /** Lock `name` within `range` to `version`; the integrity recorded for a previous version doesn't carry over. */
  lockVersion(name: string, range: string, version: string, integrity?: string) {
    const was = this.db.prepare("SELECT version, integrity FROM packages WHERE name = ? AND range = ?").get(name, range) as { version: string; integrity: string | null } | undefined;
    const keep = was?.version === version ? (was.integrity ?? undefined) : undefined;
    this.db.prepare("INSERT OR REPLACE INTO packages (name, range, version, integrity) VALUES (?, ?, ?, ?)").run(name, range, version, integrity ?? keep ?? null);
  }

  /** The integrity recorded for the locked version of `name` within `range`. */
  lockedIntegrity(name: string, range: string): string | undefined {
    return (this.db.prepare("SELECT integrity FROM packages WHERE name = ? AND range = ?").get(name, range) as { integrity: string | null } | undefined)?.integrity ?? undefined;
  }

  /**
   * The ranges of package `name` that named definitions use (all, or those at `prefix` and below), with how many
   * definitions use each.
   */
  packageRanges(name: string, prefix = ""): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT d.to_ref AS ref, COUNT(DISTINCT n.hash) AS n FROM names n JOIN deps d ON d.from_hash = n.hash
         WHERE n.branch_id = ? AND (? = '' OR n.path = ? OR n.path LIKE ?) AND d.to_ref LIKE ? GROUP BY d.to_ref`,
      )
      .all(this.branch().id, prefix, prefix, `${prefix}.%`, `npm:${name}@%`) as { ref: string; n: number }[];
    const out = new Map<string, number>();
    for (const r of rows) {
      const range = /^[^/#]+/.exec(r.ref.slice(`npm:${name}@`.length))![0];
      out.set(range, (out.get(range) ?? 0) + r.n);
    }
    return out;
  }

  /** Every locked package, by name then range. */
  lockedPackages(): { name: string; range: string; version: string; integrity?: string }[] {
    return (this.db.prepare("SELECT name, range, version, integrity FROM packages ORDER BY name, range").all() as { name: string; range: string; version: string; integrity: string | null }[]).map(
      (r) => ({ name: r.name, range: r.range, version: r.version, ...(r.integrity ? { integrity: r.integrity } : {}) }),
    );
  }

  // ---- test results ----------------------------------------------------------

  /** A cached result. A test's hash covers everything it depends on, so a result stays valid for that hash. */
  testResult(hash: string, nodeVersion: string): TestResult | undefined {
    const r = this.db.prepare("SELECT * FROM test_results WHERE hash = ? AND node_version = ?").get(hash, nodeVersion) as Row | undefined;
    return r && { hash, ok: r.ok === 1, message: r.message as string, output: r.output as string, ms: r.duration_ms as number };
  }

  putTestResult(r: TestResult, nodeVersion: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO test_results (hash, node_version, ok, message, output, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.hash, nodeVersion, r.ok ? 1 : 0, r.message, r.output, r.ms, Date.now());
  }

  /** A watch expression's cached value: like a test, its hash covers everything it evaluates. */
  watchResult(hash: string, nodeVersion: string): { ok: boolean; value: string } | undefined {
    const r = this.db.prepare("SELECT ok, value FROM watch_results WHERE hash = ? AND node_version = ?").get(hash, nodeVersion) as Row | undefined;
    return r && { ok: r.ok === 1, value: r.value as string };
  }

  putWatchResult(hash: string, nodeVersion: string, r: { ok: boolean; value: string }) {
    this.db.prepare("INSERT OR REPLACE INTO watch_results (hash, node_version, ok, value, ts) VALUES (?, ?, ?, ?, ?)").run(hash, nodeVersion, r.ok ? 1 : 0, r.value, Date.now());
  }

  // ---- patches & todo --------------------------------------------------------

  addPatch(oldHash: string, newHash: string) {
    this.db.prepare("INSERT OR REPLACE INTO patches (branch_id, old_hash, new_hash, ts) VALUES (?, ?, ?, ?)").run(this.branch().id, oldHash, newHash, Date.now());
  }

  /** Follow this branch's patches from `hash` to the newest replacement. */
  patched(hash: string): string {
    const stmt = this.db.prepare("SELECT new_hash FROM patches WHERE branch_id = ? AND old_hash = ?");
    const seen = new Set<string>();
    for (let row; !seen.has(hash) && (row = stmt.get(this.branch().id, hash) as { new_hash: string } | undefined); ) {
      seen.add(hash);
      hash = row.new_hash;
    }
    return hash;
  }

  setTodo(hash: string, message: string) {
    this.db.prepare("INSERT OR REPLACE INTO todo (branch_id, hash, message) VALUES (?, ?, ?)").run(this.branch().id, hash, message);
  }

  clearTodo(hash: string) {
    this.db.prepare("DELETE FROM todo WHERE branch_id = ? AND hash = ?").run(this.branch().id, hash);
  }

  todos(): { hash: string; message: string }[] {
    return this.db.prepare("SELECT hash, message FROM todo WHERE branch_id = ?").all(this.branch().id) as { hash: string; message: string }[];
  }
}

function contributionOf(r: Row): Contribution {
  return {
    id: r.id as number,
    title: r.title as string,
    description: r.description as string,
    source: r.source as string,
    target: r.target as string,
    author: r.author as string,
    status: r.status as Contribution["status"],
    created: r.created as number,
    updated: r.updated as number,
    mergedFrom: r.merged_from as string | null,
    mergedAs: r.merged_as as string | null,
  };
}

export function stateHashOf(rows: { path: string; hash: string }[]): string {
  const lines = rows.map((r) => `${r.path} ${r.hash}\n`).sort();
  return createHash("sha256").update(lines.join("")).digest("hex").slice(0, 32);
}
