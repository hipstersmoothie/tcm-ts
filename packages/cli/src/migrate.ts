import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IR_VERSION, saltOf, shortHash, type DefRecord } from "@ucm/core";
import { Store, stateHashOf } from "@ucm/store";
import { ensureExternals, layout, materialize, render } from "@ucm/loader";
import { Codebase } from "./codebase.ts";
import { dim, green, red, yellow } from "./style.ts";

type Row = Record<string, string | number | null>;

/** Open a private copy of a database (WAL files included), so reading an old codebase never modifies it. */
function openCopy(dbFile: string): Store {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ucm-migrate-")), "old.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, tmp + suffix);
  return new Store(tmp);
}

/** Components in dependency order (dependencies first). Stored components form a DAG by construction. */
function dependencyOrder(old: Store): string[] {
  const comps = (old.db.prepare("SELECT hash FROM components ORDER BY hash").all() as { hash: string }[]).map((r) => r.hash);
  const compOf = new Map((old.db.prepare("SELECT hash, component_hash FROM definitions").all() as Row[]).map((r) => [r.hash as string, r.component_hash as string]));
  const deps = new Map<string, Set<string>>();
  for (const r of old.db.prepare("SELECT from_hash, to_ref FROM deps WHERE to_ref LIKE '#%'").all() as Row[]) {
    const from = compOf.get(r.from_hash as string);
    const to = compOf.get((r.to_ref as string).slice(1));
    if (from && to && from !== to) deps.set(from, (deps.get(from) ?? new Set()).add(to));
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (c: string) => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const d of deps.get(c) ?? []) visit(d);
    order.push(c);
  };
  comps.forEach(visit);
  return order;
}

/**
 * Rebuild a codebase written with an older hash format. Every stored definition (named or not, so history
 * stays meaningful) is re-rendered from its source against its already-migrated dependencies, typechecked, and
 * hashed by the current analyzer; branches, history, patches, todo and remotes are carried over through the
 * old → new hash map. The old `.ucm` directory is kept as a backup.
 */
