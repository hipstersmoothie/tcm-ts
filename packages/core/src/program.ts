import ts from "typescript";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** `@types` directory shipped with ucm, so projects typecheck without installing @types/node. */
export const ucmTypeRoots = [path.dirname(path.dirname(require.resolve("@types/node/package.json")))];

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
    skipLibCheck: true,
    typeRoots: ucmTypeRoots,
    types: ["node"],
  };
}

/**
 * Options ucm's model depends on: NodeNext resolution (import classification and `#codebase` go through it),
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
 * project's choice), with the options ucm requires forced on top. Warnings name the settings that were overridden.
 */
export function projectCompilerOptions(tsconfig: string | undefined): { options: ts.CompilerOptions; warnings: string[] } {
  if (!tsconfig || !ts.sys.fileExists(tsconfig)) return { options: compilerOptions(), warnings: [] };
  const warnings: string[] = [];
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) return { options: compilerOptions(), warnings: [`${tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}; using ucm's defaults`] };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig), undefined, tsconfig);
  for (const e of parsed.errors.filter((e) => e.code !== 18003)) warnings.push(`${tsconfig}: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`);
  const options: ts.CompilerOptions = { skipLibCheck: true, ...parsed.options };
  // without its own `types`, a project gets ucm's @types/node, so scratch files typecheck without installing it
  if (options.types === undefined) Object.assign(options, { typeRoots: ucmTypeRoots, types: ["node"] });
  for (const [k, v] of Object.entries(REQUIRED) as [keyof ts.CompilerOptions, unknown][]) {
    if (parsed.options[k] !== undefined && parsed.options[k] !== v) warnings.push(`${path.basename(tsconfig)}: ucm requires \`${k}\` = ${k === "module" ? "NodeNext" : k === "moduleResolution" ? "NodeNext" : String(v)}, ignoring the project's setting`);
    (options as Record<string, unknown>)[k] = v;
  }
  delete options.outDir;
  delete options.declaration;
  return { options, warnings };
}

export function createProgram(rootFiles: string[], oldProgram?: ts.Program, options: ts.CompilerOptions = compilerOptions()): ts.Program {
  return ts.createProgram({ rootNames: rootFiles, options, oldProgram });
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
