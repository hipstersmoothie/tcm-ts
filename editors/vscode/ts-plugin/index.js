// A TypeScript server plugin, loaded into VS Code's TypeScript server by the tcm-ts extension. It does two things:
//
// - Packages. A scratch file can import a package the project hasn't installed: tcm provides it, at the version
//   the code around it uses, from its cache. tcm records where for each scratch file in .tcm/packages.json; this
//   resolves the file's imports the same way, so the editor sees the same package tcm checks against. A file tcm
//   hasn't seen yet gets the newest copy in the cache.
// - Go to Definition. Codebase definitions reach scratch files through generated modules (.tcm/codebase
//   re-exports .tcm/cache/<hash>.ts), so TypeScript's answers land in generated code. The tcm language server
//   answers the same request with the definition's source (a tcm: document); this drops TypeScript's answers
//   that point into generated modules, so Cmd+click goes straight to the source instead of offering both.
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const GENERATED = /[\\/]\.tcm[\\/](cache|codebase)[\\/]/;

/** `react/jsx-runtime` → `react`, `@scope/pkg/sub` → `@scope/pkg`; undefined for relative, `#`, and builtins */
function packageNameOf(specifier) {
  if (/^[./#]/.test(specifier) || specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0])) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The codebase a file belongs to: the nearest directory above it with a .tcm. */
function tcmDirOf(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".tcm", "codebase.sqlite"))) return path.join(dir, ".tcm");
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** .tcm/packages.json, re-read when it changes */
const mappings = new Map();
function mappingOf(tcmDir) {
  const file = path.join(tcmDir, "packages.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = mappings.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    value = undefined;
  }
  mappings.set(file, { mtime, value });
  return value;
}

/** The newest range of `name` in the cache (`npm__react__19` over `npm__react__18`). */
function newestAlias(cacheDir, name) {
  const prefix = `npm__${name.replace(/^@/, "").replace("/", "__").toLowerCase()}__`;
  let names = [];
  try {
    names = fs.readdirSync(path.join(cacheDir, "node_modules")).filter((n) => n.startsWith(prefix));
  } catch {
    return undefined;
  }
  const num = (n) => n.slice(prefix.length).split(".").map(Number);
  names.sort((a, b) => {
    const x = num(a);
    const y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return names[0];
}

function init(modules) {
  const ts = modules && modules.typescript;
  return {
    create(info) {
      const ls = info.languageService;
      const proxy = Object.create(null);
      for (const k of Object.keys(ls)) proxy[k] = (...args) => ls[k](...args);
      // inside generated code (if someone opens it), leave navigation alone
      const keep = (file, defs) => (!defs || GENERATED.test(file) ? defs : defs.filter((d) => !GENERATED.test(d.fileName)));
      proxy.getDefinitionAtPosition = (file, pos) => keep(file, ls.getDefinitionAtPosition(file, pos));
      proxy.getDefinitionAndBoundSpan = (file, pos) => {
        const r = ls.getDefinitionAndBoundSpan(file, pos);
        return r && r.definitions ? { ...r, definitions: keep(file, r.definitions) } : r;
      };
      const host = info.languageServiceHost;
      if (ts && host) providePackages(ts, info, host);
      return proxy;
    },
  };
}

/** Resolve a scratch file's imports of packages tcm provides into tcm's cache, as tcm itself does. */
function providePackages(ts, info, host) {
  const original = host.resolveModuleNameLiterals ? host.resolveModuleNameLiterals.bind(host) : undefined;
  const sys = { fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, directoryExists: ts.sys.directoryExists, realpath: ts.sys.realpath, getDirectories: ts.sys.getDirectories };
  const plain = (lit, containingFile, redirected, options, sf) =>
    ts.resolveModuleName(lit.text, containingFile, options, sys, undefined, redirected, ts.getModeForUsageLocation(sf, lit, options));
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, options, sf, reused) => {
    const base = original ? original(literals, containingFile, redirected, options, sf, reused) : literals.map((lit) => plain(lit, containingFile, redirected, options, sf));
    if (GENERATED.test(containingFile)) return base;
    const tcmDir = tcmDirOf(containingFile);
    const mapping = tcmDir && mappingOf(tcmDir);
    if (!tcmDir) return base;
    const cacheDir = (mapping && mapping.cacheDir) || path.join(tcmDir, "cache");
    const forFile = (mapping && mapping.files && mapping.files[containingFile]) || {};
    return literals.map((lit, i) => {
      const name = packageNameOf(lit.text);
      if (!name) return base[i];
      // what tcm chose for this file; for a file it hasn't seen, the newest copy it has, if the project has none
      const alias = forFile[name] || (base[i] && base[i].resolvedModule ? undefined : newestAlias(cacheDir, name));
      if (!alias) return base[i];
      const mode = ts.getModeForUsageLocation(sf, lit, options);
      return ts.resolveModuleName(alias + lit.text.slice(name.length), path.join(cacheDir, "index.ts"), options, sys, undefined, redirected, mode);
    });
  };
  // when tcm records new choices, resolve again
  const project = info.project;
  const watched = new Set();
  const watch = () => {
    for (const root of host.getScriptFileNames ? host.getScriptFileNames() : []) {
      const tcmDir = tcmDirOf(root);
      if (!tcmDir || watched.has(tcmDir)) continue;
      watched.add(tcmDir);
      const watcher = fs.watchFile(path.join(tcmDir, "packages.json"), { interval: 500 }, () => {
        if (!project) return;
        try {
          if (project.resolutionCache && project.resolutionCache.clear) project.resolutionCache.clear();
          project.markAsDirty();
          if (project.refreshDiagnostics) project.refreshDiagnostics();
        } catch {
          // an older or newer tsserver without these: the next edit picks the change up
        }
      });
      // the server's own lifetime decides how long this lasts, not this watch
      if (watcher && watcher.unref) watcher.unref();
    }
  };
  try {
    watch();
  } catch {
    // no files yet
  }
}

module.exports = init;
