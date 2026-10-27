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
}

export function extRefString(e: ExtRef): string {
  return `${e.module}${e.subpath ? "/" + e.subpath : ""}#${e.export}`;
}

export function depRef(span: Span): string {
  return span.hash ? `#${span.hash}` : extRefString(span.ext!);
}