export function migrate(root: string): boolean {
  const lay = layout(root);
  if (!fs.existsSync(lay.dbFile)) throw new Error(`no codebase at ${root}`);
  const old = openCopy(lay.dbFile);
  const versions = old.irVersions();
  if (versions.every((v) => v === IR_VERSION)) {
    console.log(dim(`already on hash format v${IR_VERSION}`));
    return true;
  }
  let backup = `${lay.ucmDir}-v${versions.join("-")}-backup`;
  if (fs.existsSync(backup)) backup += `-${Date.now()}`;
  fs.renameSync(lay.ucmDir, backup);
  console.log(`migrating hash format v${versions.join(", v")} → v${IR_VERSION} ${dim(`(old codebase kept in ${path.basename(backup)})`)}`);
  const cb = Codebase.init(root);

  // lineage salts for formats that had none: the first path each definition was bound at
  const firstPath = new Map<string, string>();
  for (const r of old.db.prepare("SELECT path, new_hash FROM name_log WHERE new_hash IS NOT NULL ORDER BY id").all() as Row[]) {
    if (!firstPath.has(r.new_hash as string)) firstPath.set(r.new_hash as string, r.path as string);
  }
  for (const r of old.db.prepare("SELECT path, hash FROM names ORDER BY branch_id, path").all() as Row[]) {
    if (!firstPath.has(r.hash as string)) firstPath.set(r.hash as string, r.path as string);
  }

  const map = new Map<string, string>();
  const failed = new Map<string, string>();
  for (const c of dependencyOrder(old)) {
    const members = old.componentMembers(c);
    const memberSet = new Set(members.map((m) => m.hash));
    const external = [...new Set(members.flatMap((m) => m.spans.filter((s) => s.hash && !memberSet.has(s.hash)).map((s) => s.hash!)))];
    const blocked = external.find((h) => !map.has(h));
    if (blocked) {
      for (const m of members) failed.set(m.hash, `depends on ${shortHash(blocked)}, which could not be migrated`);
      continue;
    }
    const src = cb.source();
    materialize(external.map((h) => map.get(h)!), src, cb.lay);
    ensureExternals(cb.lay, members.flatMap((m) => m.spans.flatMap((s) => (s.ext ? [s.ext] : []))));
    const rendered = render(members, src, cb.lay, { style: "internal", remap: (h) => map.get(h) ?? h });
    const tmp = path.join(cb.lay.cacheDir, `_migrate_${c}.ts`);
    fs.writeFileSync(tmp, rendered.text);
    const byName = new Map([...rendered.memberNames].map(([h, n]) => [n, members.find((m) => m.hash === h)!]));
    const a = cb.analyze(tmp, (_file, name) => {
      const m = byName.get(name);
      return m && (saltOf(m.ir) ?? firstPath.get(m.hash) ?? m.nameHint);
    }, [7016]);
    fs.rmSync(tmp);
    const problem = a.errors[0] ?? a.diagnostics[0]?.message;
    if (problem) {
      for (const m of members) failed.set(m.hash, problem);
      continue;
    }
    const fresh: DefRecord[] = [];
    for (const d of a.defs) {
      const m = byName.get(d.nameHint);
      if (!m) continue;
      map.set(m.hash, d.hash);
      fresh.push({ ...d, doc: m.doc });
    }
    cb.putDefs(fresh);
  }

  // names, history, patches and todo, through the hash map
  const db = cb.store.db;
  const remap = (h: string | number | null) => (typeof h === "string" ? (map.get(h) ?? h) : h);
  const branchIds = new Map<number, number>();
  let dropped = 0;
  cb.store.transaction(() => {
    for (const b of old.db.prepare("SELECT * FROM branches ORDER BY id").all() as Row[]) {
      cb.store.ensureBranch(b.name as string);
      const id = (db.prepare("SELECT id FROM branches WHERE name = ?").get(b.name) as { id: number }).id;
      db.prepare("UPDATE branches SET forked_from_log_id = ? WHERE id = ?").run(b.forked_from_log_id, id);
      branchIds.set(b.id as number, id);
    }
    for (const r of old.db.prepare("SELECT * FROM names").all() as Row[]) {
      const h = map.get(r.hash as string);
      if (!h) {
        dropped++;
        continue;
      }
      db.prepare("INSERT OR IGNORE INTO names (branch_id, path, hash, kind) VALUES (?, ?, ?, ?)").run(branchIds.get(r.branch_id as number)!, r.path, h, r.kind);
    }
    for (const r of old.db.prepare("SELECT * FROM name_log ORDER BY id").all() as Row[]) {
      db.prepare("INSERT INTO name_log (id, branch_id, ts, op, path, old_hash, new_hash, kind, command, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        r.id, branchIds.get(r.branch_id as number)!, r.ts, r.op, r.path, remap(r.old_hash), remap(r.new_hash), r.kind, r.command, r.batch ?? 0,
      );
    }
    for (const r of old.db.prepare("SELECT * FROM patches").all() as Row[]) {
      db.prepare("INSERT OR REPLACE INTO patches (branch_id, old_hash, new_hash, ts) VALUES (?, ?, ?, ?)").run(branchIds.get(r.branch_id as number)!, remap(r.old_hash), remap(r.new_hash), r.ts);
    }
    for (const r of old.db.prepare("SELECT * FROM todo").all() as Row[]) {
      db.prepare("INSERT OR REPLACE INTO todo (branch_id, hash, message) VALUES (?, ?, ?)").run(branchIds.get(r.branch_id as number)!, remap(r.hash), r.message);
    }
    // settings: the current branch and remotes carry over; a sync fingerprint is translated if it still
    // describes its tracking branch, so the next push/pull doesn't mistake migration for divergence
    for (const [k, v] of old.settings("")) {
      if (k === "branch" || k.startsWith("remote.")) cb.store.setSetting(k, v);
      const m = /^sync\.([^.]+)\.(.+)$/.exec(k);
      if (m && old.hasBranch(`${m[1]}/${m[2]}`) && stateHashOf(old.names(`${m[1]}/${m[2]}`)) === v) {
        cb.store.setSetting(k, cb.store.stateHash(`${m[1]}/${m[2]}`));
      }
    }
  });
  old.close();
  const next = Codebase.find(root);
  next.refreshShim(true);

  const failedNamed = [...failed.keys()].filter((h) => firstPath.has(h));
  console.log(`${green("migrated")} ${map.size} definition(s)${failed.size ? red(`, ${failed.size} failed`) : ""}`);
  for (const h of failedNamed.slice(0, 20)) console.log(`  ${red("✗")} ${firstPath.get(h)} ${dim(shortHash(h))}: ${failed.get(h)!.split("\n")[0]}`);
  if (dropped) console.log(yellow(`  ${dropped} name(s) dropped because their definition could not be migrated`));
  const v = next.verify();
  const ok = !failed.size && !v.problems.length && !v.mismatches.length;
  console.log(ok ? green(`verified ${v.checked} live definitions`) : red(`verification: ${v.mismatches.length} mismatch(es), ${v.problems.length} problem(s)`));
  console.log(dim(`  the old codebase is in ${backup}; delete it once you're happy`));
  return ok;
}
