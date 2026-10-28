// npm packages for generated modules.
//
// A definition pins each package it imports by compatible range (`npm:react@19`, from semver: the major, or the
// minor below 1.0). The codebase's lock picks one exact version per package and range, so all code written
// against React 19 runs on the same React, and moving to a newer 19.x changes no hash.
//
// Every locked version is installed into .tcm/cache under an alias per range (`npm__react__19`), which is what
// generated modules import. pnpm installs them when it's available: it keeps one copy of each exact version, and a
// package's peers (React DOM's `react`) resolve to the same copy as the alias at that version. With npm, peers at
// a locked version are linked to the alias's copy instead.
//
// Versions not locked yet come from the registry: the newest in the range whose peer dependencies accept the
// versions already locked (React DOM at the version matching the React it's used with).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareVersions, compatRange, isExactVersion, satisfies, type ExtRef } from "@tcm/core";
import type { Layout } from "./index.ts";

/** The codebase's package lock: the exact version of each package used within each compatible range. */
export interface PackageLock {
  get(name: string, range: string): string | undefined;
  set(name: string, range: string, version: string): void;
  all(): { name: string; range: string; version: string }[];
}

const locks = new Map<string, PackageLock>();

/** The lock installs in this layout follow (the codebase registers its own). */
export function usePackageLock(lay: Layout, lock: PackageLock): void {
  locks.set(lay.cacheDir, lock);
}

function memoryLock(): PackageLock {
  const m = new Map<string, string>();
  return {
    get: (n, r) => m.get(`${n}@${r}`),
    set: (n, r, v) => void m.set(`${n}@${r}`, v),
    all: () => [...m].map(([k, version]) => ({ name: k.slice(0, k.lastIndexOf("@")), range: k.slice(k.lastIndexOf("@") + 1), version })),
  };
}

function lockOf(lay: Layout): PackageLock {
  let lock = locks.get(lay.cacheDir);
  if (!lock) locks.set(lay.cacheDir, (lock = memoryLock()));
  return lock;
}

/** `npm:@scope/name@19` → `{ name: "@scope/name", version: "19" }` */
export function parseModule(module: string): { name: string; version: string } {
  const m = /^npm:(.+)@([^@]+)$/.exec(module)!;
  return { name: m[1]!, version: m[2]! };
}

/** The cache alias for a pinned module: `npm:@scope/name@19` (or `@19.3.1`) → `npm__scope__name__19`. */
export function npmAlias(module: string): string {
  const { name, version } = parseModule(module);
  return `npm__${name.replace(/^@/, "").replace("/", "__").toLowerCase()}__${compatRange(version)}`;
}

/**
 * Raise the lock for `name` within `range` to at least `version`: code was checked against it, and within a
 * compatible range a newer version only adds (semver). Returns the version before, if it changed.
 */
export function lockAtLeast(lay: Layout, name: string, range: string, version: string): string | undefined {
  const lock = lockOf(lay);
  const was = lock.get(name, range);
  if (was && compareVersions(version, was) <= 0) return undefined;
  lock.set(name, range, version);
  return was;
}

// ---- the registry --------------------------------------------------------------------------------------------

let manager: "pnpm" | "npm" | undefined;
/** pnpm when it's installed, else npm. */
export function packageManager(): "pnpm" | "npm" {
  return (manager ??= spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status === 0 ? "pnpm" : "npm");
}

interface Candidate {
  version: string;
  peers: Record<string, string>;
}

const viewed = new Map<string, Candidate[]>();

/** Versions of `name` in npm range `range` with their peer dependencies, newest first (no prereleases, unless asked). */
export function versionsIn(name: string, range: string): { version: string; peers: Record<string, string> }[] {
  return candidates(name, range);
}

/** The peer dependencies of the installed copy of a pinned module. */
export function installedPeers(lay: Layout, module: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(lay.cacheDir, "node_modules", npmAlias(module), "package.json"), "utf8")) as { peerDependencies?: Record<string, string> };
    return pkg.peerDependencies ?? {};
  } catch {
    return {};
  }
}

