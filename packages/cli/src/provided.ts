// Packages without a package.json: a scratch file imports `react`, and tcm provides it.
//
// For each package a scratch file imports (the JSX runtime included), tcm picks the compatible range from what
// the code around it uses, then installs the locked version for that range into the cache and resolves the
// file's imports there, in its own checks and in the editor (through the TypeScript plugin, which reads
// .tcm/packages.json). In order, the range is the one used by:
//
// 1. the codebase definitions the file imports (a new component next to React 18 components gets React 18);
// 2. the definitions in the file's namespace;
// 3. the project's own node_modules, if it has the package installed (it then resolves there, as usual);
// 4. the rest of the codebase (the newest range it locks);
// 5. else the newest release.
//
// Nothing here is part of a hash: definitions record the range their imports resolved to, as always.
import fs from "node:fs";
import path from "node:path";
import { compareVersions, compatRange, HOST_MODULES, packageNameOf, pinnedRange, scratchNamespace, ts, type CompilerOptions, type ExtRef, type PackageResolver } from "@tcm/core";
import { ensureExternals, newestVersion, npmAlias } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";

export interface Provided {
  resolver: PackageResolver;
  /** package name → its directory in the cache, for the packages tcm provides to this file */
  dirs: Map<string, string>;
}

/** `19` before `18`, `0.4` before `0.3`: ranges compared by their numbers. */
const newestRangeFirst = (a: string, b: string) => {
  const pad = (r: string) => (r.split(".").length === 1 ? `${r}.0.0` : r.split(".").length === 2 ? `${r}.0` : r);
  return compareVersions(pad(b), pad(a));
};

/** The most used range in `counts`, the newest on a tie. */
function mostUsed(counts: Map<string, number>): string | undefined {
  return [...counts].sort((a, b) => b[1] - a[1] || newestRangeFirst(a[0], b[0]))[0]?.[0];
}

/** An installed copy of `name` seen from `dir` (the project's node_modules, as Node would find it). */
function installed(name: string, dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    const pj = path.join(d, "node_modules", name, "package.json");
    if (fs.existsSync(pj)) return (JSON.parse(fs.readFileSync(pj, "utf8")) as { version: string }).version;
    if (path.dirname(d) === d) return undefined;
  }
}

/** The `#codebase` names a file imports, as paths (`import { tally } from "#codebase/polls"` → `polls.tally`). */
function codebaseImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']#codebase(?:\/([^"']+))?["']/g)) {
    const ns = (m[2] ?? "").replaceAll("/", ".");
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) out.push(ns ? `${ns}.${name}` : name);
    }
  }
  return out;
}

/** The range of `name` a scratch file should get, and whether the project's own copy provides it. */
function rangeFor(cb: Codebase, name: string, file: string, text: string): { range: string; project: boolean } | undefined {
  const own = installed(name, path.dirname(file));
  const project = (range: string) => ({ range, project: !!own && compatRange(own) === range });
  // 1. what the definitions it imports use
  const used = new Map<string, number>();
  for (const p of codebaseImports(text)) {
    for (const kind of ["term", "type"] as const) {
      for (const h of cb.store.hashesAt(p, kind)) {
        for (const d of cb.store.getDef(h)?.deps ?? []) {
          const range = pinnedRange(d.ref, name);
          if (range) used.set(range, (used.get(range) ?? 0) + 1);
        }
      }
    }
  }
  const imported = mostUsed(used);
  if (imported) return project(imported);
  // 2. what its namespace uses
  const ns = scratchNamespace(text);
  const local = ns ? mostUsed(cb.store.packageRanges(name, ns)) : undefined;
  if (local) return project(local);
  // 3. what the project has installed
  if (own) return { range: compatRange(own), project: true };
  // 4. what the rest of the codebase uses (else runs: the newest range it locks)
  const anywhere = mostUsed(cb.store.packageRanges(name));
  if (anywhere) return { range: anywhere, project: false };
  const locked = cb.store.lockedPackages().filter((l) => l.name === name).map((l) => l.range).sort(newestRangeFirst)[0];
  if (locked) return { range: locked, project: false };
  // 5. the newest release
  const newest = newestVersion(name);
  return newest ? { range: compatRange(newest), project: false } : undefined;
}

/** The packages a scratch file imports: bare specifiers, and the JSX runtime for a .tsx file. */
function importedPackages(file: string, text: string, options: CompilerOptions): string[] {
  const specs = ts.parse(file, text).imports.map((n) => (n as ts.StringLiteral).text);
  if (file.endsWith(".tsx")) specs.push(`${options.jsxImportSource ?? "react"}/jsx-runtime`);
  return [...new Set(specs.flatMap((s) => packageNameOf(s) ?? []))];
}

const EMPTY: Provided = { resolver: Object.assign(() => undefined, { key: "" }), dirs: new Map() };

/**
 * Provide the packages scratch file `file` (with text `text`) imports that the project doesn't have installed
 * at the range chosen for it: installed into the cache, and recorded for the editor in .tcm/packages.json.
 */
export function providePackages(cb: Codebase, file: string, text: string, options: CompilerOptions): Provided {
  const dirs = new Map<string, string>();
  const exts: ExtRef[] = [];
  for (const name of importedPackages(file, text, options)) {
    // a module where the code runs provides (`vscode`): only its types are provided
    const pkg = HOST_MODULES.get(name) ?? name;
    const r = rangeFor(cb, pkg, file, text);
    if (!r || r.project) continue;
    const module = `npm:${pkg}@${r.range}`;
    exts.push({ module, subpath: "", export: "*" });
    dirs.set(name, path.join(cb.lay.cacheDir, "node_modules", npmAlias(module)));
  }
  recordForEditor(cb, file, dirs);
  if (!dirs.size) return EMPTY;
  ensureExternals(cb.lay, exts);
  const from = path.join(cb.lay.cacheDir, "index.ts");
  const resolver: PackageResolver = Object.assign((name: string) => (dirs.has(name) ? { specifier: path.basename(dirs.get(name)!), from } : undefined), {
    key: JSON.stringify([...dirs].sort()),
  });
  return { resolver, dirs };
}

/**
 * .tcm/packages.json: for each scratch file, where the packages tcm provides to it are. The editor's TypeScript
 * (through tcm's plugin) resolves the file's imports with it, the same way tcm does.
 */
function recordForEditor(cb: Codebase, file: string, dirs: Map<string, string>) {
  const out = path.join(cb.lay.tcmDir, "packages.json");
  let current: { files: Record<string, Record<string, string>> } = { files: {} };
  try {
    current = JSON.parse(fs.readFileSync(out, "utf8"));
  } catch {
    // none yet
  }
  const entry = Object.fromEntries([...dirs].sort().map(([name, dir]) => [name, path.basename(dir)]));
  const before = JSON.stringify(current.files[file] ?? {});
  if (before === JSON.stringify(entry)) return;
  if (dirs.size) current.files[file] = entry;
  else delete current.files[file];
  fs.writeFileSync(out, JSON.stringify({ cacheDir: cb.lay.cacheDir, files: current.files }, null, 2) + "\n");
}
