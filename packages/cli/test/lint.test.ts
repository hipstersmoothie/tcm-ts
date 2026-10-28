import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Linting with nothing set up: tcm provides oxlint, infers its plugins from the code, caches findings by hash,
// and takes its configuration (and JS plugins, by import) from a `lint.config` definition. Uses the npm registry.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm lint "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
};
function tcm(...args: string[]): string {
  const r = run(...args);
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
}
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

test("lint: oxlint with nothing to set up, plugins from what the code uses, findings cached by hash", () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  write("ui.tsx", `// tcm: namespace ui\nexport function Pic({ src }: { src: string }) {\n  return <img src={src} />;\n}\n\nexport const half = (n: number): number => {\n  debugger;\n  return n / 2;\n};\n`);
  // warnings show while saving, and don't stop it
  const added = tcm("add", "ui.tsx");
  assert.match(added, /3:10 {2}warning {2}Missing `alt` attribute\. jsx-a11y\(alt-text\)/, "JSX brings the accessibility rules");
  assert.match(added, /7:3 {2}warning {2}`debugger` statement is not allowed eslint\(no-debugger\)/);
  assert.match(added, /\+ new {7}ui\.half/);

  const lint = tcm("lint");
  assert.match(lint, /ui\.Pic #\w+\n {2}2:10 {2}warning {2}Missing `alt` attribute/, "positions in the definition as tcm view shows it");
  assert.match(lint, /no errors, 2 warning\(s\) in 2 definition\(s\)$/m);
  assert.match(tcm("lint"), /\(2 cached\)/, "unchanged definitions aren't linted again");
  assert.match(tcm("packages"), /oxlint\s+1\s+1\.\d+\.\d+/, "the linter is pinned like any package");
});

test("lint: a lint.config definition sets rules, and the packages it imports are JS plugins", () => {
  write("cfg.ts", `// tcm: namespace lint\nimport noOnlyTests from "eslint-plugin-no-only-tests";\n\nexport const config = {\n  jsPlugins: [noOnlyTests],\n  rules: { "no-debugger": "error", "no-only-tests/no-only-tests": "error" },\n};\n`);
  assert.match(tcm("add", "cfg.ts"), /eslint-plugin-no-only-tests has no types .*typed as any/, "an untyped plugin is fine, with a warning");
  // the configuration changed, so everything is linted against it
  const r = run("lint");
  assert.equal(r.status, 1);
  assert.match(r.out, /ui\.half #\w+\n {2}2:3 {2}error {2}`debugger` statement is not allowed/);
  assert.match(r.out, /1 error\(s\), 1 warning\(s\) in 3 definition\(s\)/);

  // an error stops a save; the plugin's rule works like a built-in one
  write("only.ts", `// tcm: namespace ui\nexport const testOnly = () => {\n  const describe = { only: (_name: string, fn: () => void) => fn() };\n  describe.only("x", () => {});\n};\n`);
  const blocked = run("add", "only.ts");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.out, /4:12 {2}error {2}describe\.only not permitted no-only-tests\(no-only-tests\)/);
  assert.match(blocked.out, /only\.ts has lint errors; nothing was saved/);
  assert.match(tcm("ls", "ui"), /^(?![\s\S]*testOnly)/, "nothing was saved");
});