function candidates(name: string, range: string): Candidate[] {
  const key = `${name}@${range}`;
  const hit = viewed.get(key);
  if (hit) return hit;
  const r = spawnSync(packageManager(), ["view", key, "version", "peerDependencies", "--json"], { encoding: "utf8" });
  let out: Candidate[] = [];
  if (r.status === 0 && r.stdout.trim()) {
    const parsed = JSON.parse(r.stdout) as unknown;
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as ({ version?: string; peerDependencies?: Record<string, string> } | string)[];
    out = list
      .map((x) => (typeof x === "string" ? { version: x, peers: {} } : { version: x.version ?? "", peers: x.peerDependencies ?? {} }))
      .filter((c) => c.version && (isExactVersion(range) || !c.version.includes("-")))
      .sort((a, b) => compareVersions(b.version, a.version));
  }
  viewed.set(key, out);
  return out;
}

/**
 * Pick versions for packages the lock doesn't have yet: the newest in each range whose peers accept what's
 * locked. Peers among the packages being picked are picked first, so React comes before React DOM.
 */
function pickVersions(wanted: { name: string; range: string }[], lock: PackageLock): void {
  const remaining = new Map(wanted.map((w) => [`${w.name}@${w.range}`, w]));
  const lockedVersions = (name: string) => lock.all().filter((l) => l.name === name).map((l) => l.version);
  const pending = (name: string) => [...remaining.values()].some((w) => w.name === name);
  while (remaining.size) {
    const all = [...remaining.values()];
    // something whose peers are all settled; with a cycle, any
    const next = all.find((w) => candidates(w.name, w.range).every((c) => Object.keys(c.peers).every((p) => p === w.name || !pending(p)))) ?? all[0]!;
    remaining.delete(`${next.name}@${next.range}`);
    const options = candidates(next.name, next.range);
    if (!options.length) throw new Error(`can't find a version of ${next.name} in range ${next.range} (is the registry reachable?)`);
    const fits = (c: Candidate) =>
      Object.entries(c.peers).every(([peer, range]) => {
        const versions = lockedVersions(peer);
        return !versions.length || versions.some((v) => satisfies(v, range));
      });
    lock.set(next.name, next.range, (options.find(fits) ?? options[0]!).version);
  }
}

/** The newest version of `name` (its `latest` tag), from the registry; undefined if there's no such package. */
export function newestVersion(name: string): string | undefined {
  const r = spawnSync(packageManager(), ["view", name, "version"], { encoding: "utf8" });
  const v = r.status === 0 ? r.stdout.trim() : "";
  return v || undefined;
}

// ---- installing ----------------------------------------------------------------------------------------------

interface CachePackageJson {
  dependencies?: Record<string, string>;
  /** aliases of packages that ship no types and have no @types package (so the registry isn't asked again) */
  tcmUntyped?: string[];
}

const installedVersion = (lay: Layout, alias: string) => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(lay.cacheDir, "node_modules", alias, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return undefined;
  }
};

/** Whether an installed package carries its own types. */
function hasTypes(lay: Layout, alias: string): boolean {
  const dir = path.join(lay.cacheDir, "node_modules", alias);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    return !!(pkg.types || pkg.typings) || JSON.stringify(pkg.exports ?? "").includes('"types"') || fs.existsSync(path.join(dir, "index.d.ts"));
  } catch {
    return true;
  }
}

