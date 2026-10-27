import ts from "typescript";
import type { IR } from "./hash.ts";
import { isAnonymousFunction, UcmError, type DefSite } from "./extract.ts";
import type { ExtRef, RefPos } from "./types.ts";

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
}

export interface SiteResult {
  /** IR with intra-file definition references left as `["@def", id]` placeholders */
  ir: IR;
  spans: RawSpan[];
  reserved: Set<string>;
  /** referenced same-file definitions → whether any reference is evaluated at module init */
  edges: Map<number, boolean>;
}

export interface CanonContext {
  checker: ts.TypeChecker;
  /** files being analyzed together; references between them resolve to definitions */
  projectFiles: Set<ts.SourceFile>;
  warn(message: string, node: ts.Node): void;
  declToDef: Map<ts.Node, number>;
  classifyImport(decl: ts.ImportSpecifier | ts.ImportClause | ts.NamespaceImport): Resolved;
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
        for (const d of target.declarations!) {
          const def = ctx.declToDef.get(d);
          if (def !== undefined) return { kind: "def", def };
        }
        throw new UcmError(
          ts.isSourceFile(td)
            ? `'${text}' is a namespace import of a project module; import the definitions you use by name`
            : `'${text}' is not a top-level definition of ${td.getSourceFile().fileName}`,
          at,
        );
      }
      return ctx.classifyImport(d0);
    }
    if (ctx.projectFiles.has(dsf)) {
      for (const d of decls) {
        const def = ctx.declToDef.get(d);
        if (def !== undefined) return { kind: "def", def };
      }
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
        return ["G", r.name];
      case "raw":
        reserved.add(r.name);
        return ["U", r.name];
    }
    const pos: RefPos = site.kind === "type" || isTypePosition(at) ? "type" : "value";
    const strict = pos === "value" && !isDeferred(at, site.nodes);
    const base = { start: at.getStart(sf), end: at.end, pos, strict, shorthand };
    switch (r.kind) {
      case "def":
        spans.push({ ...base, target: { def: r.def } });
        if (r.def !== site.id) edges.set(r.def, (edges.get(r.def) ?? false) || strict);
        return ["@def", String(r.def)];
      case "hash":
        spans.push({ ...base, target: { hash: r.hash } });
        return ["Ref", r.hash];
      case "ext":
        spans.push({ ...base, target: { ext: r.ext } });
        return ["Ext", r.ext.module, r.ext.subpath, r.ext.export];
    }
  };

  const children = (node: ts.Node, out: IR[]) => {
    ts.forEachChild(
      node,
      (c) => {
        if (!isSkippedModifier(c)) out.push([slotOf(node, c), visit(c)]);
      },
      (arr) => {
        const kids = arr.filter((c) => !isSkippedModifier(c));
        // `export function f` and `function f` must hash the same: drop a modifier list emptied by stripping
        if (kids.length === 0 && ts.canHaveModifiers(node) && node.modifiers === arr) return;
        out.push([slotOf(node, arr), ["[", ...kids.map(visit)]]);
      },
    );
  };

  const visit = (node: ts.Node): IR => {
    const k = node.kind;
    const rejected = REJECTED[k];
    if (rejected) throw new UcmError(rejected, node);

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
        const s = node as ts.ShorthandPropertyAssignment;
        const sym = checker.getShorthandAssignmentValueSymbol(s);
        const out: IR[] = ["Short", s.name.text, refIR(classifySymbol(sym, s.name, s.name.text), s.name, s.name.text, s.name.text)];
        if (s.objectAssignmentInitializer) out.push(visit(s.objectAssignmentInitializer));
        return out;
      }
      case ts.SyntaxKind.BindingElement: {
        const b = node as ts.BindingElement;
        // `const { a } = o` binds a local *and* reads property `a`: keep the property name structural
        if (ts.isObjectBindingPattern(b.parent) && !b.propertyName && !b.dotDotDotToken && ts.isIdentifier(b.name)) {
          const out: IR[] = ["BindShort", b.name.text, refIR(classifySymbol(checker.getSymbolAtLocation(b.name), b.name, b.name.text), b.name, b.name.text)];
          if (b.initializer) out.push(visit(b.initializer));
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
      case ts.SyntaxKind.CallExpression: {
        if ((node as ts.CallExpression).expression.kind === ts.SyntaxKind.ImportKeyword) {
          throw new UcmError("dynamic `import()` is not content-addressable; use a static import", node);
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
  return { ir, spans, reserved, edges };
}
