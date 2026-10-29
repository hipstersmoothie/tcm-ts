// Semver checks, in the manner of cargo-semver-checks: a catalog of lints, each a way an API change can affect the
// code that uses it, with the version bump it calls for. The codebase knows exactly what changed (by hash), so
// each changed definition's old and new versions are put in one program and compared with the type checker, from
// the side of the code that uses them: every use that typechecked against the old version must still.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { exportId, type DefRecord } from "@tcm/core";
import { materialize, moduleFile } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";

export type Level = "major" | "minor" | "patch";

export interface Lint {
  level: Level;
  /** what happened, in a few words */
  summary: string;
  /** what it means for the code using the definition */
  why: string;
}

/** Every lint, by id. */
export const LINTS = {
  definition_removed: { level: "major", summary: "removed", why: "code that uses it no longer compiles" },
  definition_renamed: { level: "major", summary: "renamed", why: "code that imports it by its old name no longer compiles" },
  export_moved: { level: "major", summary: "is exported from a different subpath", why: "imports of it from the old one no longer compile" },
  bin_removed: { level: "major", summary: "command removed", why: "scripts that run it fail" },
  bin_added: { level: "minor", summary: "command added", why: "new API" },
  kind_changed: { level: "major", summary: "is now a type rather than a value, or the other way around", why: "code that uses it the old way no longer compiles" },
  function_became_value: { level: "major", summary: "can't be called any more", why: "calls to it no longer compile" },
  function_required_parameter_added: { level: "major", summary: "takes a required parameter it didn't", why: "calls written for the old version are missing an argument" },
  function_parameter_removed: { level: "major", summary: "takes fewer parameters", why: "calls that pass the removed argument no longer compile" },
  function_parameter_made_required: { level: "major", summary: "requires a parameter that was optional", why: "calls that leave it out no longer compile" },
  function_parameter_type_narrowed: { level: "major", summary: "accepts less for a parameter", why: "arguments the old version accepted may not be accepted" },
  function_return_type_widened: { level: "major", summary: "can return more kinds of value", why: "callers may get a value they don't handle" },
  function_type_parameter_count_changed: { level: "major", summary: "has a different number of type parameters", why: "explicit type arguments no longer match" },
  function_signature_incompatible: { level: "major", summary: "has a signature old calls don't fit", why: "some calls written for the old version no longer compile" },
  constructor_incompatible: { level: "major", summary: "is constructed differently", why: "`new` written for the old version no longer compiles" },
  value_type_widened: { level: "major", summary: "can hold more kinds of value", why: "code reading it may get a value it doesn't handle" },
  type_property_removed: { level: "major", summary: "lost a property", why: "code reading the property no longer compiles" },
  type_required_property_added: { level: "major", summary: "has a new required property", why: "values written for the old type lack it" },
  type_property_made_optional: { level: "major", summary: "has a property that may now be missing", why: "code reading it may get undefined" },
  type_property_made_required: { level: "major", summary: "requires a property that was optional", why: "values written for the old type may lack it" },
  type_property_made_readonly: { level: "major", summary: "has a property that's now readonly", why: "code assigning to it no longer compiles" },
  type_property_type_changed: { level: "major", summary: "has a property of a different type", why: "code reading or writing the property may no longer compile" },
  type_union_member_added: { level: "major", summary: "has a new case", why: "code handling every case no longer does" },
  type_union_member_removed: { level: "major", summary: "lost a case", why: "values of the removed case no longer fit" },
  type_type_parameter_count_changed: { level: "major", summary: "has a different number of type parameters", why: "uses with type arguments no longer match" },
  type_changed: { level: "major", summary: "changed", why: "code using it may no longer compile" },

  definition_added: { level: "minor", summary: "added", why: "new API" },
  function_optional_parameter_added: { level: "minor", summary: "takes a new optional parameter", why: "old calls still work" },
  function_parameter_made_optional: { level: "minor", summary: "no longer requires a parameter", why: "old calls still work" },
  function_parameter_type_widened: { level: "minor", summary: "accepts more for a parameter", why: "old calls still work" },
  function_return_type_narrowed: { level: "minor", summary: "returns a narrower type", why: "what old callers expect still fits" },
  function_signature_extended: { level: "minor", summary: "accepts more (a new overload, say)", why: "old calls still work" },
  value_type_narrowed: { level: "minor", summary: "holds a narrower type", why: "what old readers expect still fits" },
  type_optional_property_added: { level: "minor", summary: "has a new optional property", why: "old values still fit" },
  type_property_made_writable: { level: "minor", summary: "has a property that's no longer readonly", why: "old uses still work" },

  implementation_changed: { level: "patch", summary: "changed, with the same API", why: "uses still compile; behaviour may differ" },
} satisfies Record<string, Lint>;

