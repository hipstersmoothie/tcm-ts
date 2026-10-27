import ts from "typescript";
import type { DefKind, InitKind } from "./types.ts";

export class UcmError extends Error {
  readonly node: ts.Node | undefined;
  constructor(message: string, node?: ts.Node) {
    super(node ? `${location(node)}: ${message}` : message);
    this.node = node;
  }
}

function location(node: ts.Node): string {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${sf.fileName}:${line + 1}:${character + 1}`;
}

/** Source text is assembled from file ranges and literal strings (e.g. `const ` for one binding of a multi-binding list). */
export type Piece = { text: string } | { start: number; end: number };

/** One top-level binding found in a source file. */
export interface DefSite {
  id: number;
  sf: ts.SourceFile;
  name: string;
  kind: DefKind;
  /** roots of the definition's syntax; identifiers resolving inside these are locals */
  nodes: ts.Node[];
  /** tag used as the head of the definition's IR */
  tag: string;
  pieces: Piece[];
  initKind: InitKind;
  /** declarations (by node identity) that bind this definition's name */
  declarations: ts.Node[];
  doc?: string;
  isWatch: boolean;
  /** the identifier naming this definition (for signature lookup) */
  nameNode?: ts.Node;
  /** JavaScript can observe the declared name (`f.name`, `constructor.name`) */
  nominal: boolean;
  /** lineage salt giving the definition its own identity; see AnalyzeHost.saltFor */
  salt?: string;
  /** from a `// ucm: path a.b.c` comment: the codebase path to bind, regardless of namespace and declared name */
  targetPath?: string;
  /** bindings of one destructuring statement share a group: one component, emitted once */
  group?: number;
}

const PATH_PRAGMA = /^\/\/\s*ucm:\s*path\s+(\S+)\s*$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function pathPragma(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let found: string | undefined;
  for (const r of ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? []) {
    const m = PATH_PRAGMA.exec(sf.text.slice(r.pos, r.end));
    if (!m) continue;
    if (!DOTTED.test(m[1]!)) throw new UcmError(`'${m[1]}' is not a valid codebase path`, node);
    found = m[1];
  }
  return found;
}

/**
 * An anonymous function or class expression, after erasable wrappers. Binding one to a name gives it that
 * name at runtime (`const f = () => 1` has `f.name === "f"`).
 */
export function isAnonymousFunction(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression;
  }
  return ts.isArrowFunction(e) || ((ts.isFunctionExpression(e) || ts.isClassExpression(e)) && !e.name);
}

export interface Extracted {
  defs: DefSite[];
  watches: DefSite[];
  imports: ts.ImportDeclaration[];
  warnings: string[];
}

const NON_ERASABLE_HINT = "Node's type stripping cannot run it; use an `as const` object or plain functions instead";

function modifierKinds(node: ts.Node): ts.SyntaxKind[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).map((m) => m.kind) : [];
}

/** Start of a declaration with `export` / `default` modifiers removed. */
function strippedStart(node: ts.Node, sf: ts.SourceFile): number {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!mods) return node.getStart(sf);
  let last: ts.Node | undefined;
  for (const m of mods) {
    if (m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword) last = m;
    else break;
  }
  if (!last) return node.getStart(sf);
  const rest = sf.text.slice(last.end);
  const skip = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(rest)![0].length;
  return last.end + skip;
}

