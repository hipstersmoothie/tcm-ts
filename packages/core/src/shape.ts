// Type shapes: a term's type as structure, for searching by type (`ucm find ':(xs: T[]) => T'`), the way Unison
// searches by type. References to codebase types are hashes, so a rename doesn't change a shape; type
// parameters are variables, so `<A>(xs: A[]) => A` and `<T>(xs: T[]) => T` are the same shape.
import ts from "typescript";
import { hashFromExportId } from "./hash.ts";

export type Shape =
  | { k: "prim"; name: string }
  | { k: "lit"; value: string | number | boolean }
  | { k: "var"; i: number }
  | { k: "fn"; params: Shape[]; rest?: Shape; ret: Shape }
  | { k: "array"; of: Shape }
  | { k: "tuple"; of: Shape[] }
  | { k: "union"; of: Shape[] }
  | { k: "inter"; of: Shape[] }
  | { k: "obj"; props: [string, Shape, boolean][] }
  /** a codebase type, by hash */
  | { k: "ref"; hash: string; args: Shape[] }
  /** a type from a library (Promise, Map, Date, a package's types), by name */
  | { k: "named"; name: string; args: Shape[] }
  /** too deep or too big to compare */
  | { k: "opaque" };

/** A term's type: one shape per call signature (overloads), or the one shape of a non-function value. */
export type TypeShape = Shape[];

const MAX_DEPTH = 6;
const MAX_PROPS = 40;
const key = (s: Shape) => JSON.stringify(s);

/** The hash of a codebase type a symbol denotes, when it's declared in a generated cache module. */
export function cacheRefOf(checker: ts.TypeChecker): (sym: ts.Symbol) => string | undefined {
  const exports = new Map<ts.SourceFile, Map<ts.Symbol, string>>();
  return (sym) => {
    const decl = sym.declarations?.[0];
    const sf = decl?.getSourceFile();
    if (!sf || !/[\\/]\.ucm[\\/]cache[\\/][a-z2-7]{52}\.ts$/.test(sf.fileName)) return undefined;
    let byLocal = exports.get(sf);
    if (!byLocal) {
      byLocal = new Map();
      const mod = checker.getSymbolAtLocation(sf);
      for (const e of mod ? checker.getExportsOfModule(mod) : []) {
        const hash = hashFromExportId(e.name);
        const local = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        if (hash) byLocal.set(local, hash);
      }
      exports.set(sf, byLocal);
    }
    return byLocal.get(sym);
  };
}

