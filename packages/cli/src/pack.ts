// tcm pack: an npm package from the codebase.
//
// Definitions are code, not files, so publishing one means turning its closure back into modules: each
// component it needs, as JavaScript with type declarations, under its hash (`modules/<hash>.js`). On top go
// entry points, which export definitions under their names (`index.js`, or a subpath's), bins, which run a
// definition with the command line, and a package.json whose dependencies are what the code imports, at the
// versions the codebase locks. A package pinned at more than one range keeps the cache's aliases
// (`npm__lodash__3`), which npm installs side by side.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { exportId, type DefKind } from "@tcm/core";
import { externalsOf, npmAlias, parseModule, render, type DefSource } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";

export interface PackOptions {
  name: string;
  version: string;
  description?: string;
  /** `subpath` (`.` for the package itself) → a namespace (everything beneath it) or a definition */
  entries: { subpath: string; target: string }[];
  /** command → the definition it runs */
  bins: { command: string; target: string }[];
  /** packages the code looks up at runtime by name (not imports, so tcm can't see them) */
  with: string[];
  /** files and directories to copy in, relative to the codebase root: kept at that path, or by name if outside it */
  files: string[];
  out: string;
}

interface Exported {
  name: string;
  hash: string;
  kind: DefKind;
}

/**
 * What a subpath exports: definitions under their last names, namespaces' definitions under theirs. A type and
 * a value can share a name; two of either can't.
 */
function exportsOf(cb: Codebase, targets: string[]): Exported[] {
  const out: Exported[] = [];
  const taken = new Map<string, string>();
  const all = cb.store.names();
  for (const target of targets) {
    const names = all.filter((n) => n.path === target || n.path.startsWith(`${target}.`));
    if (!names.length) throw new Error(`'${target}' isn't a definition or namespace`);
    for (const n of names) {
      const name = n.path.slice(n.path.lastIndexOf(".") + 1);
      const space = n.kind === "type" ? "type" : "value";
      const prior = taken.get(`${space} ${name}`);
      if (prior === n.path) continue;
      if (prior) throw new Error(`two ${space}s would be exported as ${name}: ${prior} and ${n.path}; pack them under separate subpaths`);
      taken.set(`${space} ${name}`, n.path);
      out.push({ name, hash: n.hash, kind: n.kind });
    }
  }
  return out;
}

/**
 * Emitted code and declarations, for outside the cache: packages by name rather than the cache's aliases (where
 * that's unambiguous; TypeScript calls an alias's DefinitelyTyped types `@npm/<alias>`), other modules by their
 * `.js` files (declaration emit keeps `.ts`), and no JSX pragmas naming aliases.
 */
