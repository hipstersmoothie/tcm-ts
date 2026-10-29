// The compiler tcm checks code with: TypeScript 7 (see ts.ts), driven through its API. A program is a snapshot of
// files (scratch files' unsaved text layered over the disk) compiled by the long-lived compiler process.
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "./ts.ts";
import { exportId } from "./hash.ts";

const require = createRequire(import.meta.url);

/** `@types` directory shipped with tcm, so projects typecheck without installing @types/node. */
export const tcmTypeRoots = [path.dirname(path.dirname(require.resolve("@types/node/package.json")))];

export const TS_VERSION = ts.version;

/** Compiler options, as TypeScript 7 takes them (enums as numbers, `lib` by name). */
export type CompilerOptions = Record<string, unknown> & {
  module?: number;
  moduleResolution?: number;
  target?: number;
  jsx?: number;
  lib?: string[];
  types?: string[];
  typeRoots?: string[];
  paths?: Record<string, string[]>;
  jsxImportSource?: string;
};

export function compilerOptions(): CompilerOptions {
  return {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    lib: ["lib.esnext.d.ts"],
    strict: true,
    noEmit: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    typeRoots: tcmTypeRoots,
    types: ["node"],
  };
}

/**
 * Options tcm's model depends on: NodeNext resolution (import classification and `#codebase` go through it),
 * the syntax Node's type stripping can run, and no emit.
 */
const REQUIRED: CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
};

/**
 * For importing existing code: tcm renders its own imports (by hash, with `import type` decided by tcm), so the
 * project's resolution style doesn't matter, and most projects are written for bundler resolution: every file is
 * ESM and relative imports can omit extensions. Only what Node's type stripping needs to run the code is forced.
 */
const REQUIRED_FOR_IMPORT: CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  // enums, namespaces and parameter properties are allowed: their modules are compiled when run
  erasableSyntaxOnly: false,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: false,
};

const ENUM_NAMES: Record<string, Record<number, string>> = { module: ts.ModuleKind, moduleResolution: ts.ModuleResolutionKind } as never;

/**
 * Compiler options for a project: its `tsconfig.json` if there is one (lib, strictness, types, ... are the
 * project's choice), with the options tcm requires forced on top. Warnings name the settings that were overridden.
 */
export function projectCompilerOptions(tsconfig: string | undefined, mode: "scratch" | "import" = "scratch"): { options: CompilerOptions; warnings: string[] } {
  const required = mode === "import" ? REQUIRED_FOR_IMPORT : REQUIRED;
  if (!tsconfig || !fs.existsSync(tsconfig)) return { options: { ...compilerOptions(), ...(mode === "import" ? required : {}) }, warnings: [] };
  const warnings: string[] = [];
  let parsed: { options: CompilerOptions; errors?: readonly ts.Diagnostic[] };
  try {
    parsed = ts.compiler().parseConfigFile(tsconfig) as unknown as typeof parsed;
  } catch (e) {
    return { options: compilerOptions(), warnings: [`${tsconfig}: ${(e as Error).message.split("\n")[0]}; using tcm's defaults`] };
  }
  // "no inputs were found" is about the project's own build, not tcm's
  for (const e of (parsed.errors ?? []).filter((e) => e.code !== 18003)) warnings.push(`${tsconfig}: ${e.text}`);
  const options: CompilerOptions = { skipLibCheck: true, ...parsed.options };
  delete options.configFilePath;
  // without the config file, the compiler would look for @types from its working directory: look from the
  // project's, as TypeScript does (node_modules/@types in it and each directory above)
  if (options.typeRoots === undefined) {
    const roots: string[] = [];
    for (let d = path.dirname(path.resolve(tsconfig)); ; d = path.dirname(d)) {
      roots.push(path.join(d, "node_modules", "@types"));
      if (path.dirname(d) === d) break;
    }
    options.typeRoots = roots;
  }
  // without its own `types`, a project gets tcm's @types/node, so scratch files typecheck without installing it
  if (options.types === undefined) Object.assign(options, { typeRoots: tcmTypeRoots, types: ["node"] });
  for (const [k, v] of Object.entries(required)) {
    // in import mode, resolution settings are tcm's business (it renders imports itself): no need to mention them
    const quiet = mode === "import" && ["module", "moduleResolution", "verbatimModuleSyntax", "erasableSyntaxOnly"].includes(k);
    if (!quiet && parsed.options[k] !== undefined && parsed.options[k] !== v) {
      warnings.push(`${path.basename(tsconfig)}: tcm requires \`${k}\` = ${ENUM_NAMES[k] ? ENUM_NAMES[k][v as number] : String(v)}, ignoring the project's setting`);
    }
    options[k] = v;
  }
  // JSX compiles to the automatic runtime (`react/jsx-runtime`, or the project's jsxImportSource), which generated
  // modules import by pinned version
  if (options.jsx !== ts.JsxEmit.ReactJSX && options.jsx !== ts.JsxEmit.ReactJSXDev) {
    if (options.jsx !== undefined) warnings.push(`${path.basename(tsconfig)}: tcm compiles JSX with the automatic runtime (\`jsx\` = react-jsx), ignoring the project's setting`);
    options.jsx = ts.JsxEmit.ReactJSX;
  }
  // emit options mean nothing here (nothing is emitted), and some are invalid without the others
  for (const k of ["outDir", "declaration", "declarationMap", "emitDeclarationOnly", "isolatedDeclarations", "composite", "incremental", "tsBuildInfoFile", "sourceMap"]) delete options[k];
  return { options, warnings };
}