function install(lay: Layout, what: string[]) {
  process.stderr.write(`installing ${what.join(", ")}\n`);
  const args =
    packageManager() === "pnpm"
      ? ["install", "--ignore-scripts", "--ignore-workspace", "--reporter=silent", "--config.auto-install-peers=true", "--config.strict-peer-dependencies=false"]
      : ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
  const r = spawnSync(packageManager(), args, { cwd: lay.cacheDir, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`${packageManager()} install failed in .tcm/cache`);
}

/**
 * Install what `exts` import: each package at its locked version (picking one for ranges not locked yet), under
 * its range's alias, with DefinitelyTyped types (`@types/react`) beside packages that ship none.
 */
export function ensureExternals(lay: Layout, exts: Iterable<ExtRef>): void {
  const lock = lockOf(lay);
  const wanted = new Map<string, { name: string; range: string }>();
  for (const e of exts) {
    if (!e.module.startsWith("npm:")) continue;
    const { name, version } = parseModule(e.module);
    const range = compatRange(version);
    wanted.set(npmAlias(e.module), { name, range });
    // a definition from before ranges were pinned names the exact version it was checked against
    if (isExactVersion(version) && range !== version) lockAtLeast(lay, name, range, version);
  }
  if (!wanted.size) return;
  const unlocked = [...wanted.values()].filter((w) => !lock.get(w.name, w.range));
  if (unlocked.length) pickVersions(unlocked, lock);

  const file = path.join(lay.cacheDir, "package.json");
  const pkg = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}) as CachePackageJson;
  const deps = { ...(pkg.dependencies ?? {}) };
  const untyped = new Set(pkg.tcmUntyped ?? []);
  const write = () =>
    writeIfChanged(file, JSON.stringify({ name: "tcm-cache", private: true, type: "module", dependencies: deps, ...(untyped.size ? { tcmUntyped: [...untyped].sort() } : {}) }, null, 2) + "\n");
  const stale = (alias: string, version: string) => installedVersion(lay, alias) !== version;

  const missing: string[] = [];
  for (const [alias, w] of wanted) {
    const version = lock.get(w.name, w.range)!;
    deps[alias] = `npm:${w.name}@${version}`;
    if (stale(alias, version)) missing.push(`${w.name}@${version}`);
  }
  write();
  if (missing.length) install(lay, missing);

  // types for packages without their own, under the alias's name: where TypeScript looks for the alias's types
  const typeMissing: string[] = [];
  for (const [alias, w] of wanted) {
    const typesAlias = `@types/${alias}`;
    if (deps[typesAlias] || untyped.has(alias) || hasTypes(lay, alias)) {
      if (deps[typesAlias] && stale(typesAlias, deps[typesAlias]!.slice(deps[typesAlias]!.lastIndexOf("@") + 1))) typeMissing.push(deps[typesAlias]!.slice(4));
      continue;
    }
    const typesName = `@types/${w.name.replace(/^@/, "").replace("/", "__")}`;
    let version = lock.get(typesName, w.range);
    if (!version) {
      version = candidates(typesName, w.range)[0]?.version;
      if (version) lock.set(typesName, w.range, version);
    }
    if (!version) {
      untyped.add(alias);
      continue;
    }
    deps[typesAlias] = `npm:${typesName}@${version}`;
    if (stale(typesAlias, version)) typeMissing.push(`${typesName}@${version}`);
  }
  write();
  if (typeMissing.length) install(lay, typeMissing);
  if (packageManager() === "npm") linkPeers(lay, deps);
}

/**
 * npm installs a package's peers (React DOM's `react`) under their plain names, beside the aliases. Two copies of
 * one package break packages that must be a single instance (React's hooks), so a peer at a version the codebase
 * locks becomes a link to the alias's copy. (pnpm needs none of this: it keeps one copy per exact version.)
 */
function linkPeers(lay: Layout, deps: Record<string, string>) {
  const modules = path.join(lay.cacheDir, "node_modules");
  for (const [alias, spec] of Object.entries(deps)) {
    const m = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(spec);
    if (!m || alias.startsWith("@types/")) continue;
    const plain = path.join(modules, m[1]!);
    try {
      if (fs.lstatSync(plain).isSymbolicLink()) continue;
      if ((JSON.parse(fs.readFileSync(path.join(plain, "package.json"), "utf8")) as { version: string }).version !== m[2]) continue;
    } catch {
      continue;
    }
    fs.rmSync(plain, { recursive: true, force: true });
    fs.symlinkSync(path.relative(path.dirname(plain), path.join(modules, alias)), plain, "dir");
  }
}

function writeIfChanged(file: string, text: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}
