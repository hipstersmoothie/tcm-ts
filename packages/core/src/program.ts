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

export function createProgram(rootFiles: string[], oldProgram?: ts.Program): ts.Program {
  return ts.createProgram({ rootNames: rootFiles, options: compilerOptions(), oldProgram });
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
