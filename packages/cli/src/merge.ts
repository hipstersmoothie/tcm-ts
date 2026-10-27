import type { NameRow } from "@ucm/store";
import { shortHash } from "@ucm/core";
import type { Codebase } from "./codebase.ts";
import { diffNamespaces, keyPath, printDiff, rewind, stateOf, type NameState } from "./diff.ts";
import { bold, dim, green, red, yellow } from "./style.ts";

const same = (a: Set<string> | undefined, b: Set<string> | undefined) =>
  (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every((h) => b?.has(h));

export interface MergeResult {
  merged: NameState;
  /** names both sides changed differently: they now hold both definitions */
  conflicts: string[];
  /** names one side deleted while the other changed them: the change is kept */
  keptOverDelete: string[];
  /** old → new for every name exactly one side updated, so the other side's code can follow */
  patches: Map<string, string>;
}

/**
 * Three-way merge of namespaces. A name changed on one side takes that side's value; changed on both sides
 * to the same thing, it agrees; changed differently, it becomes conflicted (several hashes on one name).
 */
export function mergeStates(
  base: NameState,
  ours: NameState,
  theirs: NameState,
  propagated: { ours: Set<string>; theirs: Set<string> } = { ours: new Set(), theirs: new Set() },
): MergeResult {
  const merged: NameState = new Map();
  const conflicts: string[] = [];
  const keptOverDelete: string[] = [];
  const patches = new Map<string, string>();
  const patch = (from: Set<string> | undefined, to: Set<string> | undefined) => {
    if (from?.size === 1 && to?.size === 1) patches.set([...from][0]!, [...to][0]!);
  };
  for (const path of [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort()) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let r: Set<string> | undefined;
    if (same(o, t)) r = o;
    else if (same(o, b)) {
      r = t;
      patch(b, t);
    } else if (same(t, b)) {
      r = o;
      patch(b, o);
    } else if (o?.size && t?.size && (propagated.ours.has(path) || propagated.theirs.has(path))) {
      // A side whose "change" was only re-hashing after a dependency moved didn't edit this definition.
      // Keep the edit (or ours, if neither edited it); propagation then re-derives it against the other side's
      // updates, and the patch points the other side's dependents at it.
      const takeTheirs = propagated.ours.has(path) && !propagated.theirs.has(path);
      r = takeTheirs ? t : o;
      if (takeTheirs) patch(o, t);
      else patch(t, o);
    } else if (!o?.size || !t?.size) {
      // deleted on one side, changed on the other: deleting loses information, changing doesn't
      r = o?.size ? o : t;
      keptOverDelete.push(path);
    } else {
      r = new Set([...o, ...t]);
      conflicts.push(path);
    }
    if (r?.size) merged.set(path, new Set(r));
  }
  return { merged, conflicts, keptOverDelete, patches };
}

export const mergeKey = (ours: string, theirs: string) => `merge.${ours}.${theirs}`;

/** Remember that `ours` now includes everything `theirs` has, so the next merge starts from here. */
export function recordMergeBase(cb: Codebase, ours: string, theirs: string) {
  cb.store.setSetting(mergeKey(ours, theirs), String(cb.store.branchLogHead(theirs)));
}

/**
 * Merge another branch into the current one. The base is `theirs` as it was when it was last merged into
 * (or synced with, or forked from) this branch, recovered by rewinding its name history.
 */
export function mergeBranch(cb: Codebase, theirs: string, command = `merge ${theirs}`): MergeResult {
  const ours = cb.store.branch().name;
  if (theirs === ours) throw new Error("can't merge a branch into itself");
  if (!cb.store.hasBranch(theirs)) throw new Error(`no branch named '${theirs}'`);
  const since = Number(cb.store.getSetting(mergeKey(ours, theirs)) ?? 0);
  const theirsNow = stateOf(cb.store.names(theirs));
  const base = rewind(theirsNow, cb.store.history(Number.MAX_SAFE_INTEGER, since, theirs));
  const before = stateOf(cb.store.names());
  const irOf = (h: string) => cb.store.getDef(h)!.ir;
  const propagated = {
    ours: new Set(diffNamespaces(base, before, irOf).propagated.map((c) => c.path)),
    theirs: new Set(diffNamespaces(base, theirsNow, irOf).propagated.map((c) => c.path)),
  };
  const result = mergeStates(base, before, theirsNow, propagated);

  const rows: NameRow[] = [...result.merged].flatMap(([key, hs]) => [...hs].map((hash) => ({ path: keyPath(key), hash, kind: cb.store.getDef(hash)!.kind })));
  cb.store.setBranchNames(ours, rows, command);
  for (const [o, n] of result.patches) cb.store.addPatch(o, n);
  recordMergeBase(cb, ours, theirs);

  // the other side's code may still reference definitions this merge replaced: re-derive it
  const { updated, failed } = result.patches.size ? cb.propagate(new Map(result.patches), new Set()) : { updated: [], failed: [] };
  cb.refreshShim();

  const after = stateOf(cb.store.names());
  printDiff(cb, diffNamespaces(before, after, (h) => cb.store.getDef(h)!.ir), before, after, `merged ${theirs} into ${ours}`);
  if (updated.length) console.log(dim(`\n  re-derived against the merged definitions: ${updated.join(", ")}`));
  for (const p of result.keptOverDelete) console.log(`${yellow("  kept")} ${bold(p)} ${dim("(deleted on one side, changed on the other)")}`);
  for (const p of result.conflicts) {
    const hs = [...(after.get(p) ?? [])];
    if (hs.length < 2) continue;
    console.log(`${red("  conflict")} ${bold(p)}: ${hs.map((h) => shortHash(h)).join(" vs ")}  ${dim(`ucm resolve ${p} ${shortHash(hs[0]!)}`)}`);
  }
  if (failed.length) console.log(red(`  ${failed.length} definition(s) no longer typecheck after the merge; see \`ucm todo\``));
  if (!result.conflicts.length && !failed.length) console.log(green("\n  merged cleanly"));
  return result;
}
