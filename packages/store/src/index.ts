import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sameSpace, type DefKind, type DefRecord, type Dep, type InitKind, type RefPos, type Span } from "@ucm/core";

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
CREATE TABLE IF NOT EXISTS externals (ref TEXT PRIMARY KEY, module TEXT NOT NULL, subpath TEXT NOT NULL, export_name TEXT NOT NULL, integrity TEXT);
CREATE TABLE IF NOT EXISTS signatures (hash TEXT PRIMARY KEY, display TEXT NOT NULL, sig_ir TEXT, ts_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (hash TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (hash, key));
CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, forked_from_log_id INTEGER);
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
CREATE TABLE IF NOT EXISTS test_results (
  hash TEXT NOT NULL, node_version TEXT NOT NULL, ok INTEGER NOT NULL, message TEXT NOT NULL,
  output TEXT NOT NULL, duration_ms INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (hash, node_version)
);
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

export class Store {
  readonly db: DatabaseSync;
  private branchCache: { id: number; name: string } | undefined;
  /** one batch per Store instance, i.e. per CLI command; allocated on the first logged change */
  private batch: number | undefined;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const cols = this.db.prepare("PRAGMA table_info(name_log)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "batch")) this.db.exec("ALTER TABLE name_log ADD COLUMN batch INTEGER NOT NULL DEFAULT 0");
    this.db.prepare("INSERT OR IGNORE INTO branches (name) VALUES ('main')").run();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('branch', 'main')").run();
  }

  close() {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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
      const head = this.logHead();
      const { lastInsertRowid } = this.db.prepare("INSERT INTO branches (name, forked_from_log_id) VALUES (?, ?)").run(name, head);
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
    this.db.prepare("INSERT OR IGNORE INTO branches (name) VALUES (?)").run(name);
  }

  /** Fingerprint of a branch's namespace, for detecting concurrent changes during sync. */
  stateHash(branch?: string): string {
    return stateHashOf(this.names(branch));
  }

  /** Make `branch` name exactly `rows`, logging each change on that branch. */
  setBranchNames(branch: string, rows: NameRow[], command: string): { added: number; removed: number } {
    this.ensureBranch(branch);
    const id = this.branchId(branch);
    const key = (r: { path: string; hash: string }) => `${r.path} ${r.hash}`;
    const current = new Map(this.names(branch).map((r) => [key(r), r]));
    const wanted = new Map(rows.map((r) => [key(r), r]));
    let added = 0;
    let removed = 0;
    this.transaction(() => {
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
    });
    return { added, removed };
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
    const b = this.branch().id;
    for (const o of oldHashes) this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(b, path, o);
    this.db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, newHash, kind);
    for (const o of oldHashes.length ? oldHashes : [null]) this.log("update", path, o, newHash, kind, command);
  }

  pathsOf(hash: string): string[] {
    return (this.db.prepare("SELECT path FROM names WHERE branch_id = ? AND hash = ? ORDER BY path").all(this.branch().id, hash) as { path: string }[]).map((r) => r.path);
  }

  addName(path: string, hash: string, kind: DefKind, command: string) {
    const b = this.branch().id;
    const r = this.db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, hash, kind);
    if (r.changes) this.log("add", path, null, hash, kind, command);
  }

  removeName(path: string, hash: string, command: string) {
    const b = this.branch().id;
    const row = this.db.prepare("SELECT kind FROM names WHERE branch_id = ? AND path = ? AND hash = ?").get(b, path, hash) as { kind: DefKind } | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(b, path, hash);
    this.log("delete", path, hash, null, row.kind, command);
  }

  /** Point `path` at `newHash`, replacing whatever it pointed to. */
  updateName(path: string, newHash: string, kind: DefKind, command: string) {
    const b = this.branch().id;
    const old = this.hashesAt(path);
    this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ?").run(b, path);
    this.db.prepare("INSERT INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, newHash, kind);
    for (const o of old.length ? old : [null]) this.log("update", path, o, newHash, kind, command);
  }

  /** Swap one hash on `path` for another, leaving any other hashes there (a conflict) alone. */
  replaceName(path: string, oldHash: string, newHash: string, kind: DefKind, command: string) {
    const b = this.branch().id;
    const r = this.db.prepare("DELETE FROM names WHERE branch_id = ? AND path = ? AND hash = ?").run(b, path, oldHash);
    if (!r.changes) return;
    this.db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(b, path, newHash, kind);
    this.log("update", path, oldHash, newHash, kind, command);
  }

  private log(op: LogEntry["op"], path: string, oldHash: string | null, newHash: string | null, kind: DefKind, command: string, branchId = this.branch().id) {
    this.batch ??= ((this.db.prepare("SELECT coalesce(max(batch), 0) + 1 AS b FROM name_log").get() as { b: number }).b);
    this.db
      .prepare("INSERT INTO name_log (branch_id, ts, op, path, old_hash, new_hash, kind, command, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(branchId, Date.now(), op, path, oldHash, newHash, kind, command, this.batch);
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

export function stateHashOf(rows: { path: string; hash: string }[]): string {
  const lines = rows.map((r) => `${r.path} ${r.hash}\n`).sort();
  return createHash("sha256").update(lines.join("")).digest("hex").slice(0, 32);
}