function jsDocText(node: ts.Node, sf: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const docs = ranges.filter((r) => sf.text.startsWith("/**", r.pos));
  const last = docs.at(-1);
  if (!last) return undefined;
  return sf.text
    .slice(last.pos + 3, last.end - 2)
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/**
 * `scratch`: bare expressions are watch expressions.
 * `import`: an existing module; re-export lists are plumbing and are skipped, side-effecting statements are errors.
 */
export type ExtractMode = "scratch" | "import";

const SIDE_EFFECT_HINT =
  "ucm stores definitions, not module side effects: move this statement into a function (e.g. an exported `main`) and call it from an entry file outside the codebase";

export function extract(sf: ts.SourceFile, mode: ExtractMode = "scratch", firstId = 0): Extracted {
  const defs: DefSite[] = [];
  const watches: DefSite[] = [];
  const imports: ts.ImportDeclaration[] = [];
  const warnings: string[] = [];
  /** keyed by `<space> <name>`, space being "type" or "value" */
  const byName = new Map<string, DefSite>();

  let targetPath: string | undefined;
  let groups = 0;
  const push = (fields: Omit<DefSite, "id" | "isWatch" | "sf" | "targetPath">) => {
    const site = { ...fields, targetPath };
    // one name may bind a type and a value (`const User = z.object(…)` + `type User = …`); a class is both
    const space = site.kind === "type" ? "type" : site.kind === "class" ? "both" : "value";
    for (const s of space === "both" ? ["type", "value"] : [space]) {
      if (byName.has(`${s} ${site.name}`)) {
        throw new UcmError(
          `'${site.name}' is declared more than once. A name binds one definition, or one type plus one value (declaration merging is not supported).`,
          site.nodes[0],
        );
      }
    }
    const def: DefSite = { ...site, sf, id: firstId + defs.length, isWatch: false };
    defs.push(def);
    for (const s of space === "both" ? ["type", "value"] : [space]) byName.set(`${s} ${site.name}`, def);
  };

  const statements = sf.statements;
  for (let i = 0; i < statements.length; i++) {
    const st = statements[i]!;
    const mods = modifierKinds(st);
    if (mods.includes(ts.SyntaxKind.DeclareKeyword)) {
      throw new UcmError("`declare` is not supported; external code comes in through `import`.", st);
    }
    const doc = jsDocText(st, sf);
    targetPath = pathPragma(st, sf);
    if (targetPath && ts.isVariableStatement(st) && st.declarationList.declarations.length > 1) {
      throw new UcmError("a `// ucm: path` comment names one definition; split this `const` list", st);
    }

    if (ts.isImportDeclaration(st)) {
      imports.push(st);
    } else if (ts.isFunctionDeclaration(st)) {
      if (!st.name) throw new UcmError("anonymous default export: give the function a name.", st);
      // overload signatures followed by the implementation form one definition
      const group: ts.FunctionDeclaration[] = [st];
      while (!group.at(-1)!.body) {
        const next = statements[i + 1];
        if (!next || !ts.isFunctionDeclaration(next) || next.name?.text !== st.name.text) break;
        group.push(next);
        i++;
      }
      const pieces: Piece[] = [];
      for (const [j, fn] of group.entries()) {
        if (j > 0) pieces.push({ text: "\n" });
        pieces.push({ start: strippedStart(fn, sf), end: fn.end });
      }
      push({
        name: st.name.text,
        kind: "term",
        nodes: group,
        tag: "Function",
        pieces,
        initKind: "hoisted",
        declarations: group,
        doc,
        nameNode: group.at(-1)!.name,
        nominal: true,
      });
    } else if (ts.isVariableStatement(st)) {
      // AwaitUsing is Const|Using, so compare the masked value rather than testing bits
      if ((st.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) {
        throw new UcmError(
          "top-level `let`/`var`/`using` is not supported: codebase bindings are immutable. Use `const` (the value itself may be mutable, e.g. `const cache = new Map()`).",
          st,
        );
      }
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          // `const { a, b: [c] } = init()`: every bound name is its own definition, but the statement runs
          // once, so they share its source and are hashed and emitted together (see DefSite.group)
          if (targetPath) throw new UcmError("a `// ucm: path` comment can't name the bindings of a destructuring", decl);
          const group = groups++;
          const bind = (pattern: ts.BindingName) => {
            if (ts.isIdentifier(pattern)) return;
            for (const el of pattern.elements) {
              if (ts.isOmittedExpression(el)) continue;
              if (!ts.isIdentifier(el.name)) {
                bind(el.name);
                continue;
              }
              push({
                name: el.name.text,
                kind: "term",
                nodes: [decl],
                tag: "Destructure",
                pieces: [{ text: "const " }, { start: decl.getStart(sf), end: decl.end }],
                initKind: "strict",
                declarations: [el],
                nameNode: el.name,
                nominal: !!el.initializer && isAnonymousFunction(el.initializer),
                group,
              });
            }
          };
          bind(decl.name);
          continue;
        }
        push({
          name: decl.name.text,
          kind: "term",
          nodes: [decl],
          tag: "Const",
          pieces: [{ text: "const " }, { start: decl.getStart(sf), end: decl.end }],
          initKind: "strict",
          declarations: [decl],
          doc: st.declarationList.declarations.length === 1 ? doc : undefined,
          nameNode: decl.name,
          nominal: !!decl.initializer && isAnonymousFunction(decl.initializer),
        });
      }
    } else if (ts.isClassDeclaration(st)) {
      if (!st.name) throw new UcmError("anonymous default export: give the class a name.", st);
      push({
        name: st.name.text,
        kind: "class",
        nodes: [st],
        tag: "Class",
        pieces: [{ start: strippedStart(st, sf), end: st.end }],
        initKind: "strict",
        declarations: [st],
        doc,
        nameNode: st.name,
        nominal: true,
      });
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      push({
        name: st.name.text,
        kind: "type",
        nodes: [st],
        tag: ts.isInterfaceDeclaration(st) ? "Interface" : "TypeAlias",
        pieces: [{ start: strippedStart(st, sf), end: st.end }],
        initKind: "hoisted",
        declarations: [st],
        doc,
        nameNode: st.name,
        nominal: false,
      });
    } else if (ts.isEnumDeclaration(st)) {
      throw new UcmError(`enums are not supported: ${NON_ERASABLE_HINT}.`, st);
    } else if (ts.isModuleDeclaration(st)) {
      throw new UcmError(`namespaces are not supported: ${NON_ERASABLE_HINT}.`, st);
    } else if (ts.isImportEqualsDeclaration(st)) {
      throw new UcmError("`import x = require(...)` is not supported; use an ES import.", st);
    } else if (ts.isExportAssignment(st)) {
      throw new UcmError("`export default <expression>` is not supported: give it a name with `const`.", st);
    } else if (ts.isExportDeclaration(st)) {
      if (mode === "import") continue;
      warnings.push(`ignoring export list at line ${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}: exports have no meaning in a codebase`);
    } else if (ts.isExpressionStatement(st)) {
      if (mode === "import") throw new UcmError(`top-level expression statement: ${SIDE_EFFECT_HINT}.`, st);
      const name = `__watch_${watches.length}`;
      watches.push({
        id: -1 - watches.length,
        sf,
        name,
        kind: "term",
        nodes: [st.expression],
        tag: "Watch",
        pieces: [{ text: `const ${name} = ` }, { start: st.expression.getStart(sf), end: st.expression.end }],
        initKind: "strict",
        declarations: [],
        isWatch: true,
        nominal: false,
      });
    } else if (st.kind === ts.SyntaxKind.EmptyStatement) {
      // ignore stray semicolons
    } else {
      throw new UcmError(
        mode === "import"
          ? `top-level ${ts.SyntaxKind[st.kind]}: ${SIDE_EFFECT_HINT}.`
          : `top-level ${ts.SyntaxKind[st.kind]} is not supported: a scratch file contains declarations, imports, and watch expressions.`,
        st,
      );
    }
  }
  return { defs, watches, imports, warnings };
}
