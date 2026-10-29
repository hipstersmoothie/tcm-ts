// Build the publishable npm package in dist/package.
//
// Node refuses to strip types from files under node_modules, so an installed tcm can't ship its .ts source.
// This transpiles every workspace module to JavaScript in one package: relative `./x.ts` imports become
// `./x.js` and workspace imports (`@tcm/core`, ...) become relative paths. Code tcm generates at runtime
// (.tcm/cache) stays TypeScript; it lives in the user's project, not under node_modules.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repo = path.resolve(import.meta.dirname, "..");
const out = path.join(repo, "dist", "package");
const root = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version?: string };
// third-party dependencies of every workspace package (workspace links are bundled into this one package)
const dependencies: Record<string, string> = {};
for (const pkg of ["core", "store", "loader", "cli"]) {
  const deps = (JSON.parse(fs.readFileSync(path.join(repo, "packages", pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  for (const [name, range] of Object.entries(deps)) if (!range.startsWith("workspace:")) dependencies[name] = range;
}

// workspace package → its entry module within the built package
const ENTRIES: Record<string, string> = {
  "@tcm/core": "core/index.js",
  "@tcm/store": "store/index.js",
  "@tcm/loader": "loader/index.js",
  "@tcm/cli": "cli/main.js",
};

fs.rmSync(out, { recursive: true, force: true });
let modules = 0;
for (const pkg of ["core", "store", "loader", "cli"]) {
  const srcDir = path.join(repo, "packages", pkg, "src");
  for (const name of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(srcDir, name), "utf8");
    const { outputText, diagnostics } = ts.transpileModule(source, {
      fileName: name,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
        rewriteRelativeImportExtensions: true,
      },
    });
    if (diagnostics?.length) throw new Error(`${pkg}/${name}: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ")}`);
    const fromDir = path.join(out, pkg);
    const js = outputText.replace(/(from\s+|import\s*\(\s*)"(@tcm\/[a-z]+)"/g, (_m, lead: string, spec: string) => {
      const target = ENTRIES[spec];
      if (!target) throw new Error(`${pkg}/${name}: unknown workspace import ${spec}`);
      const rel = path.relative(fromDir, path.join(out, target)).split(path.sep).join("/");
      return `${lead}"${rel.startsWith(".") ? rel : "./" + rel}"`;
    });
    // only real module specifiers matter; the loader generates `.ts` imports in strings on purpose
    const parsed = ts.createSourceFile(name, js, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
    for (const st of parsed.statements) {
      const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
      if (spec.endsWith(".ts")) throw new Error(`${pkg}/${name}: import of ${spec} survived the build`);
    }
    fs.mkdirSync(fromDir, { recursive: true });
    fs.writeFileSync(path.join(fromDir, name.replace(/\.ts$/, ".js")), js);
    modules++;
  }
}

fs.mkdirSync(path.join(out, "bin"));
const bin = fs
  .readFileSync(path.join(repo, "packages/cli/bin/tcm.js"), "utf8")
  .replace('await import("../src/main.ts")', 'await import("../cli/main.js")');
if (bin.includes(".ts")) throw new Error("bin still imports TypeScript source");
fs.writeFileSync(path.join(out, "bin", "tcm.js"), bin, { mode: 0o755 });
fs.copyFileSync(path.join(repo, "README.md"), path.join(out, "README.md"));
// the README links into docs/, so the package carries it too
fs.cpSync(path.join(repo, "docs"), path.join(out, "docs"), { recursive: true });
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "tcm-ts",
      version: root.version ?? "0.1.0",
      description: "Unison's content-addressed codebase model for plain TypeScript",
      type: "module",
      // `tcm-ts` too, for where `tcm` is taken
      bin: { tcm: "bin/tcm.js", "tcm-ts": "bin/tcm.js" },
      engines: { node: ">=22.18" },
      dependencies,
      files: ["bin", "core", "store", "loader", "cli", "README.md", "docs"],
    },
    null,
    2,
  ) + "\n",
);
console.log(`built ${modules} modules into ${path.relative(repo, out)}`);
