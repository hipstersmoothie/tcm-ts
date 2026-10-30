import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { okIn, repoPath, tempDir } from "./harness.ts";

function hashOf(dir: string, name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}
function componentOf(dir: string, name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT component_hash AS c FROM definitions WHERE hash = ?").get(hashOf(dir, name)) as { c: string }).c;
  } finally {
    db.close();
  }
}

/** A library written the way real ones are: bundler-style imports and the TypeScript features Node can't strip. */
function writeLibrary(lib: string) {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(lib, file)), { recursive: true });
    fs.writeFileSync(path.join(lib, file), text);
  };
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "node", declaration: true, isolatedDeclarations: true, noEmit: true, lib: ["ESNext"], target: "ES2022" },
    }),
  );
  write(
    "src/symbols.ts",
    `export const tag = Symbol("tag");
// two ambient brands with identical text are still two distinct symbols
export declare const BrandA: unique symbol;
export declare const BrandB: unique symbol;
export type A = string & { [BrandA]: true };
export type B = string & { [BrandB]: true };
export type infer<T> = T extends { value: infer V } ? V : never;
`,
  );
  write(
    "src/shapes.ts",
    `import * as symbols from "./symbols";

export enum Kind { Circle = "circle", Square = "square" }

export namespace Geometry {
  export const tau = 2 * Math.PI;
}

export class Shape {
  constructor(public readonly kind: Kind, private size: number) {}
  area(): number {
    return this.kind === Kind.Circle ? (Geometry.tau / 2) * this.size ** 2 : this.size ** 2;
  }
  get [symbols.tag](): string {
    return this.kind;
  }
}

// a type named like a type keyword, through a namespace import, in a type position
export function unwrap<T extends { value: unknown }>(x: T): symbols.infer<T> {
  return x.value as symbols.infer<T>;
}
`,
  );
  write(
    "src/config.ts",
    `// module state: a lazily created cell, written by one function and read by another
let config: { verbose: boolean } | undefined;
let calls = 0;

export function setConfig(c: { verbose: boolean }): void {
  config = c;
  calls++;
}
export function getConfig(): { verbose: boolean } {
  return config ?? { verbose: false };
}
export const callCount = (): number => calls;

// @ts-expect-error the implementation is deliberately looser than this overload
// (the explanation continues on a second line)
export function pick(x: number): string;
export function pick(x: string): string;
export function pick(x: string | boolean): string {
  return String(x);
}
`,
  );
  write("src/index.ts", `export * from "./shapes";\nexport * from "./config";\n`);
  // test helpers that need a dev dependency nobody installed: excluded
  write("src/testing/helpers.ts", `import { expect } from "vitest";\nexport const ok = () => expect(1).toBe(1);\n`);
}

/** import a library that uses enums, namespaces, parameter properties, namespace imports, module state and ts directives */
export const testImportLibrary = () => {
  const dir = tempDir("import");
  const lib = tempDir("import lib");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  tcm("init");
  writeLibrary(lib);
  const imported = tcm("import", path.join(lib, "src"), "--into", "lib", "--exclude", "testing");
  assert.match(imported, /\+ new/);
  assert.doesNotMatch(imported, /warning/, "module resolution and emit options are tcm's business in import mode");

  // ambient unique symbols with the same text stay distinct
  assert.notEqual(hashOf(dir, "lib.symbols.BrandA"), hashOf(dir, "lib.symbols.BrandB"));
  // a `let` and the function assigning it share a module, so the assignment works
  assert.equal(componentOf(dir, "lib.config.setConfig"), componentOf(dir, "lib.config.config"));
  assert.notEqual(componentOf(dir, "lib.config.getConfig"), componentOf(dir, "lib.config.config"), "readers just import it");

  assert.match(tcm("verify"), /verified \d+ definitions: rendering and re-hashing is the identity/);

  fs.writeFileSync(
    path.join(dir, "scratch.ts"),
    `// tcm: namespace app
import { Shape, Kind, unwrap } from "#codebase/lib/shapes";
import { setConfig, getConfig, callCount, pick } from "#codebase/lib/config";

export function main() {
  const s = new Shape(Kind.Square, 3);
  setConfig({ verbose: true });
  console.log(s.area(), s.kind, unwrap({ value: 42 }) + 1, getConfig().verbose, callCount(), pick("p"));
}
`,
  );
  tcm("add");
  assert.match(tcm("run", "app.main"), /9 square 43 true 1 p/);
};

/** a project's own @types are found from the project, wherever tcm runs */
export const testProjectTypesFound = () => {
  const dir = tempDir("import");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  // `types: ["node"]` with @types/node installed in the project (here, linked to the one tcm's tests use)
  const project = tempDir("import types");
  fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: ["node"] } }));
  const types = fs.realpathSync(repoPath("node_modules/@types/node"));
  fs.mkdirSync(path.join(project, "node_modules", "@types"), { recursive: true });
  fs.symlinkSync(types, path.join(project, "node_modules", "@types", "node"), "dir");
  fs.writeFileSync(path.join(project, "platform.ts"), `export const platform = (): string => process.platform;\n`);
  tcm("init");
  assert.match(tcm("import", project, "--into", "host"), /\+ new/);
};

/** --tests imports tests written as definitions; tcm test runs them, cached by hash */
export const testImportTestsCachedByHash = () => {
  const dir = tempDir("import");
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const project = tempDir("import tests");
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  };
  put("package.json", JSON.stringify({ type: "module" }));
  put("src/math.ts", `export const double = (x: number): number => x * 2;\nexport const half = (x: number): number => x / 2;\n`);
  // a helper next to the tests is a plain definition; only `test…` names are tests
  put("test/math.ts", `import assert from "node:assert/strict";\nimport { double, half } from "../src/math.ts";\nexport const sample = 21;\nexport const testDouble = () => assert.equal(double(sample), 42);\nexport const testHalf = () => assert.equal(half(42), sample);\n`);
  // a framework's test file (top-level test() calls) stays skipped
  put("test/math.test.ts", `import { test } from "node:test";\ntest("x", () => {});\n`);
  tcm("init");
  assert.doesNotMatch(tcm("import", project, "--into", "calc"), /testDouble/, "without --tests, tests stay out");
  assert.match(tcm("import", project, "--into", "calc", "--tests", "--update", "--verbose"), /calc\.test\.math\.testDouble/);
  assert.match(tcm("test", "calc"), /2 passed, 0 failed\n/);
  assert.match(tcm("test", "calc"), /2 passed, 0 failed \(2 cached\)/);
  // a change reaches the tests that use it, and only those
  put("src/math.ts", `export const double = (x: number): number => x + x;\nexport const half = (x: number): number => x / 2;\n`);
  tcm("import", project, "--into", "calc", "--tests", "--update");
  assert.match(tcm("test", "calc"), /2 passed, 0 failed \(1 cached\)/);
};
