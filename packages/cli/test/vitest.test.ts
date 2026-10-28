import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROME } from "./browser.ts";

// Tests run with Vitest, with nothing to set up: each test definition is a Vitest test (expect, vi, diffs), run in
// Node, or in Chrome when it needs a browser (it renders a component with state), with server functions reached
// by hash. Results stay cached by hash. Uses the npm registry.

const BIN = process.env.TCM_BIN ? path.resolve(process.env.TCM_BIN) : fileURLToPath(new URL("../bin/tcm.js", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcm vitest "));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
};
const tcm = (...args: string[]) => {
  const r = run(...args);
  if (r.status !== 0) throw new Error(`tcm ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
};
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

test("vitest: expect, vi and diffs in Node, nothing installed, results cached by hash", () => {
  tcm("init");
  fs.rmSync(path.join(dir, "scratch.ts"));
  write(
    "m.ts",
    `// tcm: namespace m\nimport { expect, vi } from "vitest";\n\nexport const double = (n: number): number => n * 2;\n\n` +
      `export const testDouble = () => {\n  expect(double(2)).toBe(4);\n};\n\n` +
      `export const testMocks = () => {\n  const f = vi.fn<(x: number) => number>((x) => x + 1);\n  f(1);\n  expect(f).toHaveBeenCalledWith(1);\n};\n\n` +
      `export const testFails = () => {\n  console.log("about to fail");\n  expect({ a: double(1) }).toEqual({ a: 3 });\n};\n`,
  );
  tcm("add", "m.ts");
  const r = run("test", "m");
  assert.equal(r.status, 1);
  assert.match(r.out, /✓ m\.testDouble/);
  assert.match(r.out, /✓ m\.testMocks/);
  assert.match(r.out, /✗ m\.testFails[\s\S]*expected \{ a: 2 \} to deeply equal \{ a: 3 \}[\s\S]*- {3}"a": 3,[\s\S]*\+ {3}"a": 2,[\s\S]*│ about to fail/, "Vitest's message, its diff, and the test's output");
  assert.match(run("test", "m").out, /2 passed, 1 failed \(3 cached\)/);
  assert.match(tcm("packages"), /vitest\s+5\s+5\.\d+\.\d+/, "the test framework is pinned like any package");
});

test("vitest: a test that renders a component with state runs in Chrome, and reaches server functions by hash", { skip: !CHROME && "no Chrome" }, () => {
  write(
    "ui.tsx",
    `// tcm: namespace ui\nimport { hostname } from "node:os";\nimport { useEffect, useState } from "react";\nimport { expect } from "vitest";\n` +
      `import { fireEvent, render, screen, waitFor } from "@testing-library/react";\n\n` +
      `export async function serverName(): Promise<string> {\n  return hostname() ? "a server" : "?";\n}\n\n` +
      `export function Counter() {\n  const [n, setN] = useState(0);\n  const [name, setName] = useState("…");\n  useEffect(() => void serverName().then(setName), []);\n` +
      `  return <button onClick={() => setN(n + 1)}>clicked {n} on {name}</button>;\n}\n\n` +
      `export const testCounter = async () => {\n  render(<Counter />);\n  fireEvent.click(screen.getByRole("button"));\n` +
      `  await waitFor(() => expect(screen.getByRole("button").textContent).toBe("clicked 1 on a server"));\n  expect(typeof window).toBe("object");\n};\n\n` +
      `export const testInNode = () => {\n  expect(typeof process.versions.node).toBe("string");\n};\n`,
  );
  // checked before it's saved: the scratch file's own definitions are what the test runs
  const checked = tcm("check", "ui.tsx");
  assert.match(checked, /✓ ui\.testCounter/, "in a browser: it renders a component that keeps state");
  assert.match(checked, /✓ ui\.testInNode/, "and a test that doesn't need one runs in Node");
});
