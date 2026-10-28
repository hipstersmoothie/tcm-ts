import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/docs-site.ts", import.meta.url));

test("the docs site builds, every link and anchor resolves", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ucm docs site "));
  const r = spawnSync(process.execPath, [SCRIPT, out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const index = fs.readFileSync(path.join(out, "index.html"), "utf8");
  // the menu lists every page in docs/README.md's order, numbered, under its section, by its link's text
  assert.match(index, /<span>\[0\] index<\/span>/);
  assert.match(index, /<li class="section">start<\/li>\n<li><a href="introduction.html">\[1\] introduction<\/a><\/li>/);
  assert.match(index, /<a href="getting-started.html">\[2\] install<\/a>/);
  const data = fs.readFileSync(path.join(out, "data.html"), "utf8");
  assert.match(data, /<h1 id="data-typed-tables">\d+\. Data: typed tables<\/h1>/);
  assert.match(data, /<h2 id="transactions">\d+\.\d+ Transactions<\/h2>/);
  assert.ok(fs.existsSync(path.join(out, "style.css")));
});
