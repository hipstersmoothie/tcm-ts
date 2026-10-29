// Linting with oxlint, with nothing to set up.
//
// - The linter is provided like any package: pinned in the lock (`tcm upgrade oxlint` moves it) and installed
//   into the cache.
// - Its configuration is inferred from the code: oxlint's correctness rules always, plus the plugins for what the
//   code uses (React and accessibility for JSX, Vitest for tests, Node for code using Node builtins).
// - A `lint.config` definition, if the codebase has one, extends it: its value is oxlint configuration (`rules`,
//   `categories`, `plugins`), and the packages it imports are used as JS plugins (ESLint-compatible), pinned and
//   installed like any import.
// - A definition's findings are cached by its hash, the linter's version and the configuration, so linting the
//   codebase only lints what's new.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { compareVersions, compatRange } from "@tcm/core";
import { ensureExternals, newestVersion, npmAlias, render } from "@tcm/loader";
import { configDefinition } from "./config.ts";
import type { Codebase } from "./codebase.ts";
import { isTestPath } from "./testing.ts";

export interface LintIssue {
  rule: string;
  message: string;
  severity: "warning" | "error";
  help?: string;
  url?: string;
  /** offsets in the text that was linted */
  start: number;
  end: number;
}

/** The path a codebase's lint configuration is a definition at. */
export const LINT_CONFIG = "lint.config";

/** The range a tool runs at: the one chosen for it, else the newest the codebase locks (none if it's never run). */
export function toolRange(cb: Codebase, name: string): string | undefined {
  const pad = (r: string) => (r.split(".").length === 1 ? `${r}.0.0` : r.split(".").length === 2 ? `${r}.0` : r);
  const locked = cb.store.lockedPackages().filter((l) => l.name === name).map((l) => l.range).sort((a, b) => compareVersions(pad(a), pad(b))).at(-1);
  return cb.store.getSetting(`tool.${name}`) ?? locked;
}

/** The tools tcm provides (no definition imports them: tcm runs them). */
export const TOOLS = new Set(["oxlint", "oxfmt", "vitest", "@vitest/browser-playwright", "playwright"]);

/**
 * A tool tcm provides from the cache: at the range chosen for it (`tcm upgrade <tool>@<range>`), else the newest
 * range the codebase locks, else the newest release's.
 */
export function provideTool(cb: Codebase, name: string): { module: string; dir: string; version: string } {
  const range = toolRange(cb, name) ?? compatRange(newestVersion(name) ?? "");
  if (!range) throw new Error(`can't find ${name} on the registry`);
  const module = `npm:${name}@${range}`;
  ensureExternals(cb.lay, [{ module, subpath: "", export: "*" }]);
  return { module, dir: path.join(cb.lay.cacheDir, "node_modules", npmAlias(module)), version: cb.store.lockedVersion(name, range)! };
}

interface UserConfig {
  config: Record<string, unknown>;
  /** JS plugins: directories of the packages `lint.config` imports */
  jsPlugins: string[];
  hash?: string;
}

/** The codebase's `lint.config`: its value, and the packages it imports, which are its JS plugins. */
function userConfig(cb: Codebase): UserConfig {
  const def = configDefinition(cb, LINT_CONFIG);
  if (!def) return { config: {}, jsPlugins: [] };
  const jsPlugins = [...new Set(def.rec.spans.flatMap((s) => (s.ext?.module.startsWith("npm:") && s.pos === "value" ? [s.ext.module] : [])))].map((m) =>
    path.join(cb.lay.cacheDir, "node_modules", npmAlias(m)),
  );
  return { config: def.value, jsPlugins, hash: def.hash };
}

/** What the code being linted uses, which decides the plugins. */
export interface LintTraits {
  jsx: boolean;
  tests: boolean;
  node: boolean;
}

