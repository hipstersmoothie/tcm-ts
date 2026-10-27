// Print `<file>:<name> <hash>` for every definition under a directory, using the analyzer at UCM_CORE.
// Used by compare-ts-versions.sh to check that hashes do not depend on the TypeScript version.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as Core from "../packages/core/src/index.ts";

const core = (await import(path.resolve(process.env.UCM_CORE ?? "packages/core/src/index.ts"))) as typeof Core;
const root = path.resolve(process.argv[2] ?? "packages");
const files = (function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "test"].includes(e.name) || e.name.startsWith(".") ? [] : walk(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
})(root);
const a = core.analyzeProject(files, { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "ucm-hash-")), resolveName: () => "" });
if (a.errors.length || a.diagnostics.length) {
  console.error([...a.errors, ...a.diagnostics.map((d) => d.formatted)].join("\n"));
  process.exit(1);
}
console.error(`typescript ${core.TS_VERSION}: ${a.defs.length} definitions`);
for (const d of a.defs.map((d) => `${path.relative(root, d.file)}:${d.nameHint} ${d.hash}`).sort()) console.log(d);
