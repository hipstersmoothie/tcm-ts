// Suites: a package's tests that run its command as a program. `tcm test` runs each against the codebase's own
// build of the command, as a program of its own, and runs it again only when code it ran changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { okIn, tcmIn, tempDir } from "./harness.ts";

/** A package's suites run its command, and run again only when code they ran changed. */
export const testSuitesRunAgainOnlyWhenCodeTheyRanChanged = () => {
  const dir = tempDir("suites");
  const ok = (...args: string[]) => okIn(dir, ...args);
  const scratch = (ns: string, text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace ${ns}\n${text}`);
  ok("init");
  scratch(
    "greeter",
    `export const greet = (name: string) => \`hello, \${name}\`;
export const shout = (s: string) => s.toUpperCase();
export const main = (...args: string[]) => console.log(greet(args[0] ?? "world"));
export const manifest = { name: "greeter", bin: { greet: "main" }, suites: { greet: ["e2e"] } };
`,
  );
  ok("add");
  // the test finds the command in GREET_BIN
  scratch(
    "greeter.e2e",
    `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
export const testGreets = () => {
  const r = spawnSync(process.execPath, [process.env.GREET_BIN!, "tcm"], { encoding: "utf8" });
  assert.equal(r.stdout, "hello, tcm\\n");
};
`,
  );
  ok("add");

  assert.match(ok("test"), /suites \(running greet\)\n {2}✓ greeter\.e2e\.testGreets[\s\S]*suites: 1 passed, 0 failed\n/);
  assert.match(ok("test"), /suites: 1 passed, 0 failed \(1 cached\)/);
  // (it's run as a program, not with the test definitions)
  assert.match(ok("test", "--definitions"), /no tests/);

  // shout isn't run by the test: changing it keeps the result
  scratch("greeter", `export const shout = (s: string) => s.toUpperCase() + "!";\n`);
  ok("update");
  assert.match(ok("test"), /\(1 cached\)/);

  // greet is, so changing it runs the test again
  scratch("greeter", `export const greet = (name: string) => \`hi, \${name}\`;\n`);
  ok("update");
  const failed = tcmIn(dir, "test");
  assert.equal(failed.status, 1);
  assert.match(failed.out, /✗ greeter\.e2e\.testGreets[\s\S]*AssertionError[\s\S]*suites: 0 passed, 1 failed\n/);

  // changed back, it passes again
  scratch("greeter", `export const greet = (name: string) => \`hello, \${name}\`;\n`);
  ok("update");
  assert.match(ok("test"), /suites: 1 passed, 0 failed\n/);
};
