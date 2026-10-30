// tcm pack: a codebase's definitions as an npm package (JavaScript with declarations, entry points by name,
// bins, dependencies from the lock), installed and used the way npm users would. Uses the npm registry.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { plainEnv, strip, tcmBin, tempDir } from "./harness.ts";

/** A new codebase with greet (a function with a doc, an interface, a main using a package) and ui (a component). */
function setUp() {
  const dir = tempDir("pack");
  const env = plainEnv();
  const spawn = (cmd: string, args: string[], cwd = dir) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
    return { status: r.status, out: strip(r.stdout + r.stderr) };
  };
  const tcm = (...args: string[]) => {
    const r = spawn(process.execPath, [tcmBin(), ...args]);
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
    return r.out;
  };
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
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
  return { dir, spawn, tcm, write, read };
}

/** Pack definitions into a package: bins, entry points, types, docs, dependencies at their locked versions. */
export const testPackIntoPackage = () => {
  const { dir, spawn, tcm } = setUp();
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
  const user = tempDir("pack user");
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
  const tsc = path.join(path.dirname(createRequire(tcmBin()).resolve("typescript/package.json")), "bin", "tsc");
  const errors = spawn(process.execPath, [tsc, "-p", ".", "--pretty", "false"], user).out.trim().split("\n");
  assert.deepEqual(errors, ["bad.ts(2,7): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'."]);
}

/** A package pinned at two ranges keeps both, side by side. */
export const testPackTwoRangesSideBySide = () => {
  const { tcm, write, read } = setUp();
  write("old.ts", `// tcm: namespace old\nimport escape from "escape-string-regexp";\nexport const quote = (s: string): string => escape(s);\n`);
  tcm("add", "old.ts");
  tcm("upgrade", "escape-string-regexp@4", "old");
  tcm("pack", "greet.finder", "old.quote", "--name", "both");
  const pkg = JSON.parse(read(".tcm/pack/both/package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["npm__escape-string-regexp__4", "npm__escape-string-regexp__5"]);
  assert.match(pkg.dependencies["npm__escape-string-regexp__4"], /^npm:escape-string-regexp@4\.\d+\.\d+$/);
};

/** Pack refuses what it can't export unambiguously. */
export const testPackRefusesAmbiguousExports = () => {
  const { dir, spawn, tcm, write } = setUp();
  write("other.ts", `// tcm: namespace other\nexport const greet = 1;\n`);
  tcm("add", "other.ts");
  const clash = spawn(process.execPath, [tcmBin(), "pack", "greet", "other", "--name", "x"]);
  assert.notEqual(clash.status, 0);
  assert.match(clash.out, /two values would be exported as greet: greet\.greet and other\.greet; pack them under separate subpaths/);
  assert.match(spawn(process.execPath, [tcmBin(), "pack", "nope", "--name", "x"]).out, /'nope' isn't a definition or namespace/);
  assert.match(spawn(process.execPath, [tcmBin(), "pack", "--bin", "x", "--name", "x"]).out, /--bin wants cmd=<name>, not 'x'/);
  // the output directory is replaced, so it has to be an earlier pack
  assert.match(spawn(process.execPath, [tcmBin(), "pack", "greet", "--name", "x", "--out", "."]).out, /--out \.: .* isn't empty or an earlier tcm pack/);
  assert.ok(fs.existsSync(path.join(dir, ".tcm", "codebase.sqlite")));
};

/**
 * A package for an editor (a VS Code extension): its API comes from where it runs (`vscode`, its types from
 * @types/vscode, never a dependency), its package.json starts from a file of the codebase, and files ship beside it.
 */
export const testPackForAnEditor = () => {
  const dir = tempDir("pack editor");
  const env = plainEnv();
  const tcm = (...args: string[]) => {
    const r = spawnSync(process.execPath, [tcmBin(), ...args], { cwd: dir, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${strip(r.stdout + r.stderr)}`);
    return strip(r.stdout + r.stderr);
  };
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  const manifest = {
    name: "hello-ext",
    main: "./extension.js",
    engines: { vscode: "^1.90.0" },
    contributes: { commands: [{ command: "hello.say", title: "Say hello" }] },
    dependencies: { helper: "file:./helper" },
    scripts: { build: "nothing to build" },
  };
  write("files/package.json", JSON.stringify(manifest, null, 2));
  write("files/README.md", "# hello\n");
  write("files/helper/package.json", JSON.stringify({ name: "helper", main: "index.js" }));
  tcm("add", "files/package.json", "--into", "ext.files");
  tcm("add", "files/README.md", "--into", "ext.files");
  tcm("add", "files/helper/package.json", "--into", "ext.files.helper");
  write(
    "ext.ts",
    `// tcm: namespace ext
import * as vscode from "vscode";

export const manifest = { name: "hello-ext", exports: { ".": ["activate"] }, packageJson: "files.package", files: ["files.README", "files.helper"] };

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("hello.say", () => vscode.window.showInformationMessage("hello")));
}
`,
  );
  tcm("add", "ext.ts");
  assert.match(tcm("deps", "ext.activate"), /vscode/);
  // checked again from the codebase, the types come from @types/vscode there too
  assert.match(tcm("verify"), /verified \d+ definitions/);

  tcm("pack", "hello-ext");
  const out = path.join(dir, ".tcm", "pack", "hello-ext");
  const pkg = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8"));
  assert.equal(pkg.name, "hello-ext");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./index.js", "main is the entry tcm writes");
  assert.deepEqual(pkg.contributes, manifest.contributes);
  assert.deepEqual(pkg.engines, { vscode: "^1.90.0", node: ">=22.18" });
  assert.deepEqual(pkg.dependencies, { helper: "file:./helper" }, "what ships with it stays; vscode isn't installed");
  assert.equal(pkg.scripts, undefined);
  assert.equal(fs.readFileSync(path.join(out, "README.md"), "utf8"), "# hello\n");
  assert.ok(fs.existsSync(path.join(out, "helper", "package.json")));
  const modules = fs.readdirSync(path.join(out, "modules")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(out, "modules", f), "utf8")).join("\n");
  assert.match(modules, /from "vscode";/);
};
