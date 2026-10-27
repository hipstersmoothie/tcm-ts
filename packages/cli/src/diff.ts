import { shortHash, type DefKind, type IR } from "@ucm/core";
import type { LogEntry, NameRow } from "@ucm/store";
import { render } from "@ucm/loader";
import type { Codebase } from "./codebase.ts";
import { bold, cyan, dim, green, red, yellow } from "./style.ts";

/**
 * A namespace at some point: name → the hashes it points to (more than one means conflicted). Types are keyed
 * `path (type)`, so a type and a value sharing a path are compared, diffed and merged independently.
 */
export type NameState = Map<string, Set<string>>;

const TYPE_SUFFIX = " (type)";
export const stateKey = (path: string, kind: DefKind) => (kind === "type" ? path + TYPE_SUFFIX : path);
export const keyPath = (key: string) => (key.endsWith(TYPE_SUFFIX) ? key.slice(0, -TYPE_SUFFIX.length) : key);

export function stateOf(rows: NameRow[]): NameState {
  const s: NameState = new Map();
  for (const r of rows) s.set(stateKey(r.path, r.kind), (s.get(stateKey(r.path, r.kind)) ?? new Set()).add(r.hash));
  return s;
}

/** Undo log entries (newest first) to recover an earlier namespace. */
export function rewind(now: NameState, entries: LogEntry[]): NameState {
  const s: NameState = new Map([...now].map(([p, hs]) => [p, new Set(hs)]));
  const add = (p: string, h: string) => s.set(p, (s.get(p) ?? new Set()).add(h));
  const remove = (p: string, h: string) => {
    s.get(p)?.delete(h);
    if (s.get(p)?.size === 0) s.delete(p);
  };
  for (const e of entries) {
    const k = stateKey(e.path, e.kind);
    if (e.op === "add") remove(k, e.newHash!);
    else if (e.op === "delete") add(k, e.oldHash!);
    else {
      remove(k, e.newHash!);
      if (e.oldHash) add(k, e.oldHash);
    }
  }
  return s;
}

export interface Change {
  path: string;
  old: string;
  new: string;
}

export interface NamespaceDiff {
  /** the code itself changed */
  edited: Change[];
  /** only references to other changed definitions moved; `because` names them */
  propagated: (Change & { because: string[] })[];
  added: { path: string; hash: string }[];
  removed: { path: string; hash: string }[];
  renamed: { from: string; to: string; hash: string }[];
  aliased: { path: string; hash: string; existing: string[] }[];
  conflicted: { path: string; hashes: string[] }[];
}

function substRefs(ir: IR, map: Map<string, string>, hit: Set<string>): IR {
  if (typeof ir === "string") return ir;
  if (ir[0] === "Ref" && ir.length === 2 && typeof ir[1] === "string" && map.has(ir[1])) {
    hit.add(ir[1]);
    return ["Ref", map.get(ir[1])!];
  }
  return ir.map((c) => substRefs(c, map, hit));
}

export function diffNamespaces(before: NameState, after: NameState, irOf: (hash: string) => string): NamespaceDiff {
  const d: NamespaceDiff = { edited: [], propagated: [], added: [], removed: [], renamed: [], aliased: [], conflicted: [] };
  const changed: Change[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const o = before.get(path) ?? new Set<string>();
    const n = after.get(path) ?? new Set<string>();
    if (o.size === n.size && [...o].every((h) => n.has(h))) continue;
    if (n.size > 1) d.conflicted.push({ path, hashes: [...n] });
    else if (o.size === 0) d.added.push({ path, hash: [...n][0]! });
    else if (n.size === 0) for (const h of o) d.removed.push({ path, hash: h });
    else for (const h of o) changed.push({ path, old: h, new: [...n][0]! });
  }

  // a hash that left one name and arrived at another was renamed
  for (const a of [...d.added]) {
    const r = d.removed.find((x) => x.hash === a.hash);
    if (!r) continue;
    d.renamed.push({ from: r.path, to: a.path, hash: a.hash });
    d.added.splice(d.added.indexOf(a), 1);
    d.removed.splice(d.removed.indexOf(r), 1);
  }
  // a hash that gained a name while keeping an old one was aliased
  const pathsBefore = new Map<string, string[]>();
  for (const [p, hs] of before) for (const h of hs) pathsBefore.set(h, [...(pathsBefore.get(h) ?? []), p]);
  for (const a of [...d.added]) {
    const existing = (pathsBefore.get(a.hash) ?? []).filter((p) => after.get(p)?.has(a.hash));
    if (!existing.length) continue;
    d.aliased.push({ ...a, existing });
    d.added.splice(d.added.indexOf(a), 1);
  }

  // A definition is a pure propagation if rewriting its references through this diff's own
  // old → new pairs reproduces the new definition exactly.
  const remap = new Map(changed.map((c) => [c.old, c.new]));
  for (const c of changed) {
    const hit = new Set<string>();
    const rewritten = JSON.stringify(substRefs(JSON.parse(irOf(c.old)) as IR, remap, hit));
    if (hit.size && rewritten === irOf(c.new)) d.propagated.push({ ...c, because: [...hit].map((h) => remap.get(h)!) });
    else d.edited.push(c);
  }
  return d;
}