/** The oxlint configuration for code with these traits: written to .tcm/lint, keyed by its content. */
function configFor(cb: Codebase, traits: LintTraits): { file: string; key: string; bin: string } {
  const tool = provideTool(cb, "oxlint");
  const user = userConfig(cb);
  const plugins = new Set(["typescript", "unicorn", "oxc"]);
  if (traits.jsx) for (const p of ["react", "jsx-a11y"]) plugins.add(p);
  if (traits.tests) plugins.add("vitest");
  if (traits.node) plugins.add("node");
  for (const p of (user.config.plugins as string[] | undefined) ?? []) plugins.add(p);
  const config = {
    plugins: [...plugins].sort(),
    categories: { correctness: "warn", ...((user.config.categories as object | undefined) ?? {}) },
    rules: (user.config.rules as object | undefined) ?? {},
    ...(user.jsPlugins.length ? { jsPlugins: user.jsPlugins } : {}),
    ...(user.config.settings ? { settings: user.config.settings } : {}),
  };
  const text = JSON.stringify(config, null, 2);
  const key = createHash("sha256").update(`${tool.version}\n${text}`).digest("hex").slice(0, 24);
  const dir = path.join(cb.lay.tcmDir, "lint");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `oxlintrc-${key}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text + "\n");
  return { file, key, bin: path.join(tool.dir, "bin", "oxlint") };
}

interface OxlintDiagnostic {
  message: string;
  code: string;
  severity: string;
  help?: string;
  url?: string;
  filename: string;
  labels?: { span: { offset: number; length: number } }[];
}

/** Lint texts (each with the extension it needs, `.ts` or `.tsx`) with one oxlint run: the issues of each. */
function lintTexts(cb: Codebase, texts: { text: string; ext: string }[], traits: LintTraits): LintIssue[][] {
  if (!texts.length) return [];
  const { file: config, bin } = configFor(cb, traits);
  const dir = fs.mkdtempSync(path.join(cb.lay.tcmDir, "lint", "run-"));
  try {
    const files = texts.map((t, i) => {
      const f = path.join(dir, `${i}${t.ext}`);
      fs.writeFileSync(f, t.text);
      return f;
    });
    const r = spawnSync(process.execPath, [bin, "--format=json", "-c", config, "--no-ignore", ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let parsed: { diagnostics?: OxlintDiagnostic[] };
    try {
      parsed = JSON.parse(r.stdout) as { diagnostics?: OxlintDiagnostic[] };
    } catch {
      throw new Error(`oxlint failed: ${r.stderr || r.stdout}`);
    }
    const byFile = new Map(files.map((f) => [path.basename(f), [] as LintIssue[]]));
    for (const d of parsed.diagnostics ?? []) {
      const span = d.labels?.[0]?.span;
      byFile.get(path.basename(d.filename))?.push({
        rule: d.code,
        message: d.message,
        severity: d.severity === "error" ? "error" : "warning",
        ...(d.help ? { help: d.help } : {}),
        ...(d.url ? { url: d.url } : {}),
        start: span?.offset ?? 0,
        end: (span?.offset ?? 0) + (span?.length ?? 0),
      });
    }
    return files.map((f) => byFile.get(path.basename(f)) ?? []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const traitsOfText = (file: string, text: string): LintTraits => ({
  jsx: file.endsWith(".tsx"),
  tests: /\bexport\s+(const|async\s+function|function)\s+test[A-Z_]/.test(text) || /from\s+["']vitest["']/.test(text),
  node: /from\s+["']node:/.test(text),
});

/** Lint a scratch file as written (an editor's buffer, say). Offsets are in `text`. */
export function lintScratch(cb: Codebase, file: string, text: string): LintIssue[] {
  return lintTexts(cb, [{ text, ext: path.extname(file) || ".ts" }], traitsOfText(file, text))[0]!;
}

export interface DefinitionLint {
  hash: string;
  path: string;
  /** the definition as `tcm view` shows it: what the issues' offsets are in */
  text: string;
  issues: LintIssue[];
  cached: boolean;
}

/**
 * Lint stored definitions, as `tcm view` shows them (current names, imports, `export`), cached by hash and the
 * linter's version and configuration. `fresh` lints again regardless.
 */
export function lintDefinitions(cb: Codebase, targets: { hash: string; path: string }[], fresh = false): DefinitionLint[] {
  const src = cb.source();
  const out: DefinitionLint[] = [];
  const pending = new Map<string, { hash: string; path: string; text: string; ext: string; traits: LintTraits }[]>();
  for (const t of targets) {
    const rec = src.get(t.hash);
    if (!rec || rec.kind === "type") continue;
    const text = render([rec], src, cb.lay, { style: "scratch", exportDeclarations: true }).text;
    const traits: LintTraits = {
      jsx: !!rec.jsx,
      tests: isTestPath(t.path),
      node: rec.spans.some((s) => s.ext?.module.startsWith("node:")),
    };
    const { key } = configFor(cb, traits);
    const hit = fresh ? undefined : cb.store.lintResult(t.hash, key);
    if (hit !== undefined) {
      out.push({ ...t, text, issues: JSON.parse(hit) as LintIssue[], cached: true });
      continue;
    }
    const group = JSON.stringify(traits);
    pending.set(group, [...(pending.get(group) ?? []), { ...t, text, ext: rec.jsx ? ".tsx" : ".ts", traits }]);
  }
  for (const items of pending.values()) {
    const { key } = configFor(cb, items[0]!.traits);
    const results = lintTexts(cb, items, items[0]!.traits);
    items.forEach((item, i) => {
      cb.store.putLintResult(item.hash, key, JSON.stringify(results[i]));
      out.push({ hash: item.hash, path: item.path, text: item.text, issues: results[i]!, cached: false });
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** `line:col` of an offset in `text` (1-based), and the line itself. */
export function locate(text: string, offset: number): { line: number; col: number; source: string } {
  const before = text.slice(0, offset).split("\n");
  const line = before.length;
  return { line, col: before.at(-1)!.length + 1, source: text.split("\n")[line - 1] ?? "" };
}
