// Formatting with oxfmt, with nothing to set up.
//
// Formatting never changes a hash: the IR has no whitespace, layout, quotes or trailing commas in it. So tcm
// formats freely without touching identity, history or dependents:
//
// - what's saved is formatted: `tcm add` and `tcm update` store each definition's formatted text (the scratch file
//   itself is left as you wrote it), so `tcm view`, `tcm edit`, pages and generated modules show one style;
// - in the editor, scratch files are formatted on save, and by Format Document;
// - `tcm fmt [namespace]` reformats what's already stored (after a style change, or an oxfmt upgrade).
//
// A `fmt.config` definition holds oxfmt's options (printWidth, singleQuote, semi, …). Each formatted text is
// re-hashed before it's kept, and kept only if every hash is unchanged, so a formatter bug can't change code.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { saltOf } from "@tcm/core";
import { moduleFile, render } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { configDefinition } from "./config.ts";
import { provideTool } from "./lint.ts";

/** The path a codebase's formatting options are a definition at. */
export const FMT_CONFIG = "fmt.config";

/** oxfmt and the configuration file for the codebase's options. */
function formatter(cb: Codebase): { bin: string; config: string } {
  const tool = provideTool(cb, "oxfmt");
  const options = configDefinition(cb, FMT_CONFIG)?.value ?? {};
  const text = JSON.stringify(options, null, 2);
  const key = createHash("sha256").update(`${tool.version}\n${text}`).digest("hex").slice(0, 24);
  const dir = path.join(cb.lay.tcmDir, "fmt");
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(dir, `oxfmtrc-${key}.json`);
  if (!fs.existsSync(config)) fs.writeFileSync(config, text + "\n");
  return { bin: path.join(tool.dir, "bin", "oxfmt"), config };
}

/** `text` formatted as a file named like `fileName` (`.ts`, `.tsx`); undefined if oxfmt can't parse it. */
export function formatText(cb: Codebase, text: string, fileName: string): string | undefined {
  const { bin, config } = formatter(cb);
  const r = spawnSync(process.execPath, [bin, `--stdin-filepath=${path.basename(fileName)}`, "-c", config], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

/**
 * Reformat stored definitions: each component is rendered as it's stored (identifiers as written), formatted,
 * analyzed again, and its new text kept only where the hash is the same. Returns what changed.
 */
export function formatStored(cb: Codebase, hashes: string[]): { formatted: string[]; unchanged: number; skipped: string[] } {
  const src = cb.source();
  const comps = new Set(hashes.map((h) => src.get(h)?.componentHash).filter((c): c is string => !!c));
  const out = { formatted: [] as string[], unchanged: 0, skipped: [] as string[] };
  for (const c of comps) {
    const members = src.members(c);
    if (members.every((m) => m.kind === "type" && !m.sourceText)) continue;
    const rendered = render(members, src, cb.lay, { style: "internal", preserveText: true });
    const file = path.join(cb.lay.cacheDir, `_fmt_${moduleFile(c, src)}`);
    const formatted = formatText(cb, rendered.text, file);
    if (formatted === undefined || formatted === rendered.text) {
      out.unchanged += members.length;
      continue;
    }
    fs.writeFileSync(file, formatted);
    try {
      const byName = new Map([...rendered.memberNames].map(([h, n]) => [n, src.get(h)!]));
      const a = cb.analyzeProject([file], (_f, name) => { const r = byName.get(name); return r && saltOf(r.ir); }, [7016], cb.recheckOptions(members[0]?.checked));
      for (const m of members) {
        const d = a.defs.find((x) => x.nameHint === rendered.memberNames.get(m.hash));
        if (!d || d.hash !== m.hash) {
          out.skipped.push(m.hash);
          continue;
        }
        if (d.sourceText === m.sourceText) {
          out.unchanged++;
          continue;
        }
        cb.store.replaceSource(m.hash, d.sourceText, d.spans, d.reservedNames);
        out.formatted.push(m.hash);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  return out;
}
