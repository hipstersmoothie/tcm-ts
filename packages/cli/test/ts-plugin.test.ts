import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const require = createRequire(import.meta.url);
const plugin = require("../../../editors/vscode/ts-plugin/index.js") as () => { create(info: { languageService: ts.LanguageService }): ts.LanguageService };
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcm ts-plugin ")));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

test("the VS Code TypeScript plugin drops Go to Definition answers inside tcm's generated modules", () => {
  const tcm = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: "utf8" });
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
});
