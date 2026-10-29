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
import { createProgram, exportId, ts, type DefKind } from "@tcm/core";
import { externalsOf, npmAlias, parseModule, render, type DefSource } from "@tcm/loader";
import type { NameRow } from "@tcm/store";
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
  /** the names to pack from (a release's), instead of the current branch's */
  names?: NameRow[];
  /** CHANGELOG.md's contents, for a release */
  changelog?: string;
  /** other packages of the codebase: what of theirs this one uses comes from their releases, not copied in */
  siblings?: Sibling[];
}

/** Another package of the codebase, and what its releases export. */
export interface Sibling {
  name: string;
  /** its own definitions (hash → name), where this package is packed from */
  owned: Map<string, string>;
  /** its releases, newest first: what each exports, by hash */
  releases: { version: string; exported: Map<string, { subpath: string; name: string }> }[];
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
function exportsOf(all: NameRow[], targets: string[]): Exported[] {
  const out: Exported[] = [];
  const taken = new Map<string, string>();
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

/**
 * Which components the package carries, and what it takes from its sibling packages instead: a definition one of
 * them owns comes from the oldest release of it that exports every such definition used, as it is here.
 */
function provide(cb: Codebase, roots: string[], siblings: Sibling[]) {
  const ownerOf = new Map<string, Sibling>();
  for (const s of siblings) for (const h of s.owned.keys()) ownerOf.set(h, s);
  const rootSet = new Set(roots);
  const used = new Map<Sibling, Set<string>>();
  const kept = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const h = queue.pop()!;
    const owner = ownerOf.get(h);
    if (owner && !rootSet.has(h)) {
      used.set(owner, (used.get(owner) ?? new Set()).add(h));
      continue;
    }
    const rec = cb.store.getDef(h);
    if (!rec || kept.has(rec.componentHash)) continue;
    kept.add(rec.componentHash);
    for (const m of cb.store.componentMembers(rec.componentHash)) for (const d of m.deps) if (d.ref.startsWith("#")) queue.push(d.ref.slice(1));
  }
  const provided = new Map<string, { module: string; name: string }>();
  const links: Record<string, string> = {};
  for (const [s, hashes] of used) {
    // the oldest release with all of it: the widest range of the other's versions this works with
    const release = s.releases.findLast((r) => [...hashes].every((h) => r.exported.has(h)));
    if (!release) {
      const latest = s.releases[0];
      const missing = [...hashes].filter((h) => !latest?.exported.has(h)).map((h) => s.owned.get(h)!).sort();
      throw new Error(
        `this uses ${missing.join(", ")} from ${s.name}, which ${latest ? `${s.name}@${latest.version} doesn't export as it is here` : `${s.name} hasn't released yet`}: release ${s.name} first (\`tcm release ${s.name}\`)${missing.some((m) => !latest) ? "" : ", or export what this uses"}`,
      );
    }
    links[s.name] = `^${release.version}`;
    for (const h of hashes) {
      const e = release.exported.get(h)!;
      provided.set(h, { module: e.subpath === "." ? s.name : `${s.name}/${e.subpath.replace(/^\.\//, "")}`, name: e.name });
    }
  }
  return { kept, provided, links };
}

/** Imports of modules another package provides, rewritten to import from that package by name. */
function fromSiblings(text: string, kept: Set<string>, provided: Map<string, { module: string; name: string }>): string {
  const target = (hash: string) => {
    const p = provided.get(hash);
    if (!p) throw new Error(`internal: #${hash.slice(0, 8)} is neither packed nor provided`);
    return p;
  };
  return text
    .replace(/import (type )?\{([^}]*)\} from "\.\/([a-z2-7]{52})\.js";/g, (m, type: string | undefined, specs: string, comp: string) => {
      if (kept.has(comp)) return m;
      const byModule = new Map<string, string[]>();
      for (const spec of specs.split(",").map((x) => x.trim()).filter(Boolean)) {
        const s = /^(type )?h_([a-z2-7]{52})(?: as ([\w$]+))?$/.exec(spec);
        if (!s) throw new Error(`internal: can't read the import '${spec}'`);
        const p = target(s[2]!);
        byModule.set(p.module, [...(byModule.get(p.module) ?? []), `${s[1] ?? ""}${p.name} as ${s[3] ?? `h_${s[2]}`}`]);
      }
      return [...byModule].map(([mod, ss]) => `import ${type ?? ""}{ ${ss.join(", ")} } from "${mod}";`).join("\n");
    })
    .replace(/import\("\.\/([a-z2-7]{52})\.js"\)\.h_([a-z2-7]{52})/g, (m, comp: string, hash: string) => {
      if (kept.has(comp)) return m;
      const p = target(hash);
      return `import("${p.module}").${p.name}`;
    });
}

