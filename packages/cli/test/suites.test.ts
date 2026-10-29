import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Suites: test files that run a package's command as a program, run by `tcm test` against the codebase's own
// build of it, and cached by the code they ran.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm suites ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const tcm = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
};
const ok = (...args: string[]) => {
  const r = tcm(...args);
  assert.equal(r.status, 0, r.out);
  return r.out;
};
const scratch = (text: string) => fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace greeter\n${text}`);

test("a package's suites run its command, and are run again only when code they ran changed", () => {
  ok("init");
  scratch(
    `export const greet = (name: string) => \`hello, \${name}\`;
export const shout = (s: string) => s.toUpperCase();
export const main = (...args: string[]) => console.log(greet(args[0] ?? "world"));
export const manifest = { name: "greeter", bin: { greet: "main" }, suites: { greet: ["suites/*.test.ts"] } };
`,
  );
  ok("add");
  fs.mkdirSync(path.join(dir, "suites"));
  // the suite finds the command in GREET_BIN
  fs.writeFileSync(
    path.join(dir, "suites", "greet.test.ts"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("greets", () => {
  const r = spawnSync(process.execPath, [process.env.GREET_BIN!, "tcm"], { encoding: "utf8" });
  assert.equal(r.stdout, "hello, tcm\\n");
});
`,
  );

  assert.match(ok("test"), /suites \(running greet\)\n {2}✓ suites\/greet\.test\.ts \(1 test\)[\s\S]*suites: 1 passed, 0 failed\n/);
  assert.match(ok("test"), /suites: 1 passed, 0 failed \(1 cached\)/);
  assert.doesNotMatch(ok("test", "--definitions"), /suites/);

  // shout isn't run by the suite: changing it keeps the result
  scratch(`export const shout = (s: string) => s.toUpperCase() + "!";\n`);
  ok("update");
  assert.match(ok("test"), /\(1 cached\)/);

  // greet is, so changing it runs the suite again
  scratch(`export const greet = (name: string) => \`hi, \${name}\`;\n`);
  ok("update");
  const failed = tcm("test");
  assert.equal(failed.status, 1);
  assert.match(failed.out, /✗ suites\/greet\.test\.ts \(1 test\)[\s\S]*greets[\s\S]*suites: 0 passed, 1 failed\n/);

  // and so does changing the suite
  fs.appendFileSync(path.join(dir, "suites", "greet.test.ts"), "// hi, now\n");
  scratch(`export const greet = (name: string) => \`hello, \${name}\`;\n`);
  ok("update");
  assert.match(ok("test"), /suites: 1 passed, 0 failed\n/);
});
