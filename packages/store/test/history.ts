import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { causalHash, EMPTY_NAMESPACE, ROOT_CAUSAL, Store } from "../src/index.ts";

// History hashes are shared between codebases (sync compares them), so like definition hashes they're pinned:
// change how a namespace or causal is hashed only on purpose.

const open = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tcm store ")), "codebase.sqlite"));
const a = "a".repeat(52);
const b = "b".repeat(52);

/** Namespace and causal hashes are pinned. */
export const testNamespaceAndCausalHashesArePinned = () => {
  const s = open();
  assert.equal(EMPTY_NAMESPACE, "a7d65ecy52g7uixil4g4q7neogcjcfdiaq7grajdkbpfaun33rha");
  assert.equal(ROOT_CAUSAL, "dc4c7qxqiu7x2ujh2nqrvt4wcd4tpb7ox53hcehj2tobqdouoglq");
  const ns = s.namespaceOf([
    { path: "lib.square", hash: a },
    { path: "lib.util.Point", hash: b },
    { path: "lib.util.Point", hash: a },
    { path: "main", hash: b },
  ]);
  assert.equal(ns, "tpg34pl2raqwlq5gkg6xx7qqrm35xouibjsqycioi6rb3v7uevfa");
  assert.equal(causalHash(ns, [ROOT_CAUSAL]), "mjb26ej3yt4v77nqypef7sfsz2vzjxcu5dbhyoks2y4w4cqwulaa");
  // order doesn't matter: of names, or of a merge's parents
  assert.equal(s.namespaceOf([{ path: "main", hash: b }, { path: "lib.util.Point", hash: a }, { path: "lib.square", hash: a }, { path: "lib.util.Point", hash: b }]), ns);
  assert.equal(causalHash(ns, [a, b]), causalHash(ns, [b, a]));
  // and a namespace reads back as the names it was made from
  assert.deepEqual(
    s.namespaceRows(ns).map((r) => `${r.path} ${r.hash[0]}`),
    ["lib.square a", "lib.util.Point a", "lib.util.Point b", "main b"],
  );
};

/** One causal per batch, however many transactions; merge parents and ancestry. */
export const testOneCausalPerBatch = () => {
  const s = open();
  s.transaction(() => s.addName("x", a, "term", "add"));
  s.transaction(() => s.addName("y", b, "term", "add"));
  const one = s.causal(s.head())!;
  assert.deepEqual(one.parents, [ROOT_CAUSAL], "both transactions are this batch's one entry");
  assert.equal(s.causalLog().length, 2);

  s.endBatch();
  s.createBranch("side");
  s.switchBranch("side");
  s.addName("z", a, "term", "add z");
  const side = s.head();
  s.switchBranch("main");
  s.endBatch();
  s.removeName("x", a, "rm x");
  const main = s.head();
  assert.equal(s.mergeBase(main, side), one.hash);
  assert.ok(s.isAncestor(one.hash, side) && !s.isAncestor(side, main));

  s.endBatch();
  s.transaction(() => {
    s.addParent(side);
    s.addName("z", a, "term", "merge side");
  });
  const merged = s.causal(s.head())!;
  assert.deepEqual(merged.parents, [main, side], "this branch's head first");
  assert.ok(s.isAncestor(side, merged.hash));
  assert.equal(s.mergeBase(merged.hash, side), side);
};
