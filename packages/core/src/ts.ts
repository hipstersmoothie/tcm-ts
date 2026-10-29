// TypeScript, for tcm: TypeScript 7's syntax trees (`typescript/ast`) and its compiler (`typescript/sync`: a native
// process, one per tcm process, spoken to over a channel), plus the handful of helpers TypeScript 6 had that tcm
// relies on. Import it as a namespace (`import * as ts from "./ts.ts"`): `ts.SyntaxKind`, `ts.isIdentifier`,
// `ts.Node`, as before.
//
// The compiler can also be tsrs (TypeScript 7 rewritten in Rust, with the same API): `TCM_TYPESCRIPT=tsrs`, or a
// path to either compiler's binary.
import { createRequire } from "node:module";
import path from "node:path";
import { API, type Checker, type Symbol } from "typescript/sync";
import { NodeFlags, SyntaxKind, isModifier, type Node, type NodeArray, type ModifierLike, type Modifier, type SourceFile } from "typescript/ast";

export * from "typescript/ast";
export {
  API,
  Checker,
  ModuleResolver,
  LanguageService,
  CheckFlags,
  DiagnosticCategory,
  ElementFlags,
  IndexKind,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  NodeBuilderFlags,
  ObjectFlags,
  Program,
  Project,
  SignatureFlags,
  SignatureKind,
  Snapshot,
  Symbol,
  SymbolFlags,
  TypeFlags,
  TypeFormatFlags,
  isTupleType,
  isTypeReference,
  isUnionType,
  isIntersectionType,
  isObjectType,
  isStringLiteralType,
  isNumberLiteralType,
  isBooleanLiteralType,
  isLiteralType,
  isTypeParameter,
  formatDiagnosticsWithColorAndContext,
} from "typescript/sync";
export type { Signature, Type, NodeHandle, Diagnostic, TypeReference, UnionOrIntersectionType, ObjectType, LiteralType, IndexInfo, StringLiteralType, NumberLiteralType } from "typescript/sync";
/** TypeScript 6's name for it */
export type TypeChecker = Checker;

const require = createRequire(import.meta.url);
export const version: string = (require("typescript") as { version: string }).version;

/**
 * The compiler binary: TypeScript 7's own, or tsrs's (`TCM_TYPESCRIPT=tsrs`: the project's tsrs package, else one
 * installed alongside tcm), or one named by path.
 */
function compilerBinary(): string | undefined {
  const choice = process.env.TCM_TYPESCRIPT;
  if (!choice || choice === "typescript") return undefined;
  if (choice !== "tsrs") return choice;
  let pkg: string | undefined;
  for (const from of [path.join(process.cwd(), "package.json"), import.meta.filename]) {
    try {
      pkg = createRequire(from).resolve("tsrs/package.json");
      break;
    } catch {
      // not here
    }
  }
  if (!pkg) throw new Error("TCM_TYPESCRIPT=tsrs, but tsrs isn't installed: npm install --save-dev tsrs");
  // the binary ships in a per-platform package; tsrs's own helper finds it
  return (require(path.join(path.dirname(pkg), "lib", "getExePath.js")) as { default: () => string }).default();
}

/**
 * TypeScript 7's API decodes each string it reads (a file's text, a literal's) with a TextDecoder that drops a
 * leading byte order mark, so the literal "\uFEFFx" would read as "x". Put it back, in the decoder's class (the API
 * and each program have one).
 */
function keepByteOrderMarks(decoder: object): void {
  const proto = Object.getPrototypeOf(decoder) as { decode(input?: ArrayBufferView | ArrayBuffer, options?: unknown): string; tcmKeepsBom?: true };
  if (proto.tcmKeepsBom) return;
  const decode = proto.decode;
  proto.decode = function (input, options) {
    const s = decode.call(this, input, options);
    if (!input || s.charCodeAt(0) === 0xfeff) return s;
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "\uFEFF" + s : s;
  };
  proto.tcmKeepsBom = true;
}

let api: API | undefined;
/** The compiler process this process talks to, started on first use and kept for its life. */
export function compiler(): API {
  if (!api) {
    api = new API({ cwd: process.cwd(), tsserverPath: compilerBinary() });
    keepByteOrderMarks((api as unknown as { decoder: object }).decoder);
  }
  return api;
}

/** Parse some code on its own, outside any program (TypeScript 6's `createSourceFile`). */
export function parse(fileName: string, text: string): SourceFile {
  const retained = compiler().createSourceFile(fileName, text);
  const sf = retained.sourceFile;
  retained.dispose();
  return sf;
}

/** A hole in an array pattern, `[, x]`: an omitted expression, or (as TypeScript 7 parses it) a binding element with no name. */
export const isOmitted = (node: Node): boolean => node.kind === SyntaxKind.OmittedExpression || (node.kind === SyntaxKind.BindingElement && !(node as { name?: Node }).name);

/** A symbol's declaration, as a node (fetched from the compiler: its value declaration, else its first). */
export function declarationOf(symbol: Symbol): Node | undefined {
  const handle = symbol.valueDeclaration ?? symbol.declarations?.[0];
  try {
    return handle?.resolve() as Node | undefined;
  } catch {
    return undefined;
  }
}

// ---- what TypeScript 6 had ----------------------------------------------------------------------------------

/** A node's children, as `ts.forEachChild` gave them. */
export function forEachChild<T>(node: Node, cbNode: (node: Node) => T, cbNodes?: (nodes: NodeArray<Node>) => T): T | undefined {
  return node.forEachChild(cbNode, cbNodes);
}

const FUNCTION_LIKE = new Set<SyntaxKind>([
  SyntaxKind.MethodSignature,
  SyntaxKind.CallSignature,
  SyntaxKind.JSDocSignature,
  SyntaxKind.ConstructSignature,
  SyntaxKind.IndexSignature,
  SyntaxKind.FunctionType,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
]);

/** Functions, methods, accessors, constructors and their signatures (TypeScript 6's `isFunctionLike`). */
export const isFunctionLike = (node: Node | undefined): boolean => !!node && FUNCTION_LIKE.has(node.kind);

export const isClassLike = (node: Node | undefined): boolean => !!node && (node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.ClassExpression);

/** A node's modifiers, decorators left out. */
export function getModifiers(node: Node): readonly Modifier[] | undefined {
  const mods = (node as { modifiers?: NodeArray<ModifierLike> }).modifiers;
  return mods?.filter((m): m is Modifier => isModifier(m));
}

/** `import type { … }` */
export const isTypeOnlyImport = (clause: { phaseModifier?: SyntaxKind } | undefined): boolean => clause?.phaseModifier === SyntaxKind.TypeKeyword;

export const canHaveModifiers = (node: Node): boolean => "modifiers" in node && (node as { modifiers?: unknown }).modifiers !== undefined;

/** `a?.b`, and the parts of the chain after it (`a?.b.c`). */
export function isOptionalChain(node: Node): boolean {
  const k = node.kind;
  return !!(node.flags & NodeFlags.OptionalChain) && (k === SyntaxKind.PropertyAccessExpression || k === SyntaxKind.ElementAccessExpression || k === SyntaxKind.CallExpression || k === SyntaxKind.NonNullExpression);
}

export { isParameterDeclaration as isParameter, isPropertySignatureDeclaration as isPropertySignature, isMethodSignatureDeclaration as isMethodSignature, isTypeAssertion as isTypeAssertionExpression, isStringLiteralLikeNode as isStringLiteralLike } from "typescript/ast";