/**
 * The options that decide whether code typechecks (strictness, lib, target). A definition is valid under the
 * options it was checked with, so it records these and is re-checked with them later (verify, update, receive).
 */
const PROFILE_KEYS = [
  "strict", "noImplicitAny", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply", "strictPropertyInitialization",
  "strictBuiltinIteratorReturn", "noImplicitThis", "useUnknownInCatchVariables", "alwaysStrict", "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess", "noImplicitReturns", "noImplicitOverride", "noPropertyAccessFromIndexSignature", "lib", "target",
] as const;

export type CheckProfile = Partial<Record<(typeof PROFILE_KEYS)[number], unknown>>;

export function checkProfile(options: CompilerOptions): CheckProfile {
  const out: CheckProfile = {};
  for (const k of PROFILE_KEYS) if (options[k] !== undefined) out[k] = options[k];
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A source map's mappings, decoded: per generated line, segments of [column, source, line, column] (absolute). */
function decodeMappings(mappings: string): number[][][] {
  const state = [0, 0, 0, 0];
  return mappings.split(";").map((line) => {
    state[0] = 0;
    return line
      .split(",")
      .filter(Boolean)
      .map((seg) => {
        const values: number[] = [];
        for (let i = 0, shift = 0, v = 0; i < seg.length; i++) {
          const d = B64.indexOf(seg[i]!);
          v += (d & 31) << shift;
          if (d & 32) shift += 5;
          else {
            values.push(v & 1 ? -(v >>> 1) : v >>> 1);
            v = 0;
            shift = 0;
          }
        }
        for (let k = 0; k < values.length; k++) state[k]! += values[k]!;
        return state.slice(0, values.length);
      });
  });
}

function encodeMappings(lines: number[][][]): string {
  const vlq = (n: number) => {
    let v = n < 0 ? (-n << 1) | 1 : n << 1;
    let out = "";
    do {
      let d = v & 31;
      v >>>= 5;
      if (v) d |= 32;
      out += B64[d];
    } while (v);
    return out;
  };
  const prev = [0, 0, 0, 0];
  return lines
    .map((segs) => {
      prev[0] = 0;
      return segs
        .map((seg) => {
          const out = seg.map((v, k) => vlq(v - prev[k]!)).join("");
          seg.forEach((v, k) => (prev[k] = v));
          return out;
        })
        .join(",");
    })
    .join(";");
}

const INLINE_MAP = /\n?\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/;

/**
 * The TypeScript runtime tcm uses, for compiling generated modules that use non-erasable syntax (JSX, enums). The
 * output keeps the module's own source map, composed through the compilation, so it still leads to the
 * definition (or scratch file) the code came from.
 */
export function transpileForNode(source: string, fileName: string): string {
  const input = INLINE_MAP.exec(source);
  const out = ts.compiler().transpileModule(input ? source.slice(0, input.index) : source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, preserveConstEnums: true, isolatedModules: true, verbatimModuleSyntax: false, jsx: ts.JsxEmit.ReactJSX,
      sourceMap: true,
    } as never,
  });
  const code = out.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/, "");
  if (!input || !out.sourceMapText) return code;
  const outer = JSON.parse(out.sourceMapText) as { mappings: string };
  const inner = JSON.parse(Buffer.from(input[1]!, "base64").toString("utf8")) as { sources: string[]; mappings: string };
  const innerLines = decodeMappings(inner.mappings);
  // each compiled position → where it was in the module → where that was in the definition
  const composed = decodeMappings(outer.mappings).map((segs) =>
    segs.flatMap(([gen, , line, col]) => {
      const at = (innerLines[line!] ?? []).filter((s) => s[0]! <= col!).at(-1);
      return at ? [[gen!, at[1]!, at[2]!, at[3]! + (col! - at[0]!)]] : [];
    }),
  );
  const map = JSON.stringify({ version: 3, sources: inner.sources, names: [], mappings: encodeMappings(composed) });
  return `${code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString("base64")}\n`;
}

