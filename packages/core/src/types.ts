import type { ParamsSchema, TableSchema } from "./schema.ts";

export type DefKind = "term" | "type" | "class";
export type InitKind = "hoisted" | "strict";
export type RefPos = "value" | "type";

/** A reference to something outside the codebase: an npm package export or a Node builtin export. */
export interface ExtRef {
  /** `npm:<name>@<version>` or `node:<builtin>` */
  module: string;
  /** subpath within the package, "" for the package root */
  subpath: string;
  /** export name, `default`, or `*` for a namespace import */
  export: string;
}

/** A span of a definition's source text that names another definition or an external. */
export interface Span {
  start: number;
  end: number;
  pos: RefPos;
  hash?: string;
  ext?: ExtRef;
  /** set when the span is a shorthand property `{ x }`; holds the property name */
  shorthand?: string;
  /** the span is the string literal of a dynamic `import("pkg")`: splicing writes a module specifier */
  literal?: boolean;
}

export interface Dep {
  /** `#<hash>` for codebase definitions, ext ref string for externals */
  ref: string;
  pos: RefPos;
  strict: boolean;
}

/** Everything the store needs to know about one definition. */
export interface DefRecord {
  hash: string;
  kind: DefKind;
  componentHash: string;
  componentIndex: number;
  componentSize: number;
  ir: string;
  sourceText: string;
  spans: Span[];
  /** identifiers in the body that are not spliced (locals, globals); spliced names must avoid them */
  reservedNames: string[];
  initKind: InitKind;
  nameHint: string;
  /** the declared name is observable at runtime, so generated code must keep it */
  nominal: boolean;
  /** scratch-file only: the path a `// ucm: path` comment binds this definition to (not stored) */
  targetPath?: string;
  deps: Dep[];
  signature: string;
  doc?: string;
  /** runtime schema of a function's parameters (metadata, not hashed): checks arguments arriving from browsers */
  params?: ParamsSchema;
  /** for `const x = table<T>(...)`: the row type's schema (metadata, not hashed); attached to the value at runtime */
  table?: TableSchema;
}

/**
 * Names live in two spaces, like TypeScript's: a type and a value can share a path without conflicting.
 * A class is both.
 */
export function sameSpace(a: DefKind, b: DefKind): boolean {
  return a === "class" || b === "class" || (a === "type") === (b === "type");
}

/** Whether definitions sharing one path clash (any two in the same space). */
export function isConflicted(kinds: DefKind[]): boolean {
  return kinds.some((a, i) => kinds.some((b, j) => j > i && sameSpace(a, b)));
}

export function extRefString(e: ExtRef): string {
  return `${e.module}${e.subpath ? "/" + e.subpath : ""}#${e.export}`;
}

export function depRef(span: Span): string {
  return span.hash ? `#${span.hash}` : extRefString(span.ext!);
}