/** Longest-common-subsequence line diff. Definitions are short, so O(n·m) is fine. */
function lineDiff(a: string[], b: string[]): [" " | "-" | "+", string][] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: [" " | "-" | "+", string][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) (out.push([" ", a[i]!]), i++, j++);
    // on ties, removals come first so old lines print above their replacements
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(["-", a[i++]!]);
    else out.push(["+", b[j++]!]);
  }
  return out;
}

export function isEmpty(d: NamespaceDiff): boolean {
  return Object.values(d).every((xs: unknown[]) => xs.length === 0);
}

function namesIn(state: NameState): (hash: string) => string | undefined {
  const byHash = new Map<string, string>();
  for (const [k, hs] of [...state].sort(([a], [b]) => a.localeCompare(b))) for (const h of hs) if (!byHash.has(h)) byHash.set(h, keyPath(k));
  return (h) => byHash.get(h);
}

export function printDiff(cb: Codebase, d: NamespaceDiff, before: NameState, after: NameState, title: string) {
  console.log(bold(title));
  if (isEmpty(d)) return console.log(dim("  no changes"));
  const src = cb.source();
  const [oldNames, newNames] = [namesIn(before), namesIn(after)];
  const body = (hash: string, nameOf: (h: string) => string | undefined) =>
    render([src.get(hash)!], src, cb.lay, { style: "scratch", omitImports: true, nameOf }).text.trimEnd().split("\n");
  const name = (hash: string) => newNames(hash) ?? shortHash(hash);
  const section = (label: string, n: number) => n && console.log(`\n  ${dim(label)}`);

  section("edited", d.edited.length);
  for (const c of d.edited) {
    console.log(`    ${yellow("~")} ${bold(c.path)}  ${dim(`${shortHash(c.old)} → ${shortHash(c.new)}`)}`);
    const lines = lineDiff(body(c.old, oldNames), body(c.new, newNames));
    lines.forEach(([op, line], k) => {
      // keep two lines of context around changes in long definitions
      const near = lines.slice(Math.max(0, k - 2), k + 3).some(([o]) => o !== " ");
      if (op === " " && !near && lines.length > 12) {
        if (lines[k - 1]?.[0] !== " " || k === 0) console.log(dim("        ⋮"));
        return;
      }
      console.log(op === "-" ? red(`      - ${line}`) : op === "+" ? green(`      + ${line}`) : dim(`        ${line}`));
    });
  }
  section("updated because a dependency changed (code unchanged)", d.propagated.length);
  for (const c of d.propagated) {
    console.log(`    ${yellow("~")} ${c.path}  ${dim(`${shortHash(c.old)} → ${shortHash(c.new)}  via ${c.because.map(name).join(", ")}`)}`);
  }
  section("added", d.added.length);
  for (const a of d.added) console.log(`    ${green("+")} ${bold(a.path)}  ${dim(`${shortHash(a.hash)} : ${src.get(a.hash)!.signature}`)}`);
  section("removed", d.removed.length);
  for (const r of d.removed) console.log(`    ${red("-")} ${r.path}  ${dim(shortHash(r.hash))}`);
  section("renamed", d.renamed.length);
  for (const r of d.renamed) console.log(`    ${cyan(">")} ${r.from} → ${bold(r.to)}  ${dim(shortHash(r.hash))}`);
  section("aliased", d.aliased.length);
  for (const a of d.aliased) console.log(`    ${cyan("&")} ${bold(a.path)}  ${dim(`same as ${a.existing.join(", ")}`)}`);
  section("conflicted", d.conflicted.length);
  for (const c of d.conflicted) console.log(`    ${red("!")} ${bold(c.path)}  ${dim(c.hashes.map((h) => shortHash(h)).join(", "))}`);
}
