// The codebase's packages, for editors: what it runs (the lock), what uses each package, and a page per package
// and range, with its README and its API as its type definitions declare it (exports, signatures, JSDoc).
import fs from "node:fs";
import path from "node:path";
import { compareVersions, createProgram, ts } from "@tcm/core";
import { ensureExternals, npmAlias } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { usersOf } from "./upgrade.ts";
import { highlight } from "./pages.ts";

export interface PackageRange {
  range: string;
  version: string;
  integrity?: string;
  /** named definitions using it */
  users: number;
  /** the DefinitelyTyped version installed beside it, when it ships no types of its own */
  types?: string;
}

/** Every package the codebase locks, by name, its ranges newest first; @types packages fold into theirs. */
export function packageList(cb: Codebase): { name: string; ranges: PackageRange[] }[] {
  const locked = cb.store.lockedPackages();
  const byName = new Map<string, PackageRange[]>();
  for (const l of locked) {
    if (l.name.startsWith("@types/")) continue;
    const types = locked.find((t) => t.name === `@types/${l.name.replace(/^@/, "").replace("/", "__")}` && t.range === l.range)?.version;
    const r: PackageRange = { range: l.range, version: l.version, users: usersOf(cb, l.name, l.range).size, ...(l.integrity ? { integrity: l.integrity } : {}), ...(types ? { types } : {}) };
    byName.set(l.name, [...(byName.get(l.name) ?? []), r]);
  }
  const pad = (r: string) => (r.split(".").length === 1 ? `${r}.0.0` : r.split(".").length === 2 ? `${r}.0` : r);
  return [...byName].map(([name, ranges]) => ({ name, ranges: ranges.sort((a, b) => compareVersions(pad(b.range), pad(a.range))) }));
}

/** The named definitions using `name` at `range`. */
export function packageUsers(cb: Codebase, name: string, range: string): { path: string; hash: string; kind: string; signature: string }[] {
  const out: { path: string; hash: string; kind: string; signature: string }[] = [];
  for (const h of usersOf(cb, name, range).keys()) {
    const rec = cb.store.getDef(h);
    for (const p of cb.store.pathsOf(h)) out.push({ path: p, hash: h, kind: rec?.kind ?? "term", signature: rec?.signature ?? "" });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface ApiEntry {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "namespace" | "value";
  signature: string;
  /** the signature as highlighted HTML, as a definition page's code is */
  html: string;
  doc: string;
}

export interface PackagePage {
  name: string;
  range: string;
  version: string;
  integrity?: string;
  types?: string;
  description?: string;
  license?: string;
  homepage?: string;
  /** the package's README (its @types README when it has none) */
  readme?: string;
  api: ApiEntry[];
  users: { path: string; hash: string; kind: string; signature: string }[];
  /** ranges of the same package the codebase also runs */
  otherRanges: string[];
}

const README = /^readme(\.(md|markdown|txt))?$/i;

function readmeIn(dir: string): string | undefined {
  try {
    const f = fs.readdirSync(dir).find((n) => README.test(n));
    if (!f) return undefined;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    return text.length > 200_000 ? text.slice(0, 200_000) + "\n\n…" : text;
  } catch {
    return undefined;
  }
}

function kindOf(s: ts.Symbol): ApiEntry["kind"] {
  const f = s.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  if (f & ts.SymbolFlags.Enum) return "enum";
  if (f & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) return "value";
  if (f & ts.SymbolFlags.Module) return "namespace";
  return "value";
}

const clip = (text: string) => {
  const lines = text.split("\n");
  return lines.length > 30 ? [...lines.slice(0, 30), "  …"].join("\n") : text;
};

/** The package's exports as its types declare them: the API a definition using it is checked against. */
function apiOf(cb: Codebase, alias: string): ApiEntry[] {
  // a file in the cache importing the package, never written: the package's types are what it resolves to
  const from = path.join(cb.lay.cacheDir, "__tcm_api__.ts");
  const { program, checker } = createProgram([from], { ...cb.compilerOptions(), noEmit: true, skipLibCheck: true }, new Map([[from, `import ${JSON.stringify(alias)};\n`]]));
  const file = program.getResolvedModule(from, alias, ts.ModuleKind.ESNext)?.resolvedFileName;
  const mod = file && checker.getSymbolOfSourceFile(file);
  if (!mod) return [];
  const flags = ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.WriteArrowStyleSignature;
  const entry = (name: string, sym: ts.Symbol): ApiEntry => {
    const s = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const kind = kindOf(s);
    let signature = "";
    try {
      // a type reads best as declared (its name alone says nothing)
      if (kind === "interface" || kind === "type" || kind === "enum") {
        const decl = ts.declarationOf(s);
        signature = decl ? clip(decl.getText()) : "";
      } else if (kind !== "namespace") signature = checker.typeToString(checker.getTypeOfSymbol(s), undefined, flags);
    } catch {
      signature = "";
    }
    return { name, kind, signature, html: highlight(signature, [], new Set()), doc: s.getDocumentationComment(checker) };
  };
  const out = checker
    .getExportsOfModule(mod)
    .filter((s) => !s.name.startsWith("__"))
    .map((s) => entry(s.name, s));
  // `export = fn` (CommonJS style): the module itself is the API
  const exportEquals = mod.getExports().get("export=" as never);
  if (exportEquals && !out.some((e) => e.kind === "function" || e.kind === "class")) out.unshift(entry("default", exportEquals));
  return out.sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name < b.name ? -1 : 1)).slice(0, 500);
}

/** A package at one range: what it is, its README, its API, and what uses it. */
export function packagePage(cb: Codebase, name: string, range: string): PackagePage {
  const version = cb.store.lockedVersion(name, range);
  if (!version) throw new Error(`the codebase doesn't run ${name} ${range}`);
  const module = `npm:${name}@${range}`;
  ensureExternals(cb.lay, [{ module, subpath: "", export: "*" }]);
  const alias = npmAlias(module);
  const dir = path.join(cb.lay.cacheDir, "node_modules", alias);
  const typesDir = path.join(cb.lay.cacheDir, "node_modules", "@types", alias);
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // not installed: the page says what it can
  }
  const listed = packageList(cb).find((p) => p.name === name);
  const here = listed?.ranges.find((r) => r.range === range);
  return {
    name,
    range,
    version,
    ...(here?.integrity ? { integrity: here.integrity } : {}),
    ...(here?.types ? { types: here.types } : {}),
    ...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
    ...(typeof pkg.license === "string" ? { license: pkg.license } : {}),
    ...(typeof pkg.homepage === "string" ? { homepage: pkg.homepage } : {}),
    readme: readmeIn(dir) ?? readmeIn(typesDir),
    api: apiOf(cb, alias),
    users: packageUsers(cb, name, range),
    otherRanges: (listed?.ranges ?? []).map((r) => r.range).filter((r) => r !== range),
  };
}
