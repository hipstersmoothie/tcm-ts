import ts from "typescript";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** `@types` directory shipped with tcm, so projects typecheck without installing @types/node. */
export const tcmTypeRoots = [path.dirname(path.dirname(require.resolve("@types/node/package.json")))];

export const TS_VERSION = ts.version;

export function compilerOptions(): ts.CompilerOptions {
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
const REQUIRED: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
};

/**
 * Compiler options for a project: its `tsconfig.json` if there is one (lib, strictness, types, ... are the
 * project's choice), with the options tcm requires forced on top. Warnings name the settings that were overridden.
 */
/**
 * For importing existing code: tcm renders its own imports (by hash, with `import type` decided by tcm), so the
 * project's resolution style doesn't matter, and most projects are written for bundler resolution: every file is
 * ESM and relative imports can omit extensions. Only what Node's type stripping needs to run the code is forced.
 */
const REQUIRED_FOR_IMPORT: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  // enums, namespaces and parameter properties are allowed: their modules are compiled when run
  erasableSyntaxOnly: false,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: false,
};

export function projectCompilerOptions(tsconfig: string | undefined, mode: "scratch" | "import" = "scratch"): { options: ts.CompilerOptions; warnings: string[] } {
  const required = mode === "import" ? REQUIRED_FOR_IMPORT : REQUIRED;
  if (!tsconfig || !ts.sys.fileExists(tsconfig)) return { options: { ...compilerOptions(), ...(mode === "import" ? required : {}) }, warnings: [] };
  const warnings: string[] = [];
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) return { options: compilerOptions(), warnings: [`${tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}; using tcm's defaults`] };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig), undefined, tsconfig);
  for (const e of parsed.errors.filter((e) => e.code !== 18003)) warnings.push(`${tsconfig}: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`);
  // deprecations TypeScript 6 turned into errors (baseUrl, node10 resolution, ...) aren't the code's problem
  const options: ts.CompilerOptions = { skipLibCheck: true, ignoreDeprecations: "6.0", ...parsed.options };
  // without its own `types`, a project gets tcm's @types/node, so scratch files typecheck without installing it
  if (options.types === undefined) Object.assign(options, { typeRoots: tcmTypeRoots, types: ["node"] });
  for (const [k, v] of Object.entries(required) as [keyof ts.CompilerOptions, unknown][]) {
    // in import mode, resolution settings are tcm's business (it renders imports itself): no need to mention them
    const quiet = mode === "import" && ["module", "moduleResolution", "verbatimModuleSyntax", "erasableSyntaxOnly"].includes(k as string);
    if (!quiet && parsed.options[k] !== undefined && parsed.options[k] !== v) warnings.push(`${path.basename(tsconfig)}: tcm requires \`${k}\` = ${k === "module" || k === "moduleResolution" ? "NodeNext" : String(v)}, ignoring the project's setting`);
    (options as Record<string, unknown>)[k] = v;
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

export function checkProfile(options: ts.CompilerOptions): CheckProfile {
  const out: CheckProfile = {};
  for (const k of PROFILE_KEYS) if (options[k] !== undefined) out[k] = options[k];
  return out;
}

/** The TypeScript runtime tcm uses, for compiling generated modules that use non-erasable syntax. */
export function transpileForNode(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, preserveConstEnums: true, isolatedModules: true, verbatimModuleSyntax: false, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}

/** Where that TypeScript lives, for processes that compile on their own (runners spawned by tcm). */
export function typescriptUrl(): string | undefined {
  try {
    return pathToFileURL(require.resolve("typescript")).href;
  } catch {
    return undefined;
  }
}

export function createProgram(rootFiles: string[], oldProgram?: ts.Program, options: ts.CompilerOptions = compilerOptions()): ts.Program {
  return ts.createProgram({ rootNames: rootFiles, options, oldProgram });
}

/**
 * Where a bare package import in a scratch file resolves when tcm provides the package: the specifier to resolve
 * instead (`npm__react__19`, the cache's alias for the version chosen for that file) and the file to resolve it
 * from. Undefined leaves the import to ordinary resolution (the project's own node_modules).
 */
export type PackageResolver = ((name: string, containingFile: string) => { specifier: string; from: string } | undefined) & {
  /** identifies the mapping: a compiler keeps resolutions per key, so a changed mapping resolves afresh */
  key?: string;
};

/** `overlay`: files' unsaved text (an editor's open buffers), read instead of the disk; `packages`: see PackageResolver */
export type Compile = (rootFiles: string[], options: ts.CompilerOptions, overlay?: ReadonlyMap<string, string>, packages?: PackageResolver) => ts.Program;

/** The package an import names: `react/jsx-runtime` → `react`, `@scope/pkg/sub` → `@scope/pkg`. */
export function packageNameOf(specifier: string): string | undefined {
  if (/^[./#]/.test(specifier) || specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]!)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** `resolveModuleNameLiterals` for a host: provided packages through `packages`, everything else as usual. */
function resolvingThrough(packages: () => PackageResolver | undefined, options: () => ts.CompilerOptions, host: ts.ModuleResolutionHost) {
  return (literals: readonly ts.StringLiteralLike[], containingFile: string, redirected: ts.ResolvedProjectReference | undefined, _o: ts.CompilerOptions, sf: ts.SourceFile): ts.ResolvedModuleWithFailedLookupLocations[] =>
    literals.map((lit) => {
      const o = options();
      const mode = ts.getModeForUsageLocation(sf, lit, o);
      const name = packageNameOf(lit.text);
      const provided = name ? packages()?.(name, containingFile) : undefined;
      if (provided) return ts.resolveModuleName(provided.specifier + lit.text.slice(name!.length), provided.from, o, host, undefined, redirected, mode);
      return ts.resolveModuleName(lit.text, containingFile, o, host, undefined, redirected, mode);
    });
}

/**
 * A long-lived compiler for checking the same files again and again (the watcher). A plain program re-reads
 * and re-parses every file each time, the standard library and @types/node included; this one is a
 * LanguageService over a document registry, so only files whose version (mtime and size) changed are parsed
 * again.
 */
export function incrementalCompiler(): Compile {
  const registry = ts.createDocumentRegistry();
  const services = new Map<string, { roots: string[]; service: ts.LanguageService }>();
  // nanosecond mtimes: two quick writes of the same size within a millisecond still differ
  const version = (file: string) => {
    const st = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    return st ? `${st.mtimeNs}:${st.size}` : "0";
  };
  let overlay: ReadonlyMap<string, string> = new Map();
  let packages: PackageResolver | undefined;
  const overlaid = new Map<string, string>();
  const textVersion = (text: string) => createHash("sha1").update(text).digest("hex");
  return (rootFiles, options, current = new Map(), provided) => {
    overlay = current;
    packages = provided;
    const key = JSON.stringify(options) + (provided?.key ?? "");
    let s = services.get(key);
    if (!s) {
      const entry = { roots: rootFiles } as { roots: string[]; service: ts.LanguageService };
      const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => entry.roots,
        getScriptVersion: (f) => {
          const text = overlay.get(f);
          if (text === undefined) return version(f);
          let v = overlaid.get(text);
          if (!v) overlaid.set(text, (v = `buffer:${textVersion(text)}`));
          if (overlaid.size > 200) overlaid.clear();
          return v;
        },
        getScriptSnapshot: (f) => {
          const text = overlay.get(f) ?? ts.sys.readFile(f);
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCompilationSettings: () => options,
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        fileExists: (f) => overlay.has(f) || ts.sys.fileExists(f),
        readFile: (f) => overlay.get(f) ?? ts.sys.readFile(f),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        realpath: ts.sys.realpath,
      };
      host.resolveModuleNameLiterals = resolvingThrough(() => packages, () => options, host);
      entry.service = ts.createLanguageService(host, registry);
      services.set(key, (s = entry));
    }
    s.roots = rootFiles;
    return s.service.getProgram()!;
  };
}

export interface Diagnostic {
  code: number;
  message: string;
  formatted: string;
}

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => "\n",
};

export function fileDiagnostics(program: ts.Program, sf: ts.SourceFile, ignore: number[] = [], includeGlobal = true): Diagnostic[] {
  const all = [
    ...(includeGlobal ? [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()] : []),
    ...program.getSyntacticDiagnostics(sf),
    ...program.getSemanticDiagnostics(sf),
  ].filter((d) => !ignore.includes(d.code));
  return all.map((d) => ({
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    formatted: ts.formatDiagnosticsWithColorAndContext([d], formatHost),
  }));
}