export function pack(cb: Codebase, opts: PackOptions): { dir: string; modules: number; dependencies: Record<string, string> } {
  const subpaths = new Map<string, string[]>();
  for (const e of opts.entries) subpaths.set(e.subpath, [...(subpaths.get(e.subpath) ?? []), e.target]);
  const names = opts.names ?? cb.store.names();
  const entries = [...subpaths].map(([subpath, targets]) => ({ subpath, exports: exportsOf(names, targets) }));
  const valueAt = (target: string) => {
    if (!opts.names) return cb.lookupOne(target, "value");
    const hs = names.filter((n) => n.path === target && n.kind !== "type").map((n) => n.hash);
    if (hs.length !== 1) throw new Error(hs.length ? `'${target}' is conflicted` : `'${target}' isn't a value`);
    return hs[0]!;
  };
  const bins = opts.bins.map((b) => ({ ...b, hash: valueAt(b.target) }));
  const roots = [...entries.flatMap((e) => e.exports.map((x) => x.hash)), ...bins.map((b) => b.hash)];
  // every component the code needs, to compile it; those it carries are the ones other packages don't provide
  const comps = [...cb.closureComponents(roots)];
  const { kept, provided, links } = provide(cb, roots, opts.siblings ?? []);
  // generated without source maps: the published modules are the code
  const base = cb.source();
  const src: DefSource = { get: base.get, members: base.members, nameOf: base.nameOf };

  // the package's dependencies: every package the code imports, at its locked version
  const modules = new Set<string>();
  for (const c of kept) for (const e of externalsOf(src.members(c))) if (e.module.startsWith("npm:")) modules.add(e.module);
  const byName = new Map<string, string[]>();
  for (const m of modules) {
    const { name } = parseModule(m);
    byName.set(name, [...(byName.get(name) ?? []), m]);
  }
  const dependencies: Record<string, string> = { ...links };
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
      if (kept.has(c) && text.includes('"./tcm-server.js"')) server = true;
      const file = path.join(work, `${c}${members.some((m) => m.jsx) ? ".tsx" : ".ts"}`);
      fs.writeFileSync(file, text);
      files.push(file);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const outModules = path.join(dir, "modules");
    if (server) {
      for (const f of ["tcm-server.js", "tcm-server.d.ts"]) fs.copyFileSync(path.join(cb.lay.cacheDir, f), path.join(work, f));
    }
    const { program } = createProgram(files, {
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
    const emitted = program.emitToString();
    for (const [file, { text }] of emitted.outputFiles) {
      // what another package provides is imported from it, not shipped again
      if (!kept.has(path.basename(file).replace(/\.(d\.ts|js)$/, ""))) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fromSiblings(forPackage(text, aliases), kept, provided));
    }
    const missing = files.filter((f) => kept.has(path.basename(f).replace(/\.tsx?$/, ""))).filter((f) => !fs.existsSync(path.join(outModules, path.basename(f).replace(/\.tsx?$/, ".js"))));
    if (missing.length) {
      const why = emitted.diagnostics.map((d) => d.text).slice(0, 3).join("\n");
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
  if (opts.changelog) fs.writeFileSync(path.join(dir, "CHANGELOG.md"), opts.changelog);
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
  return { dir, modules: kept.size, dependencies: pkg.dependencies };
}
