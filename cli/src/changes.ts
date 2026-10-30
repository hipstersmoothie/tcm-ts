import { shortHash } from "@tcm/core";
import { stateOf, keyPath, diffNamespaces } from "./diff.ts";
import type { NameState } from "./diff.ts";
import type { Codebase } from "./codebase.ts";

/**
 * A branch, for the editor: whether it's this one, how many names differ from this one's, and when it last changed.
 */
export interface BranchItem {
  name: string;
  current: boolean;
  differs: number;
  ts?: number;
}

/**
 * A history entry, for the editor: `back` is how many entries back it is on its branch (what `tcm reset` takes).
 */
export interface HistoryItem {
  hash: string;
  short: string;
  command: string;
  ts: number;
  parents: string[];
  back: number;
}

/**
 * A name that changed, as `tcm diff` sorts it: its code edited, re-hashed only because what it uses changed
 * (`because`), added, removed, renamed (`from`), given another name (`existing`), or conflicted. `old` and `hash` are
 * the hashes before and after, `oldUri` and `uri` their documents (a file has none: it opens as a page).
 */
export interface NameChange {
  change: "edited" | "propagated" | "added" | "removed" | "renamed" | "aliased" | "conflicted";
  path: string;
  hash?: string;
  old?: string;
  uri?: string;
  oldUri?: string;
  from?: string;
  because?: string[];
  existing?: string[];
  hashes?: string[];
}

/**
 * The codebase's branches, this one first.
 */
export function branchList(cb: Codebase): BranchItem[] {
  const current = cb.store.branch().name;
  const now = stateOf(cb.store.names(undefined, true));
  const items = cb.store.branches().map((name): BranchItem => {
    const ts = cb.store.causalLog(1, name)[0]?.ts;
    if (name === current) return { name, current: true, differs: 0, ...(ts ? { ts } : {}) };
    const other = stateOf(cb.store.names(name, true));
    let differs = 0;
    for (const k of new Set([...now.keys(), ...other.keys()])) {
      const [a, b] = [now.get(k), other.get(k)];
      if (!a || !b || a.size !== b.size || [...a].some((h) => !b.has(h))) differs++;
    }
    return { name, current: false, differs, ...(ts ? { ts } : {}) };
  });
  return [...items.filter((b) => b.current), ...items.filter((b) => !b.current)];
}

/**
 * What a history entry changed (from the entry before it on its branch).
 */
export function entryChanges(cb: Codebase, hash: string, viewUri: (hash: string) => string): NameChange[] {
  const c = cb.store.causal(hash);
  if (!c?.parents.length) return [];
  return namesChanged(cb, stateAt(cb, c.parents[0]!), stateAt(cb, hash), viewUri);
}

/**
 * A branch's latest history entries, newest first (this branch's, unless one is named), as `tcm history` lists them.
 */
export function historyList(cb: Codebase, limit = 50, branch?: string): HistoryItem[] {
  return cb.store
    .causalLog(limit + 1, branch)
    .filter((c) => c.parents.length)
    .slice(0, limit)
    .map((c, back) => ({ hash: c.hash, short: shortHash(c.hash), command: c.command, ts: c.ts, parents: c.parents, back }));
}

/**
 * What changed from one state of the names to another, name by name.
 */
export function namesChanged(cb: Codebase, before: NameState, after: NameState, viewUri: (hash: string) => string): NameChange[] {
  const d = diffNamespaces(before, after, (h) => cb.store.getDef(h)!.ir);
  const uri = (h: string) => {
    const rec = cb.store.getDef(h);
    return rec && rec.kind !== "file" ? { uri: viewUri(h) } : {};
  };
  const was = (h: string) => {
    const u = uri(h);
    return u.uri ? { oldUri: u.uri } : {};
  };
  const nameOf = (h: string) => cb.store.pathsOf(h)[0] ?? shortHash(h);
  return [
    ...d.edited.map((x): NameChange => ({ change: "edited", path: keyPath(x.path), old: x.old, hash: x.new, ...was(x.old), ...uri(x.new) })),
    ...d.propagated.map((x): NameChange => ({ change: "propagated", path: keyPath(x.path), old: x.old, hash: x.new, because: x.because.map(nameOf), ...was(x.old), ...uri(x.new) })),
    ...d.added.map((x): NameChange => ({ change: "added", path: keyPath(x.path), hash: x.hash, ...uri(x.hash) })),
    ...d.removed.map((x): NameChange => ({ change: "removed", path: keyPath(x.path), hash: x.hash, ...uri(x.hash) })),
    ...d.renamed.map((x): NameChange => ({ change: "renamed", path: keyPath(x.to), from: keyPath(x.from), hash: x.hash, ...uri(x.hash) })),
    ...d.aliased.map((x): NameChange => ({ change: "aliased", path: keyPath(x.path), hash: x.hash, existing: x.existing.map(keyPath), ...uri(x.hash) })),
    ...d.conflicted.map((x): NameChange => ({ change: "conflicted", path: keyPath(x.path), hashes: x.hashes })),
  ];
}

/**
 * The names as of a history entry.
 */
export const stateAt = (cb: Codebase, causal: string): NameState => stateOf(cb.store.namespaceRows(cb.store.causal(causal)!.namespace));

/**
 * What another branch has that this one doesn't, name by name: the changes from this branch to it.
 */
export function branchChanges(cb: Codebase, branch: string, viewUri: (hash: string) => string): NameChange[] {
  if (!cb.store.hasBranch(branch)) throw new Error(`no branch named '${branch}'`);
  return namesChanged(cb, stateOf(cb.store.names(undefined, true)), stateOf(cb.store.names(branch, true)), viewUri);
}
