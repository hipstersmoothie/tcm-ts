// Packages in a codebase: a definition named `manifest` makes its namespace an npm package. Its value says what
// the package is called and what it exports (`exports`: subpath → names relative to the namespace), its commands
// (`bin`) and the rest (`with`, `files`). Being a definition, it's hashed, versioned, diffed and reviewed like the
// code it describes, and a rename of the namespace takes it along. A codebase can hold any number.
import type { NameRow } from "@tcm/store";
import type { Codebase } from "./codebase.ts";
import { configValue } from "./config.ts";
import { isTestPath } from "./testing.ts";

export interface Manifest {
  name: string;
  description?: string;
  /** subpath (`.`, `./ui`) → names (relative to the namespace; "" is all of it) whose definitions it exports */
  exports: Record<string, string[]>;
  /** command → the definition it runs (relative) */
  bin: Record<string, string>;
  /** packages the code needs but doesn't import (`@types/node@^24`) */
  with: string[];
  /** files to copy in, relative to the codebase root */
  files: string[];
  /** command → test files that run it as a program (relative to the codebase root): `tcm test` runs them */
  suites: Record<string, string[]>;
}

export interface Pkg {
  name: string;
  /** the namespace it is ("" for the whole codebase) */
  namespace: string;
  /** the manifest's name and hash */
  manifestPath: string;
  manifestHash: string;
  manifest: Manifest;
}

export const isManifestPath = (p: string) => p === "manifest" || p.endsWith(".manifest");
const nsOf = (manifestPath: string) => (manifestPath === "manifest" ? "" : manifestPath.slice(0, -".manifest".length));
const within = (ns: string, p: string) => !ns || p === ns || p.startsWith(`${ns}.`);
/** A name relative to a namespace, made whole. */
export const absolute = (ns: string, rel: string) => (!rel ? ns : ns ? `${ns}.${rel}` : rel);

function validate(at: string, v: Record<string, unknown>, doc: string | undefined): Manifest {
  const fail = (what: string) => {
    throw new Error(`${at}: ${what}`);
  };
  if (typeof v.name !== "string" || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(v.name)) fail("`name` must be the npm package's name (lowercase, like `greeter` or `@me/greeter`)");
  const strings = (x: unknown, what: string): string[] => {
    const xs = typeof x === "string" ? [x] : x;
    if (!Array.isArray(xs) || xs.some((s) => typeof s !== "string")) fail(`${what} must be a name or a list of names`);
    return xs as string[];
  };
  const exports: Record<string, string[]> = {};
  const given = v.exports ?? { ".": "" };
  if (typeof given === "string" || Array.isArray(given)) exports["."] = strings(given, "`exports`");
  else if (typeof given === "object" && given) {
    for (const [sub, t] of Object.entries(given)) {
      if (sub !== "." && !/^\.\/[\w./-]+$/.test(sub)) fail(`\`exports\` subpaths are "." or "./something", not '${sub}'`);
      exports[sub] = strings(t, `\`exports["${sub}"]\``);
    }
  } else fail("`exports` must map subpaths to names");
  const bin: Record<string, string> = {};
  if (v.bin !== undefined) {
    if (typeof v.bin !== "object" || !v.bin) fail("`bin` must map commands to definitions");
    for (const [cmd, t] of Object.entries(v.bin as object)) {
      if (typeof t !== "string") fail(`\`bin.${cmd}\` must be a definition's name`);
      bin[cmd] = t as string;
    }
  }
  const suites: Record<string, string[]> = {};
  if (v.suites !== undefined) {
    if (typeof v.suites !== "object" || !v.suites || Array.isArray(v.suites)) fail("`suites` must map commands to test files");
    for (const [cmd, files] of Object.entries(v.suites as object)) {
      if (!(cmd in bin)) fail(`\`suites.${cmd}\` is for a command \`bin\` doesn't have`);
      suites[cmd] = strings(files, `\`suites.${cmd}\``);
    }
  }
  const list = (k: "with" | "files") => (v[k] === undefined ? [] : strings(v[k], `\`${k}\``));
  const description = typeof v.description === "string" ? v.description : doc?.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim() || undefined;
  return { name: v.name as string, description, exports, bin, with: list("with"), files: list("files"), suites };
}

/** The packages a branch's names (or a past namespace's) declare. */
export function packagesIn(cb: Codebase, rows: NameRow[]): Pkg[] {
  const out: Pkg[] = [];
  for (const r of rows) {
    if (!isManifestPath(r.path) || r.kind === "type") continue;
    const manifest = validate(r.path, configValue(cb, r.hash, r.path), cb.store.getDef(r.hash)?.doc);
    const twin = out.find((p) => p.name === manifest.name);
    if (twin) throw new Error(`two packages are called ${manifest.name}: ${twin.manifestPath} and ${r.path}`);
    out.push({ name: manifest.name, namespace: nsOf(r.path), manifestPath: r.path, manifestHash: r.hash, manifest });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** One package of these, by name; with no name, the only one there is. */
export function findPackage(pkgs: Pkg[], name: string | undefined): Pkg {
  if (!pkgs.length) throw new Error("no packages here: a definition named `manifest` makes its namespace one (see docs/publishing.md)");
  if (name === undefined) {
    if (pkgs.length === 1) return pkgs[0]!;
    throw new Error(`which package? ${pkgs.map((p) => p.name).join(", ")}`);
  }
  const p = pkgs.find((x) => x.name === name);
  if (!p) throw new Error(`no package ${name} (there's ${pkgs.map((x) => x.name).join(", ")})`);
  return p;
}

/** Whether a name is the package's own: in its namespace, not in a package nested in it, not its manifest, a test or tool config. */
export function owns(pkg: Pkg, all: Pkg[], p: string): boolean {
  if (!within(pkg.namespace, p) || isManifestPath(p) || isTestPath(p) || p.endsWith("lint.config") || p.endsWith("fmt.config")) return false;
  return !all.some((o) => o !== pkg && o.namespace.length > pkg.namespace.length && within(pkg.namespace, o.namespace) && within(o.namespace, p));
}

/** What a package exports: each exported name, with the subpath it's exported from. */
export function exportsOf(pkg: Pkg, all: Pkg[], rows: NameRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [sub, targets] of Object.entries(pkg.manifest.exports)) {
    for (const t of targets) {
      const abs = absolute(pkg.namespace, t);
      const hit = rows.filter((r) => within(abs, r.path) && owns(pkg, all, r.path));
      if (!hit.length) throw new Error(`${pkg.manifestPath}: exports["${sub}"] names '${t}', which isn't in ${pkg.namespace || "the codebase"}`);
      for (const r of hit) if (!out.has(r.path)) out.set(r.path, sub);
    }
  }
  return out;
}
