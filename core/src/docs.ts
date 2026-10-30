// Docs as code, as in Unison: a definition's JSDoc can link to definitions ({@link square}), embed them
// ({@source square}, {@signature square}) and give examples (```ts blocks) that are typechecked and evaluated.
// The names in all of these are resolved to hashes when the definition is added, so docs follow renames and
// updates instead of going stale. This file finds those parts in a doc's text.
import * as ts from "./ts.ts";

/** A tag naming a definition: `{@link lib.square}`, `{@link square | the square}`, `{@source square}`. */
export interface DocTag {
  tag: "link" | "linkcode" | "source" | "signature";
  /** the whole tag, `{` to `}` */
  start: number;
  end: number;
  /** the name inside it */
  nameStart: number;
  nameEnd: number;
  name: string;
  label?: string;
}

/** A ```ts (or ```typescript) block: an example, typechecked and evaluated. */
export interface DocExample {
  /** the code, from after the opening fence's line to before the closing fence */
  start: number;
  end: number;
  code: string;
}

const TAG = /\{@(link|linkcode|linkplain|source|signature)\s+([A-Za-z_$#][\w$.]*)(?:\s*\|\s*([^}]*)|\s+([^}]*))?\}/g;
const FENCE = /^([ \t]*)```(ts|typescript)[ \t]*\n([\s\S]*?)^\1```[ \t]*$/gm;

export function docTags(doc: string): DocTag[] {
  const out: DocTag[] = [];
  for (const m of doc.matchAll(TAG)) {
    const nameStart = m.index! + m[0].indexOf(m[2]!, m[1]!.length + 2);
    const label = (m[3] ?? m[4])?.trim();
    out.push({
      tag: m[1] === "linkplain" ? "link" : (m[1] as DocTag["tag"]),
      start: m.index!,
      end: m.index! + m[0].length,
      nameStart,
      nameEnd: nameStart + m[2]!.length,
      name: m[2]!,
      ...(label ? { label } : {}),
    });
  }
  return out;
}

export function docExamples(doc: string): DocExample[] {
  const out: DocExample[] = [];
  for (const m of doc.matchAll(FENCE)) {
    const start = m.index! + m[0].indexOf("\n") + 1;
    out.push({ start, end: start + m[3]!.length, code: m[3]! });
  }
  return out;
}

/**
 * The names an example uses from outside itself (where they are in `code`): references, not property names or
 * names the example declares. Each may be a definition in scope where the doc is.
 */
export function exampleNames(code: string): { start: number; end: number; name: string; type: boolean }[] {
  const sf = ts.parse("example.ts", code);
  const declared = new Set<string>();
  const declare = (n: ts.BindingName) => {
    if (ts.isIdentifier(n)) declared.add(n.text);
    else for (const e of n.elements) if (!ts.isOmitted(e)) declare(e.name!);
  };
  const collect = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.name) declare(n.name);
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) declared.add(n.name.text);
    if (ts.isTypeParameterDeclaration(n)) declared.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const out: { start: number; end: number; name: string; type: boolean }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && !declared.has(n.text)) {
      const p = n.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isQualifiedName(p) && p.right === n) ||
        ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        ts.isLabeledStatement(p) ||
        ts.isBreakOrContinueStatement(p);
      if (!isName) out.push({ start: n.getStart(sf), end: n.end, name: n.text, type: ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Where each top-level statement of some code starts, after the comments above it (to put `export` there). */
export function statementStarts(code: string, jsx = false): number[] {
  // (JSX only parses as .tsx)
  const sf = ts.parse(jsx ? "code.tsx" : "code.ts", code);
  return sf.statements.map((s) => s.getStart(sf));
}
