// Runtime schemas for function parameters, derived from their TypeScript types. A server function the browser
// can call is a public endpoint, and TypeScript types are gone at runtime, so ucm checks arguments against these
// before calling it. Schemas describe plain data, the only thing that crosses the network (see the CLI's codec).
import ts from "typescript";

export type Schema =
  | { t: "any" }
  | { t: "never" }
  | { t: "string" }
  | { t: "number" }
  | { t: "boolean" }
  | { t: "bigint" }
  | { t: "null" }
  | { t: "undefined" }
  | { t: "date" }
  | { t: "literal"; value: string | number | boolean }
  | { t: "union"; of: Schema[] }
  | { t: "array"; of: Schema }
  | { t: "tuple"; of: Schema[]; optional: number; rest?: Schema }
  | { t: "object"; props: Record<string, { s: Schema; optional: boolean }>; index?: Schema }
  | { t: "map"; key: Schema; value: Schema }
  | { t: "set"; of: Schema }
  | { t: "ref"; id: number }
  /** a type that can't arrive as plain data (functions, class instances): any argument is refused */
  | { t: "unsendable"; what: string };

/** A table's row type, as a schema, with a hash identifying it (rows record the hash they were written with). */
export interface TableSchema {
  /** the table's name, if given as a literal */
  name?: string;
  /** whether the definition passes options (a `migrate` function) */
  hasOptions?: boolean;
  hash: string;
  s: Schema;
  defs: Schema[];
  /**
   * the parameter type of each `migrate` step, in order (one for a single function): a stored row goes through
   * the first step whose parameter it fits, then the later ones, until it fits the row type
   */
  steps?: { s: Schema; defs: Schema[] }[];
  /** fields no two rows may share */
  unique?: string[];
  /** fields with an index, for `find` */
  index?: string[];
  /** the table's previous name: its rows move to this one */
  renamedFrom?: string;
}

export interface ParamsSchema {
  params: { name: string; s: Schema; optional: boolean; rest: boolean }[];
  /** shared definitions for recursive types (`ref` points into these) */
  defs: Schema[];
}

const GLOBAL_CLASSES = new Set(["Date", "Map", "Set", "ReadonlyMap", "ReadonlySet"]);

