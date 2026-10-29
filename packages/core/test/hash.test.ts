// Runs the tests in ./hash.ts with node:test. They're test definitions, so in a codebase `tcm test` runs them too,
// cached by hash.
import { test } from "node:test";
import * as tests from "./hash.ts";

for (const [name, fn] of Object.entries(tests as Record<string, unknown>)) {
  if (name.startsWith("test") && typeof fn === "function") test(name, async () => void (await fn()));
}