export type LintId = keyof typeof LINTS;

export interface Finding {
  lint: LintId;
  path: string;
  /** specifics: `x: number → bigint` */
  detail?: string;
}

export const levelOf = (f: Finding): Level => LINTS[f.lint].level;

/** The highest level of a set of findings. */
export function highest(findings: Finding[]): Level | undefined {
  for (const l of ["major", "minor", "patch"] as Level[]) if (findings.some((f) => levelOf(f) === l)) return l;
  return undefined;
}

/** A changed definition to check: what its name pointed at before, and now. */
export interface Pair {
  path: string;
  old: DefRecord;
  new: DefRecord;
}

/** `x: number → bigint`; or, where both read the same, the change is in a type it names. */
const change = (lead: string, before: string, after: string) => (before === after ? `${lead}${before}, whose definition changed` : `${lead}${before} → ${after}`);

const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.WriteArrowStyleSignature;

/** Check changed definitions: old and new versions of each in one program, compared lint by lint. */
export function checkPairs(cb: Codebase, pairs: Pair[]): Finding[] {
  if (!pairs.length) return [];
  const src = cb.source();
  materialize(pairs.flatMap((p) => [p.old.hash, p.new.hash]), src, cb.lay);
  const imports = pairs.flatMap((p, i) =>
    (["old", "new"] as const).map((side) => {
      const rec = p[side];
      return `import ${rec.kind === "type" ? "type " : ""}{ ${exportId(rec.hash)} as ${side === "old" ? "O" : "N"}${i} } from "./${moduleFile(rec.componentHash, src)}";`;
    }),
  );
  const file = path.join(cb.lay.cacheDir, `_semver_${process.pid}.ts`);
  fs.writeFileSync(file, imports.join("\n") + "\nexport {};\n");
  try {
    const program = ts.createProgram([file], { ...cb.recheckOptions(undefined), noEmit: true });
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(file)!;
    const symbols = new Map<string, ts.Symbol>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
      for (const el of st.importClause.namedBindings.elements) {
        const s = checker.getSymbolAtLocation(el.name);
        if (s) symbols.set(el.name.text, s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
      }
    }
    return pairs.flatMap((p, i) => {
      const [o, n] = [symbols.get(`O${i}`), symbols.get(`N${i}`)];
      if (!o || !n) return [{ lint: "type_changed", path: p.path, detail: "couldn't be compared" } satisfies Finding];
      return compare(checker, p, o, n);
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function compare(checker: ts.TypeChecker, p: Pair, o: ts.Symbol, n: ts.Symbol): Finding[] {
  const out: Finding[] = [];
  const add = (lint: LintId, detail?: string) => out.push({ lint, path: p.path, detail });
  const str = (t: ts.Type) => checker.typeToString(t, undefined, FLAGS);
  const assignable = (a: ts.Type, b: ts.Type) => checker.isTypeAssignableTo(a, b);
  const isValue = (s: ts.Symbol) => !!(s.flags & ts.SymbolFlags.Value);
  const isType = (s: ts.Symbol) => !!(s.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Class));
  if (isValue(o) !== isValue(n) || (isType(o) && !isType(n))) {
    add("kind_changed");
    return out;
  }
  if (isValue(o)) {
    const [ot, nt] = [checker.getTypeOfSymbol(o), checker.getTypeOfSymbol(n)];
    callable(checker, ot, nt, ts.SignatureKind.Call, add);
    if (o.flags & ts.SymbolFlags.Class) callable(checker, ot, nt, ts.SignatureKind.Construct, add);
    const plain = !checker.getSignaturesOfType(ot, ts.SignatureKind.Call).length && !checker.getSignaturesOfType(nt, ts.SignatureKind.Call).length && !(o.flags & ts.SymbolFlags.Class);
    if (plain) {
      if (!assignable(nt, ot)) {
        // say what about it, where the type is an object
        const before = out.length;
        properties(checker, ot, nt, add);
        if (out.length === before) add("value_type_widened", change("", str(ot), str(nt)));
      } else if (!assignable(ot, nt)) add("value_type_narrowed", change("", str(ot), str(nt)));
    }
  }
  if (isType(o) && !(o.flags & ts.SymbolFlags.Class && out.some((f) => levelOf(f) === "major"))) {
    const [ot, nt] = [checker.getDeclaredTypeOfSymbol(o), checker.getDeclaredTypeOfSymbol(n)];
    typeChanges(checker, ot, nt, o, n, add);
  }
  if (!out.length) add("implementation_changed");
  return out;
}

/** How call (or construct) signatures changed, from the side of a caller. */
function callable(checker: ts.TypeChecker, ot: ts.Type, nt: ts.Type, kind: ts.SignatureKind, add: (l: LintId, d?: string) => void) {
  const [os, ns] = [checker.getSignaturesOfType(ot, kind), checker.getSignaturesOfType(nt, kind)];
  if (!os.length) return;
  const ctor = kind === ts.SignatureKind.Construct;
  if (!ns.length) return add(ctor ? "constructor_incompatible" : "function_became_value");
  const str = (t: ts.Type) => checker.typeToString(t, undefined, FLAGS);
  if (os.length === 1 && ns.length === 1) {
    const [a, b] = [os[0]!, ns[0]!];
    if ((a.typeParameters?.length ?? 0) !== (b.typeParameters?.length ?? 0)) return add(ctor ? "constructor_incompatible" : "function_type_parameter_count_changed");
    // generic signatures' parameters mention their own type parameters: compare them whole
    if (a.typeParameters?.length) return fits(checker, b, a) ? undefined : add(ctor ? "constructor_incompatible" : "function_signature_incompatible", `${sig(checker, a)} → ${sig(checker, b)}`);
    const before = params(checker, a);
    const after = params(checker, b);
    const lint = (l: LintId, d?: string) => add(ctor && LINTS[l].level === "major" ? "constructor_incompatible" : l, d);
    const required = (ps: Param[]) => ps.filter((x) => !x.optional && !x.rest).length;
    if (required(after) > required(before)) {
      const madeRequired = after.find((x, i) => before[i] && before[i]!.optional && !x.optional && !x.rest);
      if (madeRequired) lint("function_parameter_made_required", madeRequired.name);
      else lint("function_required_parameter_added", after.filter((x, i) => !x.optional && !x.rest && i >= required(before)).map((x) => `${x.name}: ${str(x.type)}`).join(", "));
    }
    if (after.length < before.length && !after.some((x) => x.rest)) lint("function_parameter_removed", before.slice(after.length).map((x) => x.name).join(", "));
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      const [x, y] = [before[i]!, after[i]!];
      if (!checker.isTypeAssignableTo(x.type, y.type)) lint("function_parameter_type_narrowed", change(`${x.name}: `, str(x.type), str(y.type)));
      else if (!checker.isTypeAssignableTo(y.type, x.type)) lint("function_parameter_type_widened", change(`${x.name}: `, str(x.type), str(y.type)));
      if (!x.optional && y.optional) lint("function_parameter_made_optional", y.name);
    }
    if (after.length > before.length && after.slice(before.length).every((x) => x.optional || x.rest)) lint("function_optional_parameter_added", after.slice(before.length).map((x) => x.name).join(", "));
    const [r, s] = [checker.getReturnTypeOfSignature(a), checker.getReturnTypeOfSignature(b)];
    if (!checker.isTypeAssignableTo(s, r)) lint("function_return_type_widened", change("", str(r), str(s)));
    else if (!checker.isTypeAssignableTo(r, s)) lint("function_return_type_narrowed", change("", str(r), str(s)));
    return;
  }
  // overloads: every old signature needs a new one its calls fit
  const unmatched = os.filter((a) => !ns.some((b) => fits(checker, b, a)));
  if (unmatched.length) add(ctor ? "constructor_incompatible" : "function_signature_incompatible", unmatched.map((a) => sig(checker, a)).join("; "));
  else if (ns.length > os.length || ns.some((b) => !os.some((a) => fits(checker, a, b)))) add("function_signature_extended");
}

interface Param {
  name: string;
  type: ts.Type;
  optional: boolean;
  rest: boolean;
}

function params(checker: ts.TypeChecker, s: ts.Signature): Param[] {
  return s.parameters.map((p) => {
    const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
    return {
      name: p.name,
      type: checker.getTypeOfSymbol(p),
      optional: !!decl && (!!decl.questionToken || !!decl.initializer),
      rest: !!decl?.dotDotDotToken,
    };
  });
}

const sig = (checker: ts.TypeChecker, s: ts.Signature) => checker.signatureToString(s, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature);

/** Whether every call that fits `old` fits `next` too: arguments it takes, a result old callers can use. */
function fits(checker: ts.TypeChecker, next: ts.Signature, old: ts.Signature): boolean {
  const [x, y] = [params(checker, old), params(checker, next)];
  const required = (ps: Param[]) => ps.filter((p) => !p.optional && !p.rest).length;
  if (required(y) > required(x)) return false;
  if (y.length < x.length && !y.some((p) => p.rest)) return false;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (!checker.isTypeAssignableTo(x[i]!.type, y[i]!.type)) return false;
  return checker.isTypeAssignableTo(checker.getReturnTypeOfSignature(next), checker.getReturnTypeOfSignature(old));
}

/** Properties gained, lost and changed, for an object type (or a value of one). */
function properties(checker: ts.TypeChecker, ot: ts.Type, nt: ts.Type, add: (l: LintId, d?: string) => void) {
  const str = (t: ts.Type) => checker.typeToString(t, undefined, FLAGS);
  const optional = (s: ts.Symbol) => !!(s.flags & ts.SymbolFlags.Optional);
  const readonly = (s: ts.Symbol) => {
    const d = s.valueDeclaration ?? s.declarations?.[0];
    return !!d && !!(ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Readonly);
  };
  const before = new Map(checker.getPropertiesOfType(ot).map((s) => [s.name, s]));
  const after = new Map(checker.getPropertiesOfType(nt).map((s) => [s.name, s]));
  for (const [name, s] of before) {
    const t = after.get(name);
    if (!t) {
      add("type_property_removed", name);
      continue;
    }
    if (!optional(s) && optional(t)) add("type_property_made_optional", name);
    if (optional(s) && !optional(t)) add("type_property_made_required", name);
    if (!readonly(s) && readonly(t)) add("type_property_made_readonly", name);
    if (readonly(s) && !readonly(t)) add("type_property_made_writable", name);
    const [x, y] = [checker.getTypeOfSymbol(s), checker.getTypeOfSymbol(t)];
    if (!checker.isTypeAssignableTo(x, y) || !checker.isTypeAssignableTo(y, x)) add("type_property_type_changed", change(`${name}: `, str(x), str(y)));
  }
  for (const [name, t] of after) if (!before.has(name)) add(optional(t) ? "type_optional_property_added" : "type_required_property_added", name);
}

/** How a type changed: its cases, its properties, or as a whole. */
function typeChanges(checker: ts.TypeChecker, ot: ts.Type, nt: ts.Type, o: ts.Symbol, n: ts.Symbol, add: (l: LintId, d?: string) => void) {
  const str = (t: ts.Type) => checker.typeToString(t, undefined, FLAGS);
  const params = (s: ts.Symbol) => {
    const d = s.declarations?.find((x) => ts.isTypeAliasDeclaration(x) || ts.isInterfaceDeclaration(x) || ts.isClassDeclaration(x)) as ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration | undefined;
    return d?.typeParameters?.length ?? 0;
  };
  if (params(o) !== params(n)) return add("type_type_parameter_count_changed", `${params(o)} → ${params(n)}`);
  // a generic type mentions its own type parameters: compare it as written
  if (params(o)) return str(ot) === str(nt) ? undefined : add("type_changed", change("", str(ot), str(nt)));
  // cases and properties first: an added optional property, say, leaves the two types mutually assignable
  if (ot.isUnion() && nt.isUnion()) {
    const cases = (t: ts.UnionType) => new Map(t.types.map((x) => [str(x), x]));
    const [a, b] = [cases(ot), cases(nt)];
    const added = [...b.keys()].filter((k) => !a.has(k));
    const removed = [...a.keys()].filter((k) => !b.has(k));
    if (added.length) add("type_union_member_added", added.join(" | "));
    if (removed.length) add("type_union_member_removed", removed.join(" | "));
    if (added.length || removed.length) return;
  }
  const isObject = (t: ts.Type) => !!(t.flags & ts.TypeFlags.Object) || t.isIntersection();
  if (isObject(ot) && isObject(nt)) {
    let found = 0;
    properties(checker, ot, nt, (l, d) => (found++, add(l, d)));
    if (found) return;
  }
  if (checker.isTypeAssignableTo(ot, nt) && checker.isTypeAssignableTo(nt, ot)) return;
  add("type_changed", change("", str(ot), str(nt)));
}
