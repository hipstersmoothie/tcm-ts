import ts from "typescript";
import type { IR } from "./hash.ts";
import { isAnonymousFunction, UcmError, type DefSite } from "./extract.ts";
import type { DefKind, ExtRef, RefPos } from "./types.ts";

/**
 * Stable names for syntax kinds. `ts.SyntaxKind` numbers shift between TypeScript releases, names don't.
 * The enum has aliases (FirstToken, LastKeyword, ...); the first declared name for each value wins.
 */
const kindName: string[] = (() => {
  const names: string[] = [];
  for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value === "number" && !/^(First|Last)/.test(name) && names[value] === undefined) names[value] = name;
  }
  return names;
})();

/** Node properties that point at other nodes without being syntactic children. */
const NON_SLOT_KEYS = new Set(["parent", "original", "emitNode", "nextContainer", "flowNode", "endFlowNode", "returnFlowNode", "jsDoc", "symbol", "localSymbol", "locals"]);

/**
 * The property of `node` holding `child` (`name`, `body`, `typeArguments`, ...). Children are labelled by slot so
 * that a missing optional child can never make two different nodes serialize alike.
 */
function slotOf(node: ts.Node, child: ts.Node | ts.NodeArray<ts.Node>): string {
  for (const key of Object.keys(node)) {
    if (!NON_SLOT_KEYS.has(key) && (node as unknown as Record<string, unknown>)[key] === child) return key;
  }
  throw new UcmError(`internal: cannot find the slot of a ${kindName[node.kind]} child`, node);
}

const REJECTED: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EnumDeclaration]: "enums are not erasable; use an `as const` object",
  [ts.SyntaxKind.ModuleDeclaration]: "namespaces are not erasable",
  [ts.SyntaxKind.Decorator]: "decorators are not supported by Node's type stripping",
  [ts.SyntaxKind.ImportEqualsDeclaration]: "`import x = require()` is not supported",
  [ts.SyntaxKind.ImportType]: "`import(\"...\")` types are not content-addressable; use `import type` at the top of the file",
  [ts.SyntaxKind.JsxElement]: "JSX is not supported",
  [ts.SyntaxKind.JsxSelfClosingElement]: "JSX is not supported",
  [ts.SyntaxKind.JsxFragment]: "JSX is not supported",
};

/** What an identifier denotes. */
export type Resolved =
  | { kind: "local"; symbol: ts.Symbol }
  | { kind: "def"; def: number }
  | { kind: "hash"; hash: string }
  | { kind: "ext"; ext: ExtRef }
  | { kind: "global"; name: string }
  | { kind: "raw"; name: string };

export interface RawSpan {
  start: number;
  end: number;
  pos: RefPos;
  strict: boolean;
  target: { def: number } | { hash: string } | { ext: ExtRef };
  shorthand?: string;
  literal?: boolean;
}

export interface SiteResult {
  /** IR with intra-file definition references left as `["@def", id]` placeholders */
  ir: IR;
  spans: RawSpan[];
  reserved: Set<string>;
  /** referenced same-file definitions → whether any reference is evaluated at module init */
  edges: Map<number, boolean>;
  /** uses syntax Node's type stripping can't run (enum, namespace, parameter properties) */
  transform: boolean;
  /** the globals (and unresolved names) it uses: a module-level name must never shadow these */
  globals: Set<string>;
  /** top-level `let`s it assigns to: it must share their module, since an imported binding is read-only */
  writes: Set<number>;
}

export type Meaning = "type" | "value";

/** `x = …`, `x += …`, `x++`, `[x] = …`, `({ x } = …)`, `for (x of …)` */
function isAssignmentTarget(node: ts.Node): boolean {
  let n = node;
  for (;;) {
    const p = n.parent;
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) n = p;
    else if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) n = p;
    else if (ts.isShorthandPropertyAssignment(p) && p.name === n) n = p.parent;
    else if (ts.isPropertyAssignment(p) && p.initializer === n) n = p.parent;
    else break;
    if (ts.isObjectLiteralExpression(n)) continue;
  }
  const p = n.parent;
  if (ts.isBinaryExpression(p)) return p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
  if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
  return false;
}

