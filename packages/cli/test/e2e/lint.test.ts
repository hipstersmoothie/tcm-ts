// Runs the end-to-end tests in ./lint.ts with node:test, against packages/cli/bin/tcm.js unless TCM_BIN says
// otherwise. In a codebase, `tcm test` runs them itself: each as a program, cached by the code it ran.
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.TCM_BIN ??= fileURLToPath(new URL("../../bin/tcm.js", import.meta.url));
process.env.TCM_REPO ??= fileURLToPath(new URL("../../../..", import.meta.url));
const tests = await import("./lint.ts");
for (const [name, fn] of Object.entries(tests as Record<string, unknown>)) {
  if (name.startsWith("test") && typeof fn === "function") test(name, async () => void (await fn()));
}