/**
 * Where transpileForNode can be imported from, for processes that load the same compilation through a module
 * hook: this module and the export to import (by name from source; by hash when tcm runs from a codebase,
 * where a function carries its hash).
 */
export function transpileModule(): { url: string; export: string; transpile: typeof transpileForNode } {
  const hash = (transpileModule as unknown as Record<symbol, string | undefined>)[Symbol.for("tcm.hash")];
  return { url: import.meta.url, export: hash ? exportId(hash) : "transpileModule", transpile: transpileForNode };
}

/** Where TypeScript lives, for processes that compile on their own (runners spawned by tcm). */
export function typescriptUrl(): string | undefined {
  try {
    return pathToFileURL(require.resolve("typescript")).href;
  } catch {
    return undefined;
  }
}

/**
 * Where a bare package import in a scratch file resolves when tcm provides the package: the cache's directory for
 * the version chosen for that file. Undefined leaves the import to ordinary resolution (the project's own
 * node_modules).
 */
export type PackageResolver = ((name: string, containingFile: string) => { specifier: string; from: string } | undefined) & {
  /** identifies the mapping: a compiler keeps resolutions per key, so a changed mapping resolves afresh */
  key?: string;
};

/** A compiled program, and the checker that answers questions about it. */
export interface Checked {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** the editor's questions (references, imports), about the same program */
  service: ts.LanguageService;
  options: CompilerOptions;
}

/** `overlay`: files' unsaved text (an editor's open buffers), read instead of the disk; `packages`: see PackageResolver */
export type Compile = (rootFiles: string[], options: CompilerOptions, overlay?: ReadonlyMap<string, string>, packages?: PackageResolver) => Checked;

