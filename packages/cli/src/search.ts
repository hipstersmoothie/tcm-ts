// Searching the codebase by type, as Unison does: `tcm find ':(xs: T[]) => T'`, and the editor's "Find by type".
import path from "node:path";
import { matchShapes, queryShape } from "@tcm/core";
import type { Codebase } from "./codebase.ts";

/** The most distant match worth listing: a few reorderings, specializations or awaits away. */
const MAX_MATCH_COST = 6;

export interface TypeHit {
  path: string;
  hash: string;
  signature: string;
  /** 0 for the same type up to renaming */
  cost: number;
  notes: string[];
}

/**
 * Terms whose type has the query's shape. Codebase types in the query are found by name; names that aren't types
 * become type variables. Exact matches (up to renaming) come first, then ones with arguments reordered, a Promise
 * result, or a more general or more specific type.
 */
export function searchByType(cb: Codebase, text: string): { variables: string[]; hits: TypeHit[] } {
  if (!text.trim()) throw new Error("find :<type>, e.g. tcm find ':(xs: T[]) => T'");
  const names = cb.store.names();
  const types = names.filter((n) => n.kind !== "term");
  const resolve = (name: string) => {
    const hits = types.filter((n) => n.path === name || n.path.endsWith(`.${name}`));
    const exact = hits.filter((n) => n.path === name);
    const paths = [...new Set((exact.length ? exact : hits).map((n) => n.path))];
    if (paths.length > 1) throw new Error(`'${name}' in the query could be ${paths.join(", ")}; write the one you mean`);
    if (!paths.length) return undefined;
    const segs = paths[0]!.split(".");
    return { module: ["#codebase", ...segs.slice(0, -1)].join("/"), export: segs.at(-1)! };
  };
  cb.refreshShim();
  const q = queryShape(text, path.join(cb.lay.tcmDir, "query.ts"), cb.compilerOptions(), resolve);
  const terms = names.filter((n) => n.kind === "term");
  const hits = terms
    .map((n) => {
      const def = cb.store.getDef(n.hash)!;
      const m = def.shape ? matchShapes(q.shape, def.shape) : undefined;
      return m && m.cost <= MAX_MATCH_COST ? { path: n.path, hash: n.hash, signature: def.signature, cost: m.cost, notes: m.notes } : undefined;
    })
    .filter((h): h is TypeHit => !!h)
    .sort((a, b) => a.cost - b.cost || (a.path < b.path ? -1 : 1));
  return { variables: q.variables, hits };
}