function forPackage(text: string, aliases: Map<string, string>): string {
  return text
    .replace(/^\/\/ tcm: transform\n/m, "")
    .replace(/^\/\*\* @jsxImportSource npm__[^*]*\*\/\n/gm, "")
    .replace(/((?:from|import)\s*\(?\s*["']\.\/[^"']+)\.tsx?(["'])/g, "$1.js$2")
    .replace(/((?:from|import)\s*\(?\s*["'])(npm__[^"'/]+|@npm\/[^"'/]+)((?:\/[^"']*)?["'])/g, (m, lead: string, alias: string, rest: string) => {
      const name = aliases.get(alias.startsWith("@npm/") ? `npm__${alias.slice(5)}` : alias);
      return name ? `${lead}${name}${rest}` : m;
    });
}

export function pack(cb: Codebase, opts: PackOptions): { dir: string; modules: number; dependencies: Record<string, string> } {
  const subpaths = new Map<string, string[]>();
  for (const e of opts.entries) subpaths.set(e.subpath, [...(subpaths.get(e.subpath) ?? []), e.target]);
  const entries = [...subpaths].map(([subpath, targets]) => ({ subpath, exports: exportsOf(cb, targets) }));
  const bins = opts.bins.map((b) => ({ ...b, hash: cb.lookupOne(b.target, "value") }));
  const roots = [...entries.flatMap((e) => e.exports.map((x) => x.hash)), ...bins.map((b) => b.hash)];
  const comps = [...cb.closureComponents(roots)];
  // generated without source maps: the published modules are the code
  const base = cb.source();
  const src: DefSource = { get: base.get, members: base.members, nameOf: base.nameOf };

  // the package's dependencies: every package the code imports, at its locked version
  const modules = new Set<string>();
  for (const c of comps) for (const e of externalsOf(src.members(c))) if (e.module.startsWith("npm:")) modules.add(e.module);
  const byName = new Map<string, string[]>();
  for (const m of modules) {
    const { name } = parseModule(m);
    byName.set(name, [...(byName.get(name) ?? []), m]);
  }
  const dependencies: Record<string, string> = {};
  const aliases = new Map<string, string>();
  for (const [name, ms] of byName) {
    for (const m of ms) {
      const { version: range } = parseModule(m);
      const version = cb.store.lockedVersion(name, range);
      if (!version) throw new Error(`${name} ${range} isn't locked; run the code once (tcm check or tcm run) so tcm installs it`);
      // DefinitelyTyped types where the package has none: the declarations refer to them
      const typesName = `@types/${name.replace(/^@/, "").replace("/", "__")}`;
      const types = cb.store.lockedVersion(typesName, range);
      if (ms.length === 1) {
        dependencies[name] = version;
        if (types) dependencies[typesName] = types;
        aliases.set(npmAlias(m), name);
      } else {
        dependencies[npmAlias(m)] = `npm:${name}@${version}`;
        if (types) dependencies[`@types/${npmAlias(m)}`] = `npm:${typesName}@${types}`;
      }
    }
  }
  for (const w of opts.with) {
    const at = w.lastIndexOf("@");
    const [name, version] = at > 0 ? [w.slice(0, at), w.slice(at + 1)] : [w, undefined];
    const locked = cb.store.lockedPackages().filter((l) => l.name === name).at(-1)?.version;
    dependencies[name] = version ?? locked ?? "*";
  }

  // the closure as TypeScript, next to the cache so the pinned packages resolve; compiled to JavaScript
  // with declarations
  const dir = path.resolve(cb.lay.root, opts.out);
  // the output is replaced, so it must be empty or an earlier pack: never the codebase, or files of yours
  const earlier = fs.existsSync(path.join(dir, "modules")) && fs.existsSync(path.join(dir, "package.json"));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && (!earlier || !path.relative(dir, cb.lay.root).startsWith(".."))) {
    throw new Error(`--out ${opts.out}: ${dir} isn't empty or an earlier tcm pack; pick another directory`);
  }
  const work = fs.mkdtempSync(path.join(cb.lay.cacheDir, "_pack-"));
  try {
    const files: string[] = [];
    let server = false;
    for (const c of comps) {
      const members = src.members(c);
      const text = render(members, src, cb.lay, { style: "cache", docs: true }).text;
      if (text.includes('"./tcm-server.js"')) server = true;
      const file = path.join(work, `${c}${members.some((m) => m.jsx) ? ".tsx" : ".ts"}`);
      fs.writeFileSync(file, text);
      files.push(file);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const outModules = path.join(dir, "modules");
    if (server) {
      for (const f of ["tcm-server.js", "tcm-server.d.ts"]) fs.copyFileSync(path.join(cb.lay.cacheDir, f), path.join(work, f));
    }
    const program = ts.createProgram(files, {
      ...cb.recheckOptions(undefined),
      noEmit: false,
      declaration: true,
      outDir: outModules,
      rootDir: work,
      rewriteRelativeImportExtensions: true,
      allowImportingTsExtensions: false,
      sourceMap: false,
      noEmitOnError: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
    });
    const emitted = program.emit(undefined, (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, forPackage(text, aliases));
    });
    const missing = files.filter((f) => !fs.existsSync(path.join(outModules, path.basename(f).replace(/\.tsx?$/, ".js"))));
    if (missing.length) {
      const why = emitted.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).slice(0, 3).join("\n");
      throw new Error(`couldn't compile ${missing.length} module(s)${why ? `:\n${why}` : ""}`);
    }
    if (server) for (const f of ["tcm-server.js", "tcm-server.d.ts"]) fs.copyFileSync(path.join(work, f), path.join(outModules, f));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // entry points: each definition exported under its name, from its module
  const exportsField: Record<string, { types: string; default: string }> = {};
  for (const e of entries) {
    const at = e.subpath === "." ? "" : e.subpath.replace(/^\.\//, "");
    const entryDir = path.join(dir, at);
    const rel = path.relative(entryDir, path.join(dir, "modules")).split(path.sep).join("/");
    const from = rel.startsWith(".") ? rel : `./${rel}`;
    const js: string[] = ["// generated by tcm pack"];
    const dts: string[] = ["// generated by tcm pack"];
    for (const x of e.exports) {
      const comp = cb.store.getDef(x.hash)!.componentHash;
      const line = (type: boolean) => `export ${type ? "type " : ""}{ ${exportId(x.hash)} as ${x.name} } from "${from}/${comp}.js";`;
      if (x.kind !== "type") js.push(line(false));
      dts.push(line(x.kind === "type"));
    }
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, "index.js"), js.join("\n") + "\n");
    fs.writeFileSync(path.join(entryDir, "index.d.ts"), dts.join("\n") + "\n");
    exportsField[e.subpath === "." ? "." : `./${at}`] = { types: `./${at ? `${at}/` : ""}index.d.ts`, default: `./${at ? `${at}/` : ""}index.js` };
  }
  // bins: the definition run as `tcm run` runs it (called with the arguments); a number it returns is the exit code
  const binField: Record<string, string> = {};
  for (const b of bins) {
    const comp = cb.store.getDef(b.hash)!.componentHash;
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bin", `${b.command}.js`),
      `#!/usr/bin/env node\n// generated by tcm pack: runs ${b.target}\nimport { ${exportId(b.hash)} as main } from "../modules/${comp}.js";\n` +
        `const result = typeof main === "function" ? await main(...process.argv.slice(2)) : main;\n` +
        `if (typeof result === "number") process.exitCode = result;\nelse if (result !== undefined) console.log(result);\n`,
      { mode: 0o755 },
    );
    binField[b.command] = `bin/${b.command}.js`;
  }
  for (const f of opts.files) {
    const from = path.resolve(cb.lay.root, f);
    if (!fs.existsSync(from)) throw new Error(`--files: ${f} doesn't exist`);
    const rel = path.relative(cb.lay.root, from);
    fs.cpSync(from, path.join(dir, rel.startsWith("..") ? path.basename(from) : rel), { recursive: true });
  }
  const pkg = {
    name: opts.name,
    version: opts.version,
    ...(opts.description ? { description: opts.description } : {}),
    type: "module",
    ...(Object.keys(binField).length ? { bin: binField } : {}),
    ...(Object.keys(exportsField).length ? { exports: exportsField } : {}),
    engines: { node: ">=22.18" },
    dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return { dir, modules: comps.length, dependencies: pkg.dependencies };
}
