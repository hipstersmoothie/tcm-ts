import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashIR, type DefRecord, type IR } from "@tcm/core";
import { fileProblem } from "../src/codebase.ts";

/** A file definition as another codebase would send it. */
const file = (ir: IR[], sourceText: string, spans: DefRecord["spans"] = []): DefRecord => {
  const hash = hashIR(ir as IR);
  return { hash, kind: "file", componentHash: hash, componentIndex: 0, componentSize: 1, ir: JSON.stringify(ir), sourceText, spans, reservedNames: [], initKind: "hoisted", nameHint: "page", nominal: false, deps: [], signature: "md" };
};

/** A file from another codebase is taken only as its IR says it is: its text, its links, its bytes. */
export const testReceivedFilesAreChecked = () => {
  const target = "a".repeat(52);
  const page = file(["File", "md", "See ", ["Ref", target], "."], "See {@link x}.", [{ start: 4, end: 13, pos: "value", hash: target }]);
  assert.equal(fileProblem(page), undefined);
  assert.match(fileProblem({ ...page, sourceText: "Not {@link x}." })!, /text that isn't its own/);
  assert.match(fileProblem({ ...page, spans: [{ start: 4, end: 13, pos: "value", hash: "b".repeat(52) }] })!, /links that aren't its own/);
  assert.match(fileProblem({ ...page, hash: "c".repeat(52) })!, /doesn't hash/);
  const content = Buffer.from([0x89, 0x50, 0, 0xff]);
  const image = file(["File", "png", ["Bytes", createHash("sha256").update(content).digest("hex")]], content.toString("base64"));
  assert.equal(fileProblem(image), undefined);
  assert.match(fileProblem({ ...image, sourceText: Buffer.from([1, 2]).toString("base64") })!, /bytes that aren't its own/);
};
