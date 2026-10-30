// History as Unison keeps it: each change is a causal (a namespace state and the causals it came from), hashed
// the same in every codebase. Codebases share it by sending what the other lacks, merges start from the best
// common ancestor and record both parents, and a push only ever moves a remote forward.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tcmIn, tempDir } from "./harness.ts";

/** A new directory `name` in `root`, and ways to run tcm in it. */
function codebase(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const tcm = (...args: string[]) => {
    const r = tcmIn(dir, ...args);
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} (in ${name}) exited ${r.status}:\n${r.out}`);
    return r.out;
  };
  const write = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), text);
  /** History entry hashes, newest first. */
  const entries = () => [...tcm("history", "100").matchAll(/^#([a-z2-7]{8}) /gm)].map((m) => m[1]!);
  return { dir, tcm, write, entries };
}

/** History is the same in every codebase that has it. */
export const testHistorySameInEveryCodebase = () => {
  const root = tempDir("history");
  const a = codebase(root, "a");
  const b = codebase(root, "b");
  a.tcm("init");
  a.write(`export const one = 1;\n`);
  a.tcm("add");
  a.write(`export const two = 2;\n`);
  a.tcm("add");
  b.tcm("init");
  b.tcm("remote", "add", "origin", a.dir);
  b.tcm("pull");
  assert.equal(b.entries().length, 2);
  assert.deepEqual(b.entries(), a.entries(), "pulled history has the same hashes");

  // the same change from the same point is the same causal (what made it, and when, aren't hashed)
  a.tcm("branch", "x");
  a.write(`export const three = 3;\n`);
  a.tcm("add");
  a.tcm("switch", "x");
  a.tcm("add");
  const onX = a.entries()[0];
  a.tcm("switch", "main");
  assert.equal(a.entries()[0], onX);
};

/** Merges follow history: fast-forwards, recorded merges, and remotes that move forward only. */
export const testMergesFollowHistory = () => {
  const root = tempDir("history");
  const a = codebase(root, "c");
  a.tcm("init");
  a.write(`export const base = 1;\n`);
  a.tcm("add");
  a.tcm("branch", "feature");
  a.tcm("switch", "feature");
  a.write(`export const feature = 2;\n`);
  a.tcm("add");
  a.tcm("switch", "main");
  // main hasn't moved: merging is moving it to feature's head, with no merge entry
  assert.match(a.tcm("merge", "feature"), /fast-forwarded main to feature/);
  assert.equal(a.entries()[0], (a.tcm("switch", "feature"), a.entries()[0]));
  a.tcm("switch", "main");

  // both moved: a merge entry with both heads as parents, and merging again brings nothing
  a.write(`export const onMain = 3;\n`);
  a.tcm("add");
  a.tcm("switch", "feature");
  a.write(`export const onFeature = 4;\n`);
  a.tcm("add");
  const featureHead = a.entries()[0]!;
  a.tcm("switch", "main");
  assert.match(a.tcm("merge", "feature"), /merged cleanly/);
  assert.match(a.tcm("history", "1"), new RegExp(`merge feature  merged #${featureHead}`));
  assert.match(a.tcm("merge", "feature"), /already has everything in feature: no changes/);

  // another codebase changes too; pulling merges (from the common ancestor), and pushing that back is a
  // fast-forward for the first, which then pulls nothing new to merge
  const b = codebase(root, "d");
  b.tcm("init");
  b.tcm("remote", "add", "origin", a.dir);
  b.tcm("pull");
  b.write(`export const fromB = 5;\n`);
  b.tcm("add");
  a.write(`export const fromA = 6;\n`);
  a.tcm("add");
  assert.throws(() => b.tcm("push"), /has changes you don't have/);
  assert.match(b.tcm("pull"), /merged origin\/main into main[\s\S]*\+ fromA[\s\S]*merged cleanly/);
  assert.match(b.tcm("push"), /pushed origin\/main/);
  assert.deepEqual(a.entries(), b.entries(), "the push brought b's history, merge included");
  assert.match(a.tcm("ls"), /fromB/);
};

/** Entries by hash or by distance; reset adds an entry rather than rewriting. */
export const testEntriesByHashOrDistance = () => {
  const root = tempDir("history");
  const a = codebase(root, "e");
  a.tcm("init");
  a.write(`export const v = 1;\n`);
  a.tcm("add");
  a.write(`export const v = 2;\n`);
  a.tcm("update");
  assert.match(a.tcm("history"), /^#\w{8} +0 .* update scratch\.ts\n {4}v +#\w{8} → #\w{8}\n#\w{8} +1 .* add scratch\.ts\n {4}v +\+ #\w{8}/);
  assert.match(a.tcm("diff", "1"), /changes since #\w{8}[\s\S]*edited\s+~ v/);
  const first = a.entries()[1]!;
  // by hash, # or not
  assert.match(a.tcm("diff", first), /changes since #\w{8}/);
  assert.match(a.tcm("reset", `#${first}`), /names as of #\w{8} \(1 added, 1 removed\)/);
  assert.equal(a.tcm("run", "v").trim(), "1");
  assert.equal(a.entries().length, 3, "the reset is an entry of its own");
  assert.match(a.tcm("history", "1"), /reset #\w{8}/);
  assert.throws(() => a.tcm("reset", "9"), /isn't 9 entries long/);
};
