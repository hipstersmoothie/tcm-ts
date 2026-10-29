import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// tcm pack: a codebase's definitions as an npm package (JavaScript with declarations, entry points by name,
// bins, dependencies from the lock), installed and used the way npm users would. Uses the npm registry.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm pack ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const spawn = (cmd: string, args: string[], cwd = dir) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
};
const tcm = (...args: string[]) => {
  const r = spawn(process.execPath, [BIN, ...args]);
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
};
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");

test("pack definitions into a package: bins, entry points, types, docs, dependencies at their locked versions", () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  write(
    "greet.ts",
    `// tcm: namespace greet
import escape from "escape-string-regexp";

export interface Greeting {
  to: string;
  text: string;
}

/** A greeting, and a pattern that finds it. */
export function greet(to: string): Greeting {
  return { to, text: \`hello, \${to}\` };
}

export const finder = (g: Greeting): RegExp => new RegExp(escape(g.text));

export function main(...names: string[]): number {
  for (const n of names) console.log(greet(n).text, finder(greet(n)).source);
  return names.length ? 0 : 2;
}
`,
  );
  write("ui.tsx", `// tcm: namespace ui\nexport function Badge({ label }: { label: string }) {\n  return <b>{label}</b>;\n}\n`);
  tcm("add", "greet.ts");
  tcm("add", "ui.tsx");
  write("README.md", "# greeter\n");

  const out = tcm("pack", "greet", "ui=ui", "--name", "greeter@1.2.0", "--bin", "greeter=greet.main", "--files", "README.md");
  assert.match(out, /packed greeter@1\.2\.0 into \.tcm\/pack\/greeter: \d+ module\(s\), depends on @types\/react, escape-string-regexp, react/);
  const pkgDir = path.join(dir, ".tcm", "pack", "greeter");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const locked = (name: string) => /\d+\.\d+\.\d+/.exec(tcm("packages").split("\n").find((l) => l.trimStart().startsWith(`${name} `))!)![0];
  assert.deepEqual(pkg.dependencies, { "@types/react": locked("@types/react"), "escape-string-regexp": locked("escape-string-regexp"), react: locked("react") });
  assert.deepEqual(pkg.bin, { greeter: "bin/greeter.js" });
  assert.deepEqual(Object.keys(pkg.exports), [".", "./ui"]);
  assert.equal(fs.readFileSync(path.join(pkgDir, "README.md"), "utf8"), "# greeter\n");
  // packages by name, not the cache's aliases; documentation in the declarations
  const modules = fs.readdirSync(path.join(pkgDir, "modules")).map((f) => fs.readFileSync(path.join(pkgDir, "modules", f), "utf8")).join("\n");
  assert.match(modules, /from "escape-string-regexp"/);
  assert.match(modules, /from "react\/jsx-runtime"/);
  assert.match(modules, /import\("react"\)\.JSX\.Element/);
  assert.doesNotMatch(modules, /npm__|\.tsx?"/);
  assert.match(modules, /\/\*\*\n \* A greeting, and a pattern that finds it\.\n \*\/\ndeclare function greet/);

  // installed from its tarball, like any package
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "tcm pack user "));
  const packed = spawn("npm", ["pack", "--silent", "--pack-destination", user], pkgDir);
  assert.equal(packed.status, 0, packed.out);
  fs.writeFileSync(path.join(user, "package.json"), JSON.stringify({ name: "user", private: true, type: "module" }));
  const installed = spawn("npm", ["install", "./greeter-1.2.0.tgz", "--no-audit", "--no-fund", "--loglevel=error"], user);
  assert.equal(installed.status, 0, installed.out);

  // the bin runs the definition as tcm run does; a number it returns is the exit code
  const greeter = path.join(user, "node_modules", ".bin", "greeter");
  assert.deepEqual(spawn(greeter, ["a.b"], user), { status: 0, out: "hello, a.b hello, a\\.b\n" });
  assert.equal(spawn(greeter, [], user).status, 2);

  // the definitions by name, typed
  fs.writeFileSync(path.join(user, "use.ts"), `import { greet, finder, type Greeting } from "greeter";\nimport { Badge } from "greeter/ui";\nconst g: Greeting = greet("x");\nconsole.log(finder(g).test("hello, x"), typeof Badge);\n`);
  assert.deepEqual(spawn(process.execPath, ["use.ts"], user), { status: 0, out: "true function\n" });
  fs.writeFileSync(path.join(user, "bad.ts"), `import { greet } from "greeter";\ngreet(1);\n`);
  // checked the way a user's project would check it: tsc
  const compilerOptions = { module: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [] };
  fs.writeFileSync(path.join(user, "tsconfig.json"), JSON.stringify({ compilerOptions, files: ["use.ts", "bad.ts"] }));
  const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const errors = spawn(process.execPath, [tsc, "-p", ".", "--pretty", "false"], user).out.trim().split("\n");
  assert.deepEqual(errors, ["bad.ts(2,7): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'."]);
});

test("a package pinned at two ranges keeps both, side by side", () => {
  write("old.ts", `// tcm: namespace old\nimport escape from "escape-string-regexp";\nexport const quote = (s: string): string => escape(s);\n`);
  tcm("add", "old.ts");
  tcm("upgrade", "escape-string-regexp@4", "old");
  tcm("pack", "greet.finder", "old.quote", "--name", "both");
  const pkg = JSON.parse(read(".tcm/pack/both/package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["npm__escape-string-regexp__4", "npm__escape-string-regexp__5"]);
  assert.match(pkg.dependencies["npm__escape-string-regexp__4"], /^npm:escape-string-regexp@4\.\d+\.\d+$/);
});

test("pack refuses what it can't export unambiguously", () => {
  write("other.ts", `// tcm: namespace other\nexport const greet = 1;\n`);
  tcm("add", "other.ts");
  const clash = spawn(process.execPath, [BIN, "pack", "greet", "other", "--name", "x"]);
  assert.notEqual(clash.status, 0);
  assert.match(clash.out, /two values would be exported as greet: greet\.greet and other\.greet; pack them under separate subpaths/);
  assert.match(spawn(process.execPath, [BIN, "pack", "nope", "--name", "x"]).out, /'nope' isn't a definition or namespace/);
  assert.match(spawn(process.execPath, [BIN, "pack", "--bin", "x", "--name", "x"]).out, /--bin wants cmd=<name>, not 'x'/);
  // the output directory is replaced, so it has to be an earlier pack
  assert.match(spawn(process.execPath, [BIN, "pack", "greet", "--name", "x", "--out", "."]).out, /--out \.: .* isn't empty or an earlier tcm pack/);
  assert.ok(fs.existsSync(path.join(dir, ".tcm", "codebase.sqlite")));
});
