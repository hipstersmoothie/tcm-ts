// Definitions that refer to each other are hashed as one, so they're updated together: changing some saves the
// rest with them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { okIn, tcmIn, tempDir } from "./harness.ts";

/** A cycle is updated whole: changing one member saves the rest with it, so none uses an old one. */
export const testCycleUpdatedWhole = () => {
  const dir = tempDir("cycles");
  const ok = (...args: string[]) => okIn(dir, ...args);
  ok("init");
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nexport function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }\nexport function isOdd(n: number): boolean { const unused = 1; return n === 0 ? false : isEven(n - 1); }\n`);
  assert.match(ok("add"), /'unused' is declared but never used/);

  // a file changing one member, using the other from the codebase: the other is saved with it, as it is
  fs.writeFileSync(path.join(dir, "partial.ts"), `// tcm: namespace lib\nimport { isOdd } from "#codebase/lib";\nexport function isEven(n: number): boolean { console.log("even", n); return n === 0 ? true : isOdd(n - 1); }\n`);
  const partial = ok("update", "partial.ts");
  assert.match(partial, /with lib\.isOdd: in a cycle with what changed, so saved with it, as it is/);
  assert.match(partial, /~ update +lib\.isEven[\s\S]*~ update +lib\.isOdd/);
  // (only what changed is linted: isOdd is re-hashed with isEven, but its code is as it was)
  assert.doesNotMatch(partial, /unused/);
  assert.equal(ok("run", "lib.isOdd", "3"), "even 2\neven 0\ntrue\n", "isOdd runs the new isEven");

  // edit writes only what's asked for, and says what it's in a cycle with (scratch.ts holds the versions just
  // replaced, which aren't saved as they are, so it takes --force)
  assert.match(tcmIn(dir, "edit", "lib.isEven").out, /scratch\.ts is not empty/);
  assert.match(ok("edit", "--force", "lib.isEven"), /in a cycle with lib\.isOdd: saving it saves that too, as it is/);
  const scratch = path.join(dir, "scratch.ts");
  assert.doesNotMatch(fs.readFileSync(scratch, "utf8"), /function isOdd/);
  fs.writeFileSync(scratch, fs.readFileSync(scratch, "utf8").replace(`console.log("even", n);`, `console.log("even:", n);`));
  assert.match(ok("check"), /with lib\.isOdd: in a cycle with what changed[\s\S]*~ update +lib\.isOdd/);
  assert.match(ok("update"), /~ update +lib\.isEven[\s\S]*~ update +lib\.isOdd/);
  assert.equal(ok("run", "lib.isOdd", "1"), "even: 0\ntrue\n");
};

/**
 * One member of a cycle with a class is edited alone, though alone it wouldn't check: the class has private state.
 */
export const testClassEditedAlone = () => {
  const dir = tempDir("cycles");
  const ok = (...args: string[]) => okIn(dir, ...args);
  ok("init");
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace shop\nexport class Counter {\n  #n = 0;\n  bump(): number {\n    this.#n++;\n    report(this);\n    return this.#n;\n  }\n  get count(): number {\n    return this.#n;\n  }\n}\nexport function report(c: Counter): void {\n  console.log("at", c.count);\n}\n`);
  ok("add");
  ok("edit", "--force", "shop.Counter");
  const file = path.join(dir, "scratch.ts");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /function report/);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("this.#n++;", "this.#n += 2;"));
  assert.match(ok("update"), /with shop\.report[\s\S]*~ update +shop\.Counter[\s\S]*~ update +shop\.report/);
  fs.writeFileSync(file, `import { Counter } from "#codebase/shop";\nexport const main = () => new Counter().bump();\n`);
  ok("add");
  assert.equal(ok("run", "main"), "at 2\n2\n");
}