export interface CanonContext {
  checker: ts.TypeChecker;
  /** import mode: enums, namespaces and parameter properties are allowed (compiled when run) */
  allowTransformed: boolean;
  kindOf(def: number): DefKind;
  /** whether a definition is a top-level `let` (imported code only) */
  isLet(def: number): boolean;
  /** files being analyzed together; references between them resolve to definitions */
  projectFiles: Set<ts.SourceFile>;
  warn(message: string, node: ts.Node): void;
  declToDef: Map<ts.Node, number>;
  classifyImport(decl: ts.ImportSpecifier | ts.ImportClause | ts.NamespaceImport, meaning: Meaning): Resolved;
  classifyDynamicImport(spec: string, at: ts.Node): ExtRef;
}

const IDENT_NAME = /^[A-Za-z_$][\w$]*$/;

/** Identifiers that are structural names (property keys, labels), never renamed or resolved. */
function isStructuralName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isQualifiedName(p)) return p.right === id;
  if (
    ts.isPropertyAssignment(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isEnumMember(p)
  ) {
    return p.name === id;
  }
  if (ts.isBindingElement(p)) return p.propertyName === id;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return p.label === id;
  if (ts.isMetaProperty(p)) return true;
  if (ts.isNamedTupleMember(p)) return p.name === id;
  return false;
}

const NAMING_ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/**
 * Identifiers whose text becomes a runtime name: declared function/class names, and bindings that name an
 * anonymous function or class (`const f = () => {}`, `(cb = () => {}) =>`, `f = function () {}`). Renaming these
 * is observable through `.name`, so their text is hashed; every other local stays alpha-renamable.
 */
function isNamingPosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === id) return true;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) return !!p.initializer && isAnonymousFunction(p.initializer);
  if (ts.isBinaryExpression(p) && p.left === id && NAMING_ASSIGNMENTS.has(p.operatorToken.kind)) return isAnonymousFunction(p.right);
  return false;
}