/** Shapes from checker types. `refOf` says which symbols are codebase types (by hash). */
export function shapeBuilder(checker: ts.TypeChecker, refOf: (sym: ts.Symbol) => string | undefined) {
  const vars = new Map<ts.Type, number>();
  const named = (sym: ts.Symbol, args: readonly ts.Type[], depth: number): Shape => {
    const s = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const hash = refOf(s);
    const a = args.map((t) => of(t, depth + 1));
    return hash ? { k: "ref", hash, args: a } : { k: "named", name: s.name, args: a };
  };
  const sorted = (xs: Shape[]) => xs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const fn = (sig: ts.Signature, depth: number): Shape => {
    const params: Shape[] = [];
    let rest: Shape | undefined;
    for (const p of sig.parameters) {
      const decl = p.valueDeclaration;
      const t = checker.getTypeOfSymbol(p);
      if (decl && ts.isParameter(decl) && decl.dotDotDotToken) {
        rest = checker.isArrayType(t) ? of(checker.getTypeArguments(t as ts.TypeReference)[0]!, depth + 1) : of(t, depth + 1);
      } else params.push(of(t, depth + 1));
    }
    return { k: "fn", params, ...(rest ? { rest } : {}), ret: of(checker.getReturnTypeOfSignature(sig), depth + 1) };
  };
  const of = (t: ts.Type, depth = 0): Shape => {
    if (depth > MAX_DEPTH) return { k: "opaque" };
    const f = t.flags;
    if (f & ts.TypeFlags.TypeParameter) {
      let i = vars.get(t);
      if (i === undefined) vars.set(t, (i = vars.size));
      return { k: "var", i };
    }
    if (f & ts.TypeFlags.Any) return { k: "prim", name: "any" };
    if (f & ts.TypeFlags.Unknown) return { k: "prim", name: "unknown" };
    if (f & ts.TypeFlags.Never) return { k: "prim", name: "never" };
    if (f & ts.TypeFlags.Void) return { k: "prim", name: "void" };
    if (f & ts.TypeFlags.Undefined) return { k: "prim", name: "undefined" };
    if (f & ts.TypeFlags.Null) return { k: "prim", name: "null" };
    if (f & ts.TypeFlags.StringLiteral) return { k: "lit", value: (t as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { k: "lit", value: (t as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { k: "lit", value: (t as unknown as { intrinsicName: string }).intrinsicName === "true" };
    if (f & ts.TypeFlags.String) return { k: "prim", name: "string" };
    if (f & ts.TypeFlags.Number) return { k: "prim", name: "number" };
    if (f & ts.TypeFlags.Boolean) return { k: "prim", name: "boolean" };
    if (f & ts.TypeFlags.BigInt) return { k: "prim", name: "bigint" };
    if (f & ts.TypeFlags.ESSymbolLike) return { k: "prim", name: "symbol" };
    if (f & ts.TypeFlags.NonPrimitive) return { k: "prim", name: "object" };
    // a library alias like Partial<User> or Record<string, number> keeps its name; a codebase alias its hash
    if (t.aliasSymbol && (refOf(t.aliasSymbol) || t.aliasSymbol.declarations?.[0]?.getSourceFile().isDeclarationFile)) {
      return named(t.aliasSymbol, t.aliasTypeArguments ?? [], depth);
    }
    if (t.isUnion()) {
      // `boolean` inside a union is true | false: put it back together
      const members = t.types.filter((m) => !(m.flags & ts.TypeFlags.BooleanLiteral));
      const shapes = members.map((m) => of(m, depth + 1));
      if (members.length < t.types.length) shapes.push({ k: "prim", name: "boolean" });
      return shapes.length === 1 ? shapes[0]! : { k: "union", of: sorted(shapes) };
    }
    if (t.isIntersection()) return { k: "inter", of: sorted(t.types.map((m) => of(m, depth + 1))) };
    if (checker.isArrayType(t)) return { k: "array", of: of(checker.getTypeArguments(t as ts.TypeReference)[0]!, depth + 1) };
    if (checker.isTupleType(t)) return { k: "tuple", of: checker.getTypeArguments(t as ts.TypeReference).map((x) => of(x, depth + 1)) };
    if (t.aliasSymbol) return named(t.aliasSymbol, t.aliasTypeArguments ?? [], depth);
    const obj = t as ts.ObjectType;
    if (f & ts.TypeFlags.Object && obj.objectFlags & ts.ObjectFlags.Reference) {
      return named((t as ts.TypeReference).target.symbol, checker.getTypeArguments(t as ts.TypeReference), depth);
    }
    if (f & ts.TypeFlags.Object && obj.objectFlags & (ts.ObjectFlags.Interface | ts.ObjectFlags.Class) && t.symbol) return named(t.symbol, [], depth);
    if (f & ts.TypeFlags.Object) {
      const props = checker.getPropertiesOfType(t);
      const calls = t.getCallSignatures();
      if (calls.length && !props.length) return fn(calls[0]!, depth);
      if (props.length > MAX_PROPS) return { k: "opaque" };
      return {
        k: "obj",
        props: props
          .map((p): [string, Shape, boolean] => [p.name, of(checker.getTypeOfSymbol(p), depth + 1), !!(p.flags & ts.SymbolFlags.Optional)])
          .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      };
    }
    return { k: "opaque" };
  };
  return {
    /** A value's type: its call signatures if it has them, else the type itself. Type variables restart at 0. */
    typeShape(t: ts.Type): TypeShape {
      const calls = t.getCallSignatures();
      return calls.length ? calls.map((s) => (vars.clear(), fn(s, 0))) : [(vars.clear(), of(t))];
    },
  };
}

// ---- matching -------------------------------------------------------------------------------------------

/** How a definition's type relates to a query. Lower cost is closer; 0 is the same type up to renaming. */
export interface ShapeMatch {
  cost: number;
  notes: string[];
}

interface Subst {
  /** query variable → what it stands for in the definition */
  q: Map<number, Shape>;
  /** definition variable → what it stands for in the query */
  d: Map<number, Shape>;
  cost: number;
  notes: Set<string>;
}

function unify(a: Shape, b: Shape, s: Subst): boolean {
  if (a.k === "var" && b.k === "var") {
    const qa = s.q.get(a.i);
    const db = s.d.get(b.i);
    if (qa) return qa.k === "var" && qa.i === b.i;
    if (db) return db.k === "var" && db.i === a.i;
    s.q.set(a.i, b);
    s.d.set(b.i, a);
    return true;
  }
  if (a.k === "var") {
    const bound = s.q.get(a.i);
    if (bound) return key(bound) === key(b);
    s.q.set(a.i, b);
    s.cost += 2;
    s.notes.add("more specific");
    return true;
  }
  if (b.k === "var") {
    const bound = s.d.get(b.i);
    if (bound) return key(bound) === key(a);
    s.d.set(b.i, a);
    s.cost += 2;
    s.notes.add("more general");
    return true;
  }
  // a type too deep to describe (or a conditional or mapped type) only matches another one
  if (a.k === "opaque" || b.k === "opaque") {
    if (a.k !== b.k) return false;
    s.cost += 1;
    s.notes.add("partly compared");
    return true;
  }
  if (a.k !== b.k) return false;
  const all = (xs: Shape[], ys: Shape[]) => xs.length === ys.length && xs.every((x, i) => unify(x, ys[i]!, s));
  switch (a.k) {
    case "prim":
      return a.name === (b as typeof a).name;
    case "lit":
      return a.value === (b as typeof a).value;
    case "array":
      return unify(a.of, (b as typeof a).of, s);
    case "tuple":
    case "union":
    case "inter":
      return all(a.of, (b as typeof a).of);
    case "obj": {
      const bp = (b as typeof a).props;
      return a.props.length === bp.length && a.props.every(([n, t, o], i) => n === bp[i]![0] && o === bp[i]![2] && unify(t, bp[i]![1], s));
    }
    case "ref":
      return a.hash === (b as typeof a).hash && all(a.args, (b as typeof a).args);
    case "named":
      return a.name === (b as typeof a).name && all(a.args, (b as typeof a).args);
    case "fn": {
      const bf = b as typeof a;
      if (!!a.rest !== !!bf.rest || (a.rest && !unify(a.rest, bf.rest!, s))) return false;
      return all(a.params, bf.params) && unify(a.ret, bf.ret, s);
    }
  }
  return false;
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Match one query shape against one definition shape: in order, with arguments reordered, or with the result awaited. */
function matchOne(q: Shape, d: Shape): ShapeMatch | undefined {
  let best: ShapeMatch | undefined;
  const attempt = (qs: Shape, ds: Shape, extra: number, note?: string) => {
    const s: Subst = { q: new Map(), d: new Map(), cost: extra, notes: new Set(note ? [note] : []) };
    if (unify(qs, ds, s) && (!best || s.cost < best.cost)) best = { cost: s.cost, notes: [...s.notes] };
  };
  if (q.k !== "fn" || d.k !== "fn") {
    attempt(q, d, 0);
    return best;
  }
  // an async function answers a query for its result type, a step away
  const rets: [Shape, number, string?][] = [[d.ret, 0]];
  if (d.ret.k === "named" && d.ret.name === "Promise" && d.ret.args.length === 1 && !(q.ret.k === "named" && q.ret.name === "Promise")) {
    rets.push([d.ret.args[0]!, 1, "async"]);
  }
  const orders = q.params.length <= 5 ? permutations(q.params.map((_, i) => i)) : [q.params.map((_, i) => i)];
  for (const [ret, cost, note] of rets) {
    for (const order of orders) {
      const reordered = order.some((j, i) => j !== i);
      const qp: Shape = { ...q, params: order.map((j) => q.params[j]!) };
      const dp: Shape = { ...d, ret };
      attempt(qp, dp, cost + (reordered ? 1 : 0), reordered ? "arguments reordered" : note);
      if (reordered && note && best) best.notes = [...new Set([...best.notes, note])];
    }
  }
  return best;
}

/** The closest way a definition's type answers a query, if any (over the definition's overloads). */
export function matchShapes(query: TypeShape, def: TypeShape): ShapeMatch | undefined {
  let best: ShapeMatch | undefined;
  for (const q of query) for (const d of def) {
    const m = matchOne(q, d);
    if (m && (!best || m.cost < best.cost)) best = m;
  }
  return best;
}

// ---- queries ----------------------------------------------------------------------------------------------

/** Where a name in a query comes from: a `#codebase` shim module and the name it exports. */
export interface QueryImport {
  module: string;
  export: string;
}

/**
 * The shape of a type written as a query, e.g. `(xs: T[]) => T` or `(u: lib.User) => Promise<string>`.
 * `resolve` maps names written in the query (`User`, `lib.User`) to codebase types; names that are neither those
 * nor globals become type variables, as in Unison (`(xs: a[]) => a`). The query is checked as a file at `file`
 * (it must sit where `#codebase` resolves), which is removed afterwards.
 */
export function queryShape(
  text: string,
  file: string,
  options: ts.CompilerOptions,
  resolve: (name: string) => QueryImport | undefined,
): { shape: TypeShape; variables: string[] } {
  const parsed = ts.createSourceFile("query.ts", `type __Q = ${text};`, ts.ScriptTarget.ESNext, true);
  const alias = parsed.statements[0];
  if (parsed.statements.length !== 1 || !alias || !ts.isTypeAliasDeclaration(alias) || (parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) {
    throw new Error(`'${text}' isn't a TypeScript type`);
  }
  // codebase names become imports under fresh local names, replacing their text in the query
  const imports: string[] = [];
  const edits: { start: number; end: number; local: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n)) {
      const name = n.typeName.getText(parsed);
      const imp = resolve(name);
      if (imp) {
        const local = `__T${imports.length}`;
        imports.push(`import type { ${imp.export} as ${local} } from ${JSON.stringify(imp.module)};`);
        edits.push({ start: n.typeName.getStart(parsed), end: n.typeName.end, local });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(alias.type);
  let body = parsed.text.slice(alias.type.getStart(parsed), alias.type.end);
  const offset = alias.type.getStart(parsed);
  for (const e of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, e.start - offset) + e.local + body.slice(e.end - offset);

  const check = (variables: string[]) => {
    const params = variables.length ? `<${variables.join(", ")}>` : "";
    ts.sys.writeFile(file, `${imports.join("\n")}\ntype __Q${params} = ${body};\nexport {};\n`);
    const program = ts.createProgram({ rootNames: [file], options });
    const sf = program.getSourceFile(file)!;
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    return { program, sf, diags };
  };
  try {
    // names TypeScript can't find are the query's type variables
    let r = check([]);
    const unknown = [...new Set(r.diags.filter((d) => d.code === 2304).map((d) => /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, " "))?.[1]).filter((n): n is string => !!n))];
    if (unknown.length) r = check(unknown);
    if (r.diags.length) throw new Error(`'${text}': ${ts.flattenDiagnosticMessageText(r.diags[0]!.messageText, " ")}`);
    const checker = r.program.getTypeChecker();
    const decl = r.sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "__Q")!;
    return { shape: shapeBuilder(checker, cacheRefOf(checker)).typeShape(checker.getTypeFromTypeNode(decl.type)), variables: unknown };
  } finally {
    ts.sys.deleteFile?.(file);
  }
}