/** The package an import names: `react/jsx-runtime` → `react`, `@scope/pkg/sub` → `@scope/pkg`. */
export function packageNameOf(specifier: string): string | undefined {
  if (/^[./#]/.test(specifier) || specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]!)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Provided packages as `paths`: each import of one in the root files (and a .tsx file's JSX runtime) mapped to the
 * file it resolves to as the package's cache alias (`react/jsx-runtime` → `npm__react__19/jsx-runtime`, resolved
 * from the cache, where its DefinitelyTyped types are found as usual).
 */
function providedPaths(
  rootFiles: string[],
  options: CompilerOptions,
  overlay: ReadonlyMap<string, string> | undefined,
  packages: PackageResolver | undefined,
  resolver: () => ts.ModuleResolver,
): Record<string, string[]> | undefined {
  if (!packages) return undefined;
  const paths: Record<string, string[]> = {};
  for (const file of rootFiles) {
    let text = overlay?.get(file);
    if (text === undefined) {
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
    }
    const specs = ts.parse(file, text).imports.map((n) => (n as ts.StringLiteral).text);
    if (/\.[cm]?tsx$/.test(file)) specs.push(`${(options.jsxImportSource as string | undefined) ?? "react"}/jsx-runtime`);
    for (const spec of specs) {
      const name = packageNameOf(spec);
      const target = name && !paths[spec] ? packages(name, file) : undefined;
      if (!name || !target) continue;
      const resolved = resolver().resolveModuleName(target.specifier + spec.slice(name.length), path.dirname(target.from), ts.ModuleKind.ESNext);
      if (resolved.resolvedModule) paths[spec] = [resolved.resolvedModule.resolvedFileName];
    }
  }
  return Object.keys(paths).length ? paths : undefined;
}

/**
 * Compile files: a snapshot of them (overlay text over the disk) in the compiler process. Snapshots read the disk
 * afresh, and the compiler keeps what it parsed (the standard library, @types/node) between them, so a new one is
 * quick. A compilation stays usable until the same files are compiled again (an editor's open files each keep
 * theirs), or until it's one of more than `keep` others since.
 */
export function incrementalCompiler(keep = 8): Compile {
  const live = new Map<string, ts.Snapshot>();
  // resolving provided packages: one resolver per mapping and options, made again when either changes
  let resolver: { key: string; resolver: ts.ModuleResolver } | undefined;
  const release = (s: ts.Snapshot | undefined) => {
    try {
      s?.dispose();
    } catch {
      // the compiler has already let it go
    }
  };
  return (rootFiles, options, overlay, packages) => {
    const resolverKey = `${packages?.key ?? ""}\0${JSON.stringify(options)}`;
    const paths = providedPaths(rootFiles, options, overlay, packages, () => {
      if (resolver?.key !== resolverKey) {
        resolver?.resolver.dispose();
        resolver = { key: resolverKey, resolver: ts.compiler().createModuleResolver(options as never) };
      }
      return resolver.resolver;
    });
    const compilerOptions = paths ? { ...options, paths: { ...(options.paths ?? {}), ...paths } } : options;
    const files: Record<string, string> = {};
    for (const [f, text] of overlay ?? []) files[f] = text;
    const snapshot = ts.compiler().createSnapshot({
      ...(overlay?.size ? { fileSystem: { kind: "layer", files } } : {}),
      createPrograms: [{ rootFiles, compilerOptions: compilerOptions as never }],
    } as never) as unknown as ts.Snapshot;
    const project = snapshot.getProjects()[0]!;
    const key = rootFiles.join("\0");
    release(live.get(key));
    live.delete(key);
    live.set(key, snapshot);
    for (const [k, s] of live) {
      if (live.size <= keep) break;
      release(s);
      live.delete(k);
    }
    return { program: project.program, checker: project.checker, service: project.languageService, options: compilerOptions };
  };
}

/** A one-off compilation (`overlay`: files' text, read instead of the disk). */
export function createProgram(rootFiles: string[], options: CompilerOptions = compilerOptions(), overlay?: ReadonlyMap<string, string>, packages?: PackageResolver): Checked {
  return incrementalCompiler()(rootFiles, options, overlay, packages);
}

export interface Diagnostic {
  code: number;
  message: string;
  formatted: string;
}

const formatHost = {
  getCanonicalFileName: (f: string) => f,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => "\n",
};

export function fileDiagnostics(program: ts.Program, sf: ts.SourceFile, ignore: number[] = [], includeGlobal = true, skip?: (d: ts.Diagnostic) => boolean): Diagnostic[] {
  const file = sf.fileName;
  const all = [
    ...(includeGlobal ? [...program.getProgramDiagnostics(), ...program.getGlobalDiagnostics()] : []),
    ...program.getSyntacticDiagnostics(file),
    ...program.getSemanticDiagnostics(file),
  ].filter((d) => !ignore.includes(d.code) && !skip?.(d));
  return all.map((d) => ({
    code: d.code,
    message: d.text,
    formatted: ts.formatDiagnosticsWithColorAndContext([d], formatHost as never),
  }));
}
