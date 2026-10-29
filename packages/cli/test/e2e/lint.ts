// Linting with nothing set up: tcm provides oxlint, infers its plugins from the code, caches findings by hash,
// and takes its configuration (and JS plugins, by import) from a `lint.config` definition. Uses the npm registry.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { okIn, tcmIn, tempDir } from "./harness.ts";

/** A new codebase, with ui.tsx (a JSX component and a function with a warning each) written to it. */
function setUp() {
  const dir = tempDir("lint");
  const run = (...args: string[]) => tcmIn(dir, ...args);
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  write("ui.tsx", `// tcm: namespace ui\nexport function Pic({ src }: { src: string }) {\n  return <img src={src} />;\n}\n\nexport const half = (n: number): number => {\n  debugger;\n  return n / 2;\n};\n`);
  return { dir, run, tcm, write };
}

/** Lint: oxlint with nothing to set up, plugins from what the code uses, findings cached by hash. */
export const testLintWithNothingToSetUp = () => {
  const { tcm } = setUp();
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
};

/** Lint: a lint.config definition sets rules, and the packages it imports are JS plugins. */
export const testLintConfigAndJsPlugins = () => {
  const { run, tcm, write } = setUp();
  tcm("add", "ui.tsx");
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
};
