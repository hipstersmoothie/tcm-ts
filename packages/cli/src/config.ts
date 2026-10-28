// Tool configuration as code: `lint.config`, `fmt.config`. A configuration is a definition like any other: its
// value is the configuration, and the packages it imports (plugins) are pinned like any import. Changing it is an
// update, and its history is the codebase's.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DefRecord } from "@tcm/core";
import { materialize, nodeArgs } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";

const values = new Map<string, unknown>();

/** The definition at `name`, evaluated (once per hash; functions in it are dropped), or undefined if none. */
export function configDefinition(cb: Codebase, name: string): { value: Record<string, unknown>; hash: string; rec: DefRecord } | undefined {
  const hash = cb.store.hashesAt(name, "term")[0];
  if (!hash) return undefined;
  const rec = cb.store.getDef(hash)!;
  if (!values.has(hash)) {
    materialize([hash], cb.source(), cb.lay);
    const runner = path.join(cb.lay.cacheDir, `config_${hash}.ts`);
    fs.writeFileSync(
      runner,
      `import { h_${hash} as config } from "./${path.basename(cb.modulePath(rec.componentHash))}";\n` +
        `const value: unknown = typeof config === "function" ? await (config as () => unknown)() : config;\n` +
        `process.stdout.write(JSON.stringify(value ?? {}, (_k, v) => (typeof v === "function" ? undefined : v)));\n`,
    );
    const r = spawnSync(process.execPath, [...nodeArgs(cb.lay), runner], { encoding: "utf8" });
    fs.rmSync(runner, { force: true });
    if (r.status !== 0) throw new Error(`${name} failed to evaluate:\n${r.stderr}`);
    values.set(hash, JSON.parse(r.stdout || "{}"));
  }
  return { value: values.get(hash) as Record<string, unknown>, hash, rec };
}
