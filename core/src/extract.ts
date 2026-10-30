import * as ts from "./ts.ts";
import type { DefKind, InitKind } from "./types.ts";

export class TcmError extends Error {
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
  /** from a `// tcm: path a.b.c` comment: the codebase path to bind, regardless of namespace and declared name */
  targetPath?: string;
  /** bindings of one destructuring statement share a group: one component, emitted once */
  group?: number;
}

const PATH_PRAGMA = /^\/\/\s*tcm:\s*path\s+(\S+)\s*$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function pathPragma(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let found: string | undefined;
  for (const r of ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? []) {
    const m = PATH_PRAGMA.exec(sf.text.slice(r.pos, r.end));
    if (!m) continue;
    if (!DOTTED.test(m[1]!)) throw new TcmError(`'${m[1]}' is not a valid codebase path`, node);
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

/**
 * `// @ts-expect-error` / `// @ts-ignore` comments directly above a declaration, as source pieces. They're kept with
 * the definition (they decide whether it typechecks; like other comments they aren't hashed).
 */
function directivePieces(node: ts.Node, sf: ts.SourceFile): Piece[] {
  // the line comments directly above it; a directive's explanation may continue over several of them
  const comments = ts.getLeadingCommentRanges(sf.text, node.pos) ?? [];
  let first = comments.length;
  while (first > 0 && comments[first - 1]!.kind === ts.SyntaxKind.SingleLineCommentTrivia) first--;
  const run = comments.slice(first);
  const at = run.findIndex((c) => /^\/\/\/?\s*@ts-(expect-error|ignore)\b/.test(sf.text.slice(c.pos, c.end)));
  return at < 0 ? [] : run.slice(at).flatMap((c) => [{ start: c.pos, end: c.end }, { text: "\n" }]);
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
  "tcm stores definitions, not module side effects: move this statement into a function (e.g. an exported `main`) and call it from an entry file outside the codebase";

/** Whether a namespace produces a runtime value (anything but types inside). */
function isInstantiated(ns: ts.ModuleDeclaration): boolean {
  const body = ns.body;
  if (!body || !ts.isModuleBlock(body)) return false;
  return body.statements.some(
    (s) =>
      !ts.isTypeAliasDeclaration(s) &&
      !ts.isInterfaceDeclaration(s) &&
      !(ts.isImportDeclaration(s) && ts.isTypeOnlyImport(s.importClause)) &&
      !(ts.isModuleDeclaration(s) && !isInstantiated(s)),
  );
}

export function extract(sf: ts.SourceFile, mode: ExtractMode = "scratch", firstId = 0): Extracted {
  const defs: DefSite[] = [];
  const watches: DefSite[] = [];
  const imports: ts.ImportDeclaration[] = [];
  const warnings: string[] = [];
  /** keyed by `<space> <name>`, space being "type" or "value" */
  const byName = new Map<string, DefSite>();

  let targetPath: string | undefined;
  // a `// tcm: namespace` line below the one a scratch file starts with begins a section: the definitions after it
  // go to that namespace
  const fileNs = mode === "scratch" ? /^\/\/\s*tcm:\s*namespace\s+(\S+)/m.exec(sf.text.split("\n").slice(0, 5).join("\n"))?.[1] : undefined;
  let section: string | undefined;
  let groups = 0;
  /** the current statement's directive comments: they go with its first definition (all of a destructuring's) */
  let directives: Piece[] = [];
  const push = (fields: Omit<DefSite, "id" | "isWatch" | "sf" | "targetPath">) => {
    const site = { ...fields, targetPath: targetPath ?? (section !== undefined ? (section ? `${section}.${fields.name}` : fields.name) : undefined) };
    if (directives.length) {
      site.pieces = [...directives, ...site.pieces];
      if (site.group === undefined) directives = [];
    }
    // one name may bind a type and a value (`const User = z.object(…)` + `type User = …`); a class is both
    const space = site.kind === "type" ? "type" : site.kind === "class" ? "both" : "value";
    for (const s of space === "both" ? ["type", "value"] : [space]) {
      if (byName.has(`${s} ${site.name}`)) {
        throw new TcmError(
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
    directives = directivePieces(st, sf);
    const mods = modifierKinds(st);
    if (mods.includes(ts.SyntaxKind.DeclareKeyword)) {
      // `declare const brand: unique symbol` (a value that exists only for its type) is a type-only definition in
      // imported code; anything else ambient (modules, globals) would describe code tcm can't see
      if (mode === "import" && ts.isVariableStatement(st)) {
        const kw = ts.tokenToString(st.declarationList.flags & ts.NodeFlags.Const ? ts.SyntaxKind.ConstKeyword : st.declarationList.flags & ts.NodeFlags.Let ? ts.SyntaxKind.LetKeyword : ts.SyntaxKind.VarKeyword);
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) throw new TcmError("ambient destructuring is not supported", decl);
          push({
            name: decl.name.text,
            kind: "type",
            nodes: [decl],
            tag: "Declare",
            pieces: [{ text: `declare ${kw} ` }, { start: decl.getStart(sf), end: decl.end }],
            initKind: "hoisted",
            declarations: [decl],
            doc: st.declarationList.declarations.length === 1 ? jsDocText(st, sf) : undefined,
            nameNode: decl.name,
            nominal: true,
          });
        }
        continue;
      }
      throw new TcmError("`declare` is not supported; external code comes in through `import`.", st);
    }
    const doc = jsDocText(st, sf);
    targetPath = pathPragma(st, sf);
    const ns = mode === "scratch" ? namespacePragma(st, sf) : undefined;
    if (ns !== undefined && (section !== undefined || ns !== fileNs)) section = ns;
    if (targetPath && ts.isVariableStatement(st) && st.declarationList.declarations.length > 1) {
      throw new TcmError("a `// tcm: path` comment names one definition; split this `const` list", st);
    }

    if (ts.isImportDeclaration(st)) {
      imports.push(st);
    } else if (ts.isFunctionDeclaration(st)) {
      if (!st.name) throw new TcmError("anonymous default export: give the function a name.", st);
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
        if (j > 0) pieces.push({ text: "\n" }, ...directivePieces(fn, sf));
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
      // a top-level `let` in imported code is module state (a lazy cache, a config cell): it's nominal, so two
      // identical declarations are still two cells, and whatever assigns to it shares its component
      const blockScope = st.declarationList.flags & ts.NodeFlags.BlockScoped;
      if (mode === "import" && blockScope === ts.NodeFlags.Let) {
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) throw new TcmError("a top-level `let` with destructuring is not supported", decl);
          push({
            name: decl.name.text,
            kind: "term",
            nodes: [decl],
            tag: "Let",
            pieces: [{ text: "let " }, { start: decl.getStart(sf), end: decl.end }],
            // with nothing to evaluate it can go first, before the functions that assign it are declared
            initKind: decl.initializer ? "strict" : "hoisted",
            declarations: [decl],
            doc: st.declarationList.declarations.length === 1 ? doc : undefined,
            nameNode: decl.name,
            nominal: true,
          });
        }
        continue;
      }
      if (blockScope !== ts.NodeFlags.Const) {
        throw new TcmError(
          "top-level `let`/`var`/`using` is not supported: codebase bindings are immutable. Use `const` (the value itself may be mutable, e.g. `const cache = new Map()`).",
          st,
        );
      }
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          // `const { a, b: [c] } = init()`: every bound name is its own definition, but the statement runs
          // once, so they share its source and are hashed and emitted together (see DefSite.group)
          if (targetPath) throw new TcmError("a `// tcm: path` comment can't name the bindings of a destructuring", decl);
          const group = groups++;
          const bind = (pattern: ts.BindingName) => {
            if (ts.isIdentifier(pattern)) return;
            for (const el of pattern.elements) {
              if (ts.isOmitted(el)) continue;
              if (!ts.isIdentifier(el.name!)) {
                bind(el.name!);
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
      if (!st.name) throw new TcmError("anonymous default export: give the class a name.", st);
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
    } else if (ts.isEnumDeclaration(st) && mode === "import") {
      // imported code may use syntax Node can't strip: it's compiled when run (see the cache transform hook)
      push({
        name: st.name.text,
        kind: "class", // a type and a value, like a class
        nodes: [st],
        tag: "Enum",
        pieces: [{ start: strippedStart(st, sf), end: st.end }],
        initKind: "strict",
        declarations: [st],
        doc,
        nameNode: st.name,
        nominal: false,
      });
    } else if (ts.isModuleDeclaration(st) && mode === "import" && ts.isIdentifier(st.name) && st.body && ts.isModuleBlock(st.body)) {
      // a namespace is a value (or only a type, if it holds nothing but types); it can pair with a same-named type
      push({
        name: st.name.text,
        kind: isInstantiated(st) ? "term" : "type",
        nodes: [st],
        tag: "Namespace",
        pieces: [{ start: strippedStart(st, sf), end: st.end }],
        initKind: "strict",
        declarations: [st],
        doc,
        nameNode: st.name,
        nominal: false,
      });
    } else if (ts.isEnumDeclaration(st)) {
      throw new TcmError(`enums are not supported in scratch files: ${NON_ERASABLE_HINT} (\`tcm import\` accepts them).`, st);
    } else if (ts.isModuleDeclaration(st)) {
      throw new TcmError(`namespaces are not supported${mode === "import" ? " in this form (dotted or ambient)" : " in scratch files"}: ${NON_ERASABLE_HINT}.`, st);
    } else if (ts.isImportEqualsDeclaration(st)) {
      throw new TcmError("`import x = require(...)` is not supported; use an ES import.", st);
    } else if (ts.isExportAssignment(st)) {
      throw new TcmError("`export default <expression>` is not supported: give it a name with `const`.", st);
    } else if (ts.isExportDeclaration(st)) {
      // `export {}` only marks the file as a module
      const empty = !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause) && !st.exportClause.elements.length;
      if (mode === "import" || empty) continue;
      warnings.push(`ignoring export list at line ${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}: exports have no meaning in a codebase`);
    } else if (ts.isExpressionStatement(st)) {
      if (mode === "import") throw new TcmError(`top-level expression statement: ${SIDE_EFFECT_HINT}.`, st);
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
      throw new TcmError(
        mode === "import"
          ? `top-level ${ts.SyntaxKind[st.kind]}: ${SIDE_EFFECT_HINT}.`
          : `top-level ${ts.SyntaxKind[st.kind]} is not supported: a scratch file contains declarations, imports, and watch expressions.`,
        st,
      );
    }
  }
  return { defs, watches, imports, warnings };
}

/**
 * A `// tcm: namespace a.b` line among the comments before a statement: the namespace it names.
 */
export function namespacePragma(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let found: string | undefined;
  for (const r of ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? []) {
    const m = /^\/\/\s*tcm:\s*namespace\s+(\S+)\s*$/.exec(sf.text.slice(r.pos, r.end));
    if (m) found = m[1];
  }
  return found;
}