/** The parameters of a function-typed value, as runtime schemas. */
/** Turns TypeScript types into schemas; recursive types share `defs`. */
function schemaBuilder(checker: ts.TypeChecker) {
  const defs: Schema[] = [];
  const refs = new Map<ts.Type, number>();
  const active = new Set<ts.Type>();

  const of = (t: ts.Type, depth: number): Schema => {
    if (depth > 30) return { t: "any" };
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { t: "any" };
    if (f & ts.TypeFlags.Never) return { t: "never" };
    if (f & ts.TypeFlags.StringLiteral) return { t: "literal", value: (t as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { t: "literal", value: (t as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { t: "literal", value: checker.typeToString(t) === "true" };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) return { t: "string" };
    if (f & ts.TypeFlags.Number) return { t: "number" };
    if (f & ts.TypeFlags.Boolean) return { t: "boolean" };
    if (f & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return { t: "bigint" };
    if (f & ts.TypeFlags.Null) return { t: "null" };
    if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { t: "undefined" };
    if (f & ts.TypeFlags.TypeParameter) {
      const c = checker.getBaseConstraintOfType(t);
      return c && c !== t ? of(c, depth + 1) : { t: "any" };
    }
    if (t.isUnion()) return { t: "union", of: t.types.map((u) => of(u, depth + 1)) };
    if (!(f & ts.TypeFlags.Object) && !t.isIntersection()) return { t: "any" };

    // object types can be recursive: meeting one again while describing it reserves a shared definition
    if (active.has(t)) {
      if (!refs.has(t)) refs.set(t, defs.push({ t: "any" }) - 1);
      return { t: "ref", id: refs.get(t)! };
    }
    active.add(t);
    const s = objectSchema(t, depth);
    active.delete(t);
    const id = refs.get(t);
    if (id === undefined) return s;
    defs[id] = s;
    return { t: "ref", id };
  };

  const objectSchema = (t: ts.Type, depth: number): Schema => {
    const name = t.getSymbol()?.getName();
    const args = checker.getTypeArguments(t as ts.TypeReference);
    if (checker.isTupleType(t)) {
      const target = (t as ts.TypeReference).target as ts.TupleType;
      const elems = args.map((a) => of(a, depth + 1));
      const flags = target.elementFlags;
      const restAt = flags.findIndex((x) => x & ts.ElementFlags.Variable);
      const fixed = restAt === -1 ? elems : elems.slice(0, restAt);
      return { t: "tuple", of: fixed, optional: flags.filter((x) => x & ts.ElementFlags.Optional).length, ...(restAt === -1 ? {} : { rest: elems[restAt] }) };
    }
    if (checker.isArrayType(t)) return { t: "array", of: of(args[0]!, depth + 1) };
    if (name && GLOBAL_CLASSES.has(name) && isGlobal(t)) {
      if (name === "Date") return { t: "date" };
      if (name.endsWith("Map")) return { t: "map", key: of(args[0]!, depth + 1), value: of(args[1]!, depth + 1) };
      return { t: "set", of: of(args[0]!, depth + 1) };
    }
    if (t.getCallSignatures().length || t.getConstructSignatures().length) return { t: "unsendable", what: "a function" };
    if (t.getSymbol()?.flags && t.getSymbol()!.flags & ts.SymbolFlags.Class) return { t: "unsendable", what: `a ${name} instance` };
    const props: Record<string, { s: Schema; optional: boolean }> = {};
    for (const p of checker.getPropertiesOfType(t)) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const pt = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
      props[p.getName()] = { s: of(pt, depth + 1), optional: (p.flags & ts.SymbolFlags.Optional) !== 0 };
    }
    const index = checker.getIndexInfoOfType(t, ts.IndexKind.String);
    return { t: "object", props, ...(index ? { index: of(index.type, depth + 1) } : {}) };
  };

  const isGlobal = (t: ts.Type) => (t.getSymbol()?.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile);
  return { of, defs };
}

/** The runtime schema of a type (e.g. a table's row type). */
export function typeSchema(checker: ts.TypeChecker, type: ts.Type): { s: Schema; defs: Schema[] } {
  const b = schemaBuilder(checker);
  return { s: b.of(type, 0), defs: b.defs };
}

export function paramsSchema(checker: ts.TypeChecker, type: ts.Type): ParamsSchema | undefined {
  const sig = type.getCallSignatures()[0];
  if (!sig) return undefined;
  const { of, defs } = schemaBuilder(checker);
  const params = sig.getParameters().map((p) => {
    const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
    const rest = !!decl?.dotDotDotToken;
    let pt = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
    if (rest && checker.isArrayType(pt)) pt = checker.getTypeArguments(pt as ts.TypeReference)[0]!;
    const optional = !!decl && (!!decl.questionToken || !!decl.initializer);
    return { name: p.getName(), s: of(pt, 0), optional, rest };
  });
  return { params, defs };
}

/** Check a value against a schema; returns what's wrong, or undefined if it fits. */
export function checkValue(s: Schema, v: unknown, at: string, defs: Schema[]): string | undefined {
  const bad = (expected: string) => `${at} should be ${expected}, got ${describe(v)}`;
  switch (s.t) {
    case "any":
      return undefined;
    case "never":
      return `${at} can't be passed`;
    case "unsendable":
      return `${at} is ${s.what}, which can't be sent over the network`;
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return typeof v === s.t ? undefined : bad(`a ${s.t}`);
    case "null":
      return v === null ? undefined : bad("null");
    case "undefined":
      return v === undefined ? undefined : bad("undefined");
    case "date":
      return v instanceof Date && !Number.isNaN(v.getTime()) ? undefined : bad("a Date");
    case "literal":
      return v === s.value ? undefined : bad(JSON.stringify(s.value));
    case "union":
      return s.of.some((u) => checkValue(u, v, at, defs) === undefined) ? undefined : bad(s.of.map(summary).join(" | "));
    case "ref":
      return checkValue(defs[s.id]!, v, at, defs);
    case "array":
      if (!Array.isArray(v)) return bad("an array");
      for (let i = 0; i < v.length; i++) {
        const e = checkValue(s.of, v[i], `${at}[${i}]`, defs);
        if (e) return e;
      }
      return undefined;
    case "tuple": {
      if (!Array.isArray(v)) return bad("a tuple");
      const min = s.of.length - s.optional;
      if (v.length < min || (!s.rest && v.length > s.of.length)) return bad(`a tuple of ${s.rest ? `at least ${min}` : s.optional ? `${min} to ${s.of.length}` : s.of.length} items`);
      for (let i = 0; i < v.length; i++) {
        const e = checkValue(i < s.of.length ? s.of[i]! : s.rest!, v[i], `${at}[${i}]`, defs);
        if (e) return e;
      }
      return undefined;
    }
    case "map":
      if (!(v instanceof Map)) return bad("a Map");
      for (const [k, x] of v) {
        const e = checkValue(s.key, k, `${at} key`, defs) ?? checkValue(s.value, x, `${at}.get(${JSON.stringify(k)})`, defs);
        if (e) return e;
      }
      return undefined;
    case "set":
      if (!(v instanceof Set)) return bad("a Set");
      for (const x of v) {
        const e = checkValue(s.of, x, `${at} item`, defs);
        if (e) return e;
      }
      return undefined;
    case "object": {
      if (typeof v !== "object" || v === null || Array.isArray(v) || v instanceof Date || v instanceof Map || v instanceof Set) return bad("an object");
      const o = v as Record<string, unknown>;
      for (const [k, p] of Object.entries(s.props)) {
        if (!(k in o) || o[k] === undefined) {
          if (p.optional || checkValue(p.s, undefined, "", defs) === undefined) continue;
          return `${at}.${k} is missing`;
        }
        const e = checkValue(p.s, o[k], `${at}.${k}`, defs);
        if (e) return e;
      }
      for (const k of Object.keys(o)) {
        if (k in s.props) continue;
        // unexpected fields are refused rather than passed along: a server function only gets what it declared
        if (!s.index) return `${at}.${k} isn't a field it accepts`;
        const e = checkValue(s.index, o[k], `${at}.${k}`, defs);
        if (e) return e;
      }
      return undefined;
    }
  }
}

/** Check a call's arguments against a function's parameters. */
export function checkArgs(schema: ParamsSchema, args: unknown[]): string | undefined {
  const { params, defs } = schema;
  const rest = params.at(-1)?.rest ? params.at(-1) : undefined;
  const fixed = rest ? params.slice(0, -1) : params;
  if (!rest && args.length > fixed.length) return `expected at most ${fixed.length} argument(s), got ${args.length}`;
  for (const [i, p] of fixed.entries()) {
    if (i >= args.length || args[i] === undefined) {
      if (p.optional || checkValue(p.s, undefined, "", defs) === undefined) continue;
      return `argument \`${p.name}\` is missing`;
    }
    const e = checkValue(p.s, args[i], `argument \`${p.name}\``, defs);
    if (e) return e;
  }
  if (rest) {
    for (let i = fixed.length; i < args.length; i++) {
      const e = checkValue(rest.s, args[i], `argument \`${rest.name}\`[${i - fixed.length}]`, defs);
      if (e) return e;
    }
  }
  return undefined;
}

function summary(s: Schema): string {
  switch (s.t) {
    case "literal":
      return JSON.stringify(s.value);
    case "array":
      return `${summary(s.of)}[]`;
    case "union":
      return s.of.map(summary).join(" | ");
    case "object":
      return "an object";
    case "ref":
      return "an object";
    default:
      return s.t;
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (v instanceof Date) return "a Date";
  if (v instanceof Map) return "a Map";
  if (v instanceof Set) return "a Set";
  if (typeof v === "string") return `the string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v)}`;
  if (typeof v === "object") return "an object";
  return `${typeof v} ${String(v)}`;
}

/**
 * The value checker as standalone source text, for runtimes that can't import ucm (the generated #ucm/server
 * module): built from these functions' own source, so it's the same code wherever ucm runs from.
 */
export function schemaCheckerSource(): string {
  return `${checkValue}\n${summary}\n${describe}\n`;
}