/** Type positions are erased at runtime; references there need `import type` in generated modules. */
function isTypePosition(id: ts.Node): boolean {
  let n: ts.Node = id;
  while (n.parent) {
    const p: ts.Node = n.parent;
    if (ts.isExpressionWithTypeArguments(p) && p.expression === n) {
      if (ts.isHeritageClause(p.parent)) {
        return !(p.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(p.parent.parent));
      }
      return false;
    }
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if ((ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name === n) return true;
    if (ts.isTypeParameterDeclaration(p)) return true;
    n = p;
  }
  return false;
}

/**
 * Which meaning of a name an identifier uses. Usually that's its position, except that `typeof x` names a
 * value even though it sits in a type.
 */
function meaningAt(id: ts.Node): Meaning {
  for (let n: ts.Node = id; n.parent && (ts.isQualifiedName(n.parent) || ts.isTypeQueryNode(n.parent)); n = n.parent) {
    if (ts.isTypeQueryNode(n.parent)) return "value";
  }
  return isTypePosition(id) ? "type" : "value";
}

/** A reference is deferred when it is only evaluated later (inside a function body or instance field initializer). */
function isDeferred(id: ts.Node, roots: readonly ts.Node[]): boolean {
  let n: ts.Node = id;
  while (!roots.includes(n) && n.parent) {
    const p: ts.Node = n.parent;
    if (ts.isFunctionLike(p) && (p as { name?: ts.Node }).name !== n) return true;
    if (ts.isPropertyDeclaration(p) && p.initializer === n) {
      const isStatic = (ts.getModifiers(p) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic) return true;
    }
    n = p;
  }
  return false;
}

function isTaggedTemplatePart(node: ts.Node): boolean {
  let p = node.parent;
  if (ts.isTemplateSpan(p)) p = p.parent;
  if (ts.isTemplateExpression(p)) p = p.parent;
  return ts.isTaggedTemplateExpression(p);
}

function isSkippedModifier(n: ts.Node): boolean {
  return n.kind === ts.SyntaxKind.ExportKeyword || n.kind === ts.SyntaxKind.DefaultKeyword;
}

export function canonicalizeSite(site: DefSite, ctx: CanonContext): SiteResult {
  const { checker } = ctx;
  const sf = site.sf;
  const locals = new Map<ts.Symbol, number>();
  const spans: RawSpan[] = [];
  const reserved = new Set<string>();
  const edges = new Map<number, boolean>();
  const writes = new Set<number>();
  let transform = false;
  const globals = new Set<string>();
  const ACCESSIBILITY = new Set([ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword]);

  /** If `left` is a namespace import of a project module, the definition `left.right` names. */
  const namespaceMember = (left: ts.Identifier, right: ts.Identifier): number | undefined => {
    const sym = checker.getSymbolAtLocation(left);
    if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return undefined;
    const target = checker.getAliasedSymbol(sym);
    const decl = target.declarations?.[0];
    if (!decl || !ts.isSourceFile(decl) || !ctx.projectFiles.has(decl)) return undefined;
    let m = checker.getSymbolAtLocation(right);
    if (m && m.flags & ts.SymbolFlags.Alias) m = checker.getAliasedSymbol(m);
    const d = m?.declarations?.length ? pickDef(m.declarations, right) : undefined;
    if (d === undefined) throw new UcmError(`'${left.text}.${right.text}' is not a top-level definition of ${decl.fileName}`, right);
    return d;
  };

  /** The definition a symbol denotes here. A type and a value sharing a name are one merged symbol. */
  const pickDef = (decls: readonly ts.Declaration[], at: ts.Node): number | undefined => {
    const defs = [...new Set(decls.map((d) => ctx.declToDef.get(d)).filter((d) => d !== undefined))];
    if (defs.length <= 1) return defs[0];
    const wantType = meaningAt(at) === "type";
    return defs.find((d) => (ctx.kindOf(d) === "type") === wantType) ?? defs[0];
  };

  const classifySymbol = (sym: ts.Symbol | undefined, at: ts.Node, text: string): Resolved => {
    if (!sym) return { kind: "raw", name: text };
    const decls = sym.declarations ?? [];
    const d0 = decls[0];
    if (!d0) return { kind: "global", name: text };
    const dsf = d0.getSourceFile();
    if (ts.isImportSpecifier(d0) || ts.isImportClause(d0) || ts.isNamespaceImport(d0)) {
      // imports between project files (directly or through re-exports) name a definition in the graph
      const target = checker.getAliasedSymbol(sym);
      const td = target.declarations?.[0];
      if (td && ctx.projectFiles.has(td.getSourceFile())) {
        const def = pickDef(target.declarations!, at);
        if (def !== undefined) return { kind: "def", def };
        throw new UcmError(
          ts.isSourceFile(td)
            ? `'${text}' is a namespace import of a project module; import the definitions you use by name`
            : `'${text}' is not a top-level definition of ${td.getSourceFile().fileName}`,
          at,
        );
      }
      return ctx.classifyImport(d0, meaningAt(at));
    }
    if (ctx.projectFiles.has(dsf)) {
      const def = pickDef(decls, at);
      if (def !== undefined) return { kind: "def", def };
      if (dsf === sf && site.nodes.some((n) => d0.pos >= n.pos && d0.end <= n.end)) return { kind: "local", symbol: sym };
      throw new UcmError(`cannot resolve '${text}'`, at);
    }
    if (dsf.isDeclarationFile) return { kind: "global", name: text };
    throw new UcmError(
      `'${text}' refers to a declaration in ${dsf.fileName}; import codebase definitions from '#codebase/...' instead of local files`,
      at,
    );
  };

  const refIR = (r: Resolved, at: ts.Node, text: string, shorthand?: string): IR => {
    switch (r.kind) {
      case "local": {
        let n = locals.get(r.symbol);
        if (n === undefined) {
          n = locals.size;
          locals.set(r.symbol, n);
        }
        reserved.add(text);
        return ["L", String(n)];
      }
      case "global":
        reserved.add(r.name);
        globals.add(r.name);
        return ["G", r.name];
      case "raw":
        reserved.add(r.name);
        globals.add(r.name);
        return ["U", r.name];
    }
    const pos: RefPos = site.kind === "type" || isTypePosition(at) ? "type" : "value";
    const strict = pos === "value" && !isDeferred(at, site.nodes);
    const base = { start: at.getStart(sf), end: at.end, pos, strict, shorthand };
    switch (r.kind) {
      case "def":
        spans.push({ ...base, target: { def: r.def } });
        if (r.def !== site.id) edges.set(r.def, (edges.get(r.def) ?? false) || strict);
        if (r.def !== site.id && ctx.isLet(r.def) && isAssignmentTarget(at)) writes.add(r.def);
        return ["@def", String(r.def)];
      case "hash":
        spans.push({ ...base, target: { hash: r.hash } });
        return ["Ref", r.hash];
      case "ext":
        spans.push({ ...base, target: { ext: r.ext } });
        return ["Ext", r.ext.module, r.ext.subpath, r.ext.export];
    }
  };

  const atRoot = (node: ts.Node) => site.nodes.includes(node);
  const children = (node: ts.Node, out: IR[]) => {
    ts.forEachChild(
      node,
      (c) => {
        if (!(atRoot(node) && isSkippedModifier(c))) out.push([slotOf(node, c), visit(c)]);
      },
      (arr) => {
        // only the definition's own `export` is dropped: inside a namespace, `export` changes what the code means
        const kids = arr.filter((c) => !(atRoot(node) && isSkippedModifier(c)));
        // `export function f` and `function f` must hash the same: drop a modifier list emptied by stripping
        if (kids.length === 0 && ts.canHaveModifiers(node) && node.modifiers === arr) return;
        out.push([slotOf(node, arr), ["[", ...kids.map(visit)]]);
      },
    );
  };

  const visit = (node: ts.Node): IR => {
    const k = node.kind;
    const transformable = k === ts.SyntaxKind.EnumDeclaration || k === ts.SyntaxKind.ModuleDeclaration;
    const rejected = REJECTED[k];
    if (rejected && !(transformable && ctx.allowTransformed)) throw new UcmError(rejected, node);
    if (transformable) transform = true;
    if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && (ts.getModifiers(node) ?? []).some((m) => ACCESSIBILITY.has(m.kind))) transform = true;

    switch (k) {
      case ts.SyntaxKind.Identifier: {
        const id = node as ts.Identifier;
        if (isStructuralName(id)) return ["N", id.text];
        const ref = refIR(classifySymbol(checker.getSymbolAtLocation(id), id, id.text), id, id.text);
        return isNamingPosition(id) ? ["Named", id.text, ref] : ref;
      }
      case ts.SyntaxKind.PrivateIdentifier:
        return ["PN", (node as ts.PrivateIdentifier).text];
      case ts.SyntaxKind.StringLiteral:
        return ["Str", (node as ts.StringLiteral).text];
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
        const t = node as ts.NoSubstitutionTemplateLiteral;
        return isTaggedTemplatePart(t) ? ["TStr", t.text, t.getText(sf)] : ["Str", t.text];
      }
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail: {
        const t = node as ts.TemplateLiteralLikeNode & ts.Node;
        return isTaggedTemplatePart(t) ? [kindName[k]!, t.text, t.getText(sf)] : [kindName[k]!, t.text];
      }
      case ts.SyntaxKind.NumericLiteral:
        return ["Num", String(Number((node as ts.NumericLiteral).text.replaceAll("_", "")))];
      case ts.SyntaxKind.BigIntLiteral:
        return ["BigInt", BigInt((node as ts.BigIntLiteral).text.slice(0, -1).replaceAll("_", "")).toString()];
      case ts.SyntaxKind.RegularExpressionLiteral:
        return ["Re", (node as ts.RegularExpressionLiteral).text];
      case ts.SyntaxKind.ParenthesizedExpression: {
        // `(a?.b).c` differs from `a?.b.c`; every other paren is just grouping already captured by the tree
        const inner = (node as ts.ParenthesizedExpression).expression;
        if (!ts.isOptionalChain(inner)) return visit(inner);
        break;
      }
      case ts.SyntaxKind.ParenthesizedType:
        return visit((node as ts.ParenthesizedTypeNode).type);
      case ts.SyntaxKind.ShorthandPropertyAssignment: {
        // `{ x }` hashes exactly like `{ x: x }` (and `{ x = d }` like `{ x: x = d }`): renaming what `x` refers to
        // expands the shorthand, and the expanded text must hash the same
        const s = node as ts.ShorthandPropertyAssignment;
        const sym = checker.getShorthandAssignmentValueSymbol(s);
        const ref = refIR(classifySymbol(sym, s.name, s.name.text), s.name, s.name.text, s.name.text);
        const init = s.objectAssignmentInitializer;
        const value: IR = init
          ? ["BinaryExpression", ["left", isAnonymousFunction(init) ? ["Named", s.name.text, ref] : ref], ["operatorToken", ["EqualsToken"]], ["right", visit(init)]]
          : ref;
        return ["PropertyAssignment", ["name", ["N", s.name.text]], ["initializer", value]];
      }
      case ts.SyntaxKind.BindingElement: {
        const b = node as ts.BindingElement;
        // `const { a } = o` binds a local *and* reads property `a`: keep the property name structural
        if (ts.isObjectBindingPattern(b.parent) && !b.propertyName && !b.dotDotDotToken && ts.isIdentifier(b.name)) {
          // `{ a }` hashes exactly like `{ a: a }`; a top-level binding can be renamed, and the span remembers the
          // property so the splice writes `{ a: renamed }`
          const ref = refIR(classifySymbol(checker.getSymbolAtLocation(b.name), b.name, b.name.text), b.name, b.name.text, b.name.text);
          const out: IR[] = ["BindingElement", ["propertyName", ["N", b.name.text]], ["name", isNamingPosition(b.name) ? ["Named", b.name.text, ref] : ref]];
          if (b.initializer) out.push(["initializer", visit(b.initializer)]);
          return out;
        }
        break;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const e = node as ts.ElementAccessExpression;
        const arg = e.argumentExpression;
        if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && IDENT_NAME.test(arg.text)) {
          // same IR as the PropertyAccessExpression `a.b` would produce
          const out: IR[] = ["PropertyAccessExpression", ["expression", visit(e.expression)]];
          if (e.questionDotToken) out.push(["questionDotToken", ["QuestionDotToken"]]);
          out.push(["name", ["N", arg.text]]);
          return out;
        }
        break;
      }
      case ts.SyntaxKind.PropertyAccessExpression:
      case ts.SyntaxKind.QualifiedName: {
        // `ns.member` through `import * as ns from "./mod"` (or a re-exported `export * as ns`) is a reference to
        // that member: it hashes, and is spliced, exactly as if `member` had been imported by name
        const left = ts.isPropertyAccessExpression(node) ? node.expression : (node as ts.QualifiedName).left;
        const right = ts.isPropertyAccessExpression(node) ? node.name : (node as ts.QualifiedName).right;
        const member = ts.isIdentifier(left) && ts.isIdentifier(right) ? namespaceMember(left, right) : undefined;
        if (member !== undefined) return refIR({ kind: "def", def: member }, node, right.text);
        break;
      }
      case ts.SyntaxKind.CallExpression: {
        const call = node as ts.CallExpression;
        if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = call.arguments[0];
          if (call.arguments.length !== 1 || !arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
            // a computed specifier loads code the codebase doesn't track (like `import.meta`, it depends on where
            // the module runs): allowed, hashed as written, and flagged
            ctx.warn("`import()` with a computed specifier loads code the codebase doesn't track", node);
            break;
          }
          // pinned like a static import; the generated code imports the pinned version
          const ext = ctx.classifyDynamicImport(arg.text, arg);
          spans.push({ start: arg.getStart(sf), end: arg.end, pos: "value", strict: false, target: { ext }, literal: true });
          return ["DynImport", ext.module, ext.subpath];
        }
        break;
      }
    }

    const out: IR[] = [kindName[k] ?? `Kind${k}`];
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) out.push(ts.tokenToString(node.operator)!);
    else if (ts.isTypeOperatorNode(node)) out.push(ts.tokenToString(node.operator)!);
    else if (ts.isHeritageClause(node)) out.push(ts.tokenToString(node.token)!);
    else if (ts.isMetaProperty(node)) {
      out.push(ts.tokenToString(node.keywordToken)!);
      if (node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        ctx.warn(`'${node.getText(sf)}' depends on where the module lives; in the codebase it is evaluated inside .ucm/cache`, node);
      }
    }
    else if (ts.isVariableDeclarationList(node)) {
      const scope = node.flags & ts.NodeFlags.BlockScoped;
      out.push(
        scope === ts.NodeFlags.AwaitUsing ? "await using" : scope === ts.NodeFlags.Using ? "using" : scope === ts.NodeFlags.Const ? "const" : scope === ts.NodeFlags.Let ? "let" : "var",
      );
    }
    children(node, out);
    return out;
  };

  // the salt gives separately declared definitions separate identities, even when their code is identical
  const head: IR[] = site.salt === undefined ? ["Def", site.tag] : ["Def", site.tag, ["Salt", site.salt]];
  const ir: IR = [...head, ...site.nodes.map(visit)];
  if (site.tag === "Enum" || site.tag === "Namespace") transform = true;
  return { ir, spans, reserved, edges, transform, globals, writes };
}
