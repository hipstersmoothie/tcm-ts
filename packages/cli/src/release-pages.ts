// What editors show of the codebase's packages and their releases: the list, the next release of one (its version
// and every semver finding behind it, with a preview of its notes), and a package's page (its manifest, next
// release, and changelog). `tcm lsp` serves these (tcm/publishing, tcm/releaseCheck, tcm/releasePage).
import { shortHash } from "@tcm/core";
import type { Codebase } from "./codebase.ts";
import { exportsOf, packagesIn } from "./manifests.ts";
import { blockers, changelog, generatedNotes, MARKER, planRelease, reasonFor, writtenPart } from "./releases.ts";
import { LINTS } from "./semver-checks.ts";

export interface PackageSummary {
  name: string;
  namespace: string;
  description?: string;
  latest?: { version: string; ts: number };
  releases: number;
}

/** The packages on this branch, with their latest releases. */
export function publishingList(cb: Codebase): PackageSummary[] {
  return packagesIn(cb, cb.store.names()).map((p) => {
    const rs = cb.store.releases(p.name);
    return { name: p.name, namespace: p.namespace, description: p.manifest.description, latest: rs[0] && { version: rs[0].version, ts: rs[0].ts }, releases: rs.length };
  });
}

export interface CheckView {
  name: string;
  version: string;
  after?: string;
  /** "breaking changes", "additions", … */
  reason: string;
  level?: "major" | "minor" | "patch";
  findings: { lint: string; level: string; path: string; summary: string; why: string; detail?: string; hash?: string }[];
  /** definitions that only follow those changes */
  following: string[];
  /** the notes' generated part, as the release would have it now (markdown) */
  notes: string;
  /** why it can't be released as things stand (work left in todo), if so */
  blocked?: string;
  /** nothing of its own changed since its last release: nothing to release */
  upToDate: boolean;
}

/** Checks are worth keeping (they typecheck old and new versions): until the branch or the package's releases move. */
const checks = new Map<string, CheckView>();

/** A package's next release: what it would be, and why. */
export function releaseCheck(cb: Codebase, name: string): CheckView {
  const key = `${cb.store.head()} ${name} ${cb.store.releases(name)[0]?.version ?? ""} ${cb.store.todos().length} ${cb.store.contributions().length}`;
  const kept = checks.get(key);
  if (kept) return kept;
  const plan = planRelease(cb, name, undefined, true);
  const rows = cb.store.names();
  const hashOf = (p: string) => cb.store.hashesAt(p)[0];
  const view: CheckView = {
    name: plan.pkg.name,
    version: plan.computed,
    after: plan.prev?.version,
    reason: reasonFor(plan),
    level: plan.level,
    findings: (plan.report?.findings ?? []).map((f) => ({ lint: f.lint, level: LINTS[f.lint].level, path: f.path, summary: LINTS[f.lint].summary, why: LINTS[f.lint].why, detail: f.detail, hash: hashOf(f.path) })),
    following: plan.report?.following ?? [],
    notes: generatedNotes(cb, plan, cb.store.contributions()),
    blocked: blockers(cb, plan.pkg, packagesIn(cb, rows), rows),
    upToDate: !!plan.report && !plan.report.findings.length,
  };
  if (checks.size > 50) checks.clear();
  checks.set(key, view);
  return view;
}

/** A package's releases, newest first: cheap (no checks), for listing. */
export function releaseList(cb: Codebase, name: string) {
  return cb.store.releases(name).map((r) => ({
    version: r.version,
    ts: r.ts,
    author: r.author,
    causal: shortHash(r.causal),
    summary: writtenPart(r.notes).split("\n").find((l) => l.trim() && !l.startsWith("<!--")) ?? "",
    notes: r.notes.replace(`${MARKER}\n\n`, "").trimEnd(),
    /** the notes without their heading (the page shows the version and date its own way) */
    body: r.notes.replace(`${MARKER}\n\n`, "").replace(/^## .*\n+/, "").trimEnd(),
  }));
}

/** A package's page: its manifest, its next release, and its releases (the changelog), newest first. */
export function releasePage(cb: Codebase, name: string) {
  const rows = cb.store.names();
  const all = packagesIn(cb, rows);
  const pkg = all.find((p) => p.name === name);
  if (!pkg) throw new Error(`no package ${name} on this branch`);
  const subpaths = new Map<string, number>();
  for (const sub of exportsOf(pkg, all, rows).values()) subpaths.set(sub, (subpaths.get(sub) ?? 0) + 1);
  return {
    name: pkg.name,
    namespace: pkg.namespace,
    manifestHash: pkg.manifestHash,
    description: pkg.manifest.description,
    exports: [...subpaths].map(([subpath, count]) => ({ subpath, count })),
    bin: Object.entries(pkg.manifest.bin).map(([command, target]) => ({ command, target })),
    with: pkg.manifest.with,
    next: releaseCheck(cb, name),
    releases: releaseList(cb, name),
    changelog: changelog(cb, name),
  };
}
