import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm import "));
const lib = fs.mkdtempSync(path.join(os.tmpdir(), "tcm import lib "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

function tcm(...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${out}`);
  return out;
}
function hashOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}
function componentOf(name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT component_hash AS c FROM definitions WHERE hash = ?").get(hashOf(name)) as { c: string }).c;
  } finally {
    db.close();
  }
}
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(lib, file)), { recursive: true });
  fs.writeFileSync(path.join(lib, file), text);
};

/** A library written the way real ones are: bundler-style imports and the TypeScript features Node can't strip. */
function writeLibrary() {
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

test("import a library that uses enums, namespaces, parameter properties, namespace imports, module state and ts directives", () => {
  tcm("init");
  writeLibrary();
  const imported = tcm("import", path.join(lib, "src"), "--into", "lib", "--exclude", "testing");
  assert.match(imported, /\+ new/);
  assert.doesNotMatch(imported, /warning/, "module resolution and emit options are tcm's business in import mode");

  // ambient unique symbols with the same text stay distinct
  assert.notEqual(hashOf("lib.symbols.BrandA"), hashOf("lib.symbols.BrandB"));
  // a `let` and the function assigning it share a module, so the assignment works
  assert.equal(componentOf("lib.config.setConfig"), componentOf("lib.config.config"));
  assert.notEqual(componentOf("lib.config.getConfig"), componentOf("lib.config.config"), "readers just import it");

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
});
