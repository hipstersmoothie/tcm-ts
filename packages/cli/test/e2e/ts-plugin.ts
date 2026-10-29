// The VS Code extension's TypeScript plugin, in a language service like VS Code's over a codebase's tsconfig.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import ts from "typescript6";
import { plainEnv, repoPath, tcmBin, tempDir } from "./harness.ts";

type Plugin = () => { create(info: { languageService: ts.LanguageService }): ts.LanguageService };

/** The VS Code extension's TypeScript plugin (packages/editors/vscode/ts-plugin). */
function vscodePlugin(): Plugin {
  const file = repoPath("packages/editors/vscode/ts-plugin/index.js");
  return createRequire(file)(file) as Plugin;
}

/** The VS Code TypeScript plugin drops Go to Definition answers inside tcm's generated modules. */
export const testPluginDropsGeneratedDefinitions = () => {
  const plugin = vscodePlugin();
  const dir = tempDir("ts-plugin");
  const env = plainEnv();
  const tcm = (...args: string[]) => spawnSync(process.execPath, [tcmBin(), ...args], { cwd: dir, env, encoding: "utf8" });
  tcm("init");
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nexport const square = (x: number): number => x * x;\n`);
  assert.equal(tcm("add").status, 0);
  const file = path.join(dir, "scratch.ts");
  const text = `import { square } from "#codebase/lib";\nconst local = 2;\nexport const area = square(local);\n`;
  fs.writeFileSync(file, text);

  // a language service like VS Code's, over the codebase's own tsconfig
  const config = ts.getParsedCommandLineOfConfigFile(path.join(dir, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")) : undefined),
    getCompilationSettings: () => config.options,
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const ls = ts.createLanguageService(host);
  const at = (needle: string) => text.indexOf(needle) + 1;

  // TypeScript alone sends Cmd+click on a codebase name into generated code
  const plain = ls.getDefinitionAndBoundSpan(file, at("square(local"))!;
  assert.ok(plain.definitions?.length);
  assert.match(plain.definitions![0]!.fileName, /\.tcm\/cache\/[a-z2-7]{52}\.ts$/);

  const wrapped = plugin().create({ languageService: ls });
  assert.deepEqual(wrapped.getDefinitionAndBoundSpan(file, at("square(local"))!.definitions, [], "left to the tcm language server");
  assert.deepEqual(wrapped.getDefinitionAtPosition(file, at("square(local")), []);
  // everything else is untouched: a definition in the same file still resolves
  const local = wrapped.getDefinitionAndBoundSpan(file, at("local)"))!.definitions!;
  assert.equal(local[0]!.fileName, file);
};

/** The VS Code TypeScript plugin resolves packages tcm provides, as tcm does. */
export const testPluginResolvesProvidedPackages = () => {
  const plugin = vscodePlugin();
  const root = tempDir("ts-plugin packages");
  const env = plainEnv();
  const tcm = (...args: string[]) => spawnSync(process.execPath, [tcmBin(), ...args], { cwd: root, env, encoding: "utf8" });
  tcm("init");
  const file = path.join(root, "scratch.ts");
  // ms isn't installed in the project: tcm provides it
  fs.writeFileSync(file, `import ms from "ms";\nexport const short = (n: number): string => ms(n);\n`);
  const checked = tcm("check");
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);

  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")) : undefined),
    getCompilationSettings: () => config.options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const errors = (service: ts.LanguageService) => service.getSemanticDiagnostics(file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  assert.match(errors(ts.createLanguageService(host)).join("\n"), /Cannot find module 'ms'/, "TypeScript alone can't find it");
  const pluginHost = { ...host };
  (plugin as unknown as (m: { typescript: typeof ts }) => { create(info: object): ts.LanguageService })({ typescript: ts }).create({ languageService: ts.createLanguageService(pluginHost), languageServiceHost: pluginHost });
  assert.deepEqual(errors(ts.createLanguageService(pluginHost)), [], "with the plugin, it resolves to tcm's copy, types included");
};
