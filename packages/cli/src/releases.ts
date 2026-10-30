// Releases, as on Unison Share: a package's version is an immutable name for a point in history, with release notes
// kept in the codebase. A codebase can hold any number of packages (manifests.ts), each released on its own. The
// version and the notes' list of changes come from the codebase: semver checks (semver-checks.ts) find what changed
// in the package's API since its previous release and what that calls for, so neither can be wrong or incomplete;
// people write the summary above the list, in a markdown scratch file. Changelogs are rendered from the releases.
import fs from "node:fs";
import path from "node:path";
import { bumpVersion, compareVersions, isConflicted, isExactVersion, shortHash, type DefKind } from "@tcm/core";
import type { Contribution, NameRow, Release } from "@tcm/store";
import type { Codebase } from "./codebase.ts";
import { diffNamespaces, keyPath, stateOf } from "./diff.ts";
import { absolute, exportsOf, findPackage, owns, packagesIn, type Pkg } from "./manifests.ts";
import { pack, type Sibling } from "./pack.ts";
import { openRemote } from "./sync.ts";
import { checkPairs, highest, LINTS, levelOf, type Finding, type Level } from "./semver-checks.ts";

export class ReleaseError extends Error {}

const rowsAt = (cb: Codebase, causal: string) => cb.store.namespaceRows(cb.store.causal(causal)!.namespace);

/** The release of `pkg` this one follows: its newest one in this branch's history. */
export function previousRelease(cb: Codebase, pkg: string, head = cb.store.head()): Release | undefined {
  return cb.store.releases(pkg).find((r) => cb.store.isAncestor(r.causal, head));
}

/** The first sentence of a definition's documentation. */
const summaryOf = (doc: string | undefined) => doc?.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").replace(/^(.*?[.!?])\s.*$/, "$1").trim() || undefined;

/** A package as it is in some namespace state: its manifest, and what it exports from where. */
export interface PackageState {
  pkg: Pkg;
  rows: NameRow[];
  exported: Map<string, string>;
}

/** A package in a namespace state, if it's there. */
export function packageState(cb: Codebase, rows: NameRow[], name: string): PackageState | undefined {
  const all = packagesIn(cb, rows);
  const pkg = all.find((p) => p.name === name);
  return pkg && { pkg, rows, exported: exportsOf(pkg, all, rows) };
}

export interface ApiReport {
  findings: Finding[];
  /** definitions re-hashed only because what they use changed: covered by those findings */
  following: string[];
  /** documentation summaries, by name, for added and changed definitions */
  summaries: Map<string, string>;
  /** signatures of added definitions */
  signatures: Map<string, string>;
}

/** What changed in a package's API from one state of it to another, lint by lint. */
export function apiReport(cb: Codebase, before: PackageState, after: PackageState): ApiReport {
  const def = (h: string) => cb.store.getDef(h)!;
  const api = (s: PackageState) => stateOf(s.rows.filter((r) => s.exported.has(r.path)));
  const irOf = (h: string) => def(h).ir;
  const d = diffNamespaces(api(before), api(after), irOf);
  // re-hashed only because something it uses changed, wherever that is (another package, say): judged on the
  // whole namespace, since the API's slice of it doesn't have the cause
  const following = new Set(diffNamespaces(stateOf(before.rows), stateOf(after.rows), irOf).propagated.map((c) => keyPath(c.path)));
  const findings: Finding[] = [];
  const summaries = new Map<string, string>();
  const signatures = new Map<string, string>();
  for (const r of d.removed) findings.push({ lint: "definition_removed", path: keyPath(r.path) });
  for (const r of d.renamed) findings.push({ lint: "definition_renamed", path: keyPath(r.from), detail: keyPath(r.to) });
  for (const a of [...d.added, ...d.aliased]) {
    findings.push({ lint: "definition_added", path: keyPath(a.path) });
    const n = def(a.hash);
    if (n.kind !== "type") signatures.set(keyPath(a.path), n.signature);
    const s = summaryOf(n.doc);
    if (s) summaries.set(keyPath(a.path), s);
  }
  for (const [p, sub] of after.exported) {
    const was = before.exported.get(p);
    if (was !== undefined && was !== sub) findings.push({ lint: "export_moved", path: p, detail: `${was} → ${sub}` });
  }
  const [binsBefore, binsAfter] = [before.pkg.manifest.bin, after.pkg.manifest.bin];
  for (const cmd of Object.keys(binsBefore)) if (!(cmd in binsAfter)) findings.push({ lint: "bin_removed", path: cmd });
  for (const cmd of Object.keys(binsAfter)) if (!(cmd in binsBefore)) findings.push({ lint: "bin_added", path: cmd });
  const checked = checkPairs(cb, [...d.edited, ...d.propagated].map((c) => ({ path: keyPath(c.path), old: def(c.old), new: def(c.new) })));
  const followed: string[] = [];
  for (const f of checked) {
    // a definition whose code didn't change, only what it uses: its API change (if any) is reported, its
    // "implementation change" is the dependency's
    if (f.lint === "implementation_changed" && following.has(f.path)) followed.push(f.path);
    else findings.push(f);
  }
  for (const c of d.edited) {
    const s = summaryOf(def(c.new).doc);
    if (s) summaries.set(keyPath(c.path), s);
  }
  // `a: Point → Point`: the change is Point's; said once, where Point is (unless Point isn't in the API)
  const reported = new Set(findings.map((f) => f.path.slice(f.path.lastIndexOf(".") + 1)));
  const echo = (f: Finding) => {
    const m = /^(?:[\w$]+: )?(.+), whose definition changed$/.exec(f.detail ?? "");
    return !!m && [...m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)].some((t) => reported.has(t[0]));
  };
  const kept = findings.filter((f) => !echo(f));
  // breaking changes first, then additions, then the rest; by name within each
  const rank = { major: 0, minor: 1, patch: 2 };
  kept.sort((a, b) => rank[levelOf(a)] - rank[levelOf(b)] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { findings: kept, following: followed, summaries, signatures };
}

/**
 * The version a level of change calls for after `prev`: from 1.0, a major for breaking changes, a minor for
 * additions, a patch otherwise; before 1.0, a minor for breaking changes and a patch for anything else (as npm and
 * Cargo read 0.x versions).
 */
export function nextVersion(prev: string | undefined, level: Level | undefined): string {
  if (!prev) return "0.1.0";
  const zero = prev.startsWith("0.");
  return bumpVersion(prev, !level ? "patch" : zero ? (level === "major" ? "minor" : "patch") : level);
}

/**
 * The merged contributions a release brings: whose merge is in its history and not the previous release's, and
 * that changed something of the package's.
 */
function contributionsIn(cb: Codebase, list: Contribution[], plan: Plan): Contribution[] {
  const seen = new Set<string>();
  const touches = (c: Contribution) => {
    const [a, b] = [rowsAt(cb, c.mergedFrom!), rowsAt(cb, c.mergedAs!)];
    const all = packagesIn(cb, b);
    const pkg = all.find((p) => p.name === plan.pkg.name) ?? plan.pkg;
    const mine = (rows: NameRow[]) => stateOf(rows.filter((r) => owns(pkg, all, r.path) || r.path === pkg.manifestPath));
    const d = diffNamespaces(mine(a), mine(b), (h) => cb.store.getDef(h)!.ir);
    return Object.values(d).some((xs: unknown[]) => xs.length);
  };
  return list
    .filter((c) => c.status === "merged" && c.mergedAs && c.mergedFrom && cb.store.hasCausal(c.mergedAs) && cb.store.hasCausal(c.mergedFrom))
    .filter((c) => cb.store.isAncestor(c.mergedAs!, plan.head) && !(plan.prev && cb.store.isAncestor(c.mergedAs!, plan.prev.causal)))
    .filter((c) => !seen.has(c.mergedAs!) && (seen.add(c.mergedAs!), true))
    .filter(touches)
    .sort((a, b) => a.id - b.id);
}

/** Where people's words end and the generated list of changes begins, in a draft and in the notes. */
export const MARKER = "<!-- tcm: the changes below are generated from the codebase when the release is made -->";

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

export interface Plan {
  pkg: Pkg;
  version: string;
  /** what the changes call for */
  computed: string;
  head: string;
  now: PackageState;
  prev?: Release;
  report?: ApiReport;
  level?: Level;
}

/**
 * The next release of a package on this branch: its version from the API's changes since its previous release (or
 * as given, if that's at least as far).
 */
export function planRelease(cb: Codebase, name: string | undefined, version: string | undefined, force: boolean): Plan {
  const head = cb.store.head();
  const rows = cb.store.names();
  const all = packagesIn(cb, rows);
  if (!all.length) throw new ReleaseError("no packages here: a definition named `manifest` makes its namespace one (see docs/publishing.md)");
  if (name === undefined && all.length > 1) throw new ReleaseError(`which package? ${all.map((p) => p.name).join(", ")}`);
  const pkg = name === undefined ? all[0]! : all.find((p) => p.name === name);
  if (!pkg) throw new ReleaseError(`no package ${name} (there's ${all.map((p) => p.name).join(", ")})`);
  const now: PackageState = { pkg, rows, exported: exportsOf(pkg, all, rows) };
  const prev = previousRelease(cb, pkg.name, head);
  const then = prev && packageState(cb, rowsAt(cb, prev.causal), pkg.name);
  const report = then ? apiReport(cb, then, now) : undefined;
  const level = report && highest(report.findings);
  const computed = nextVersion(prev?.version, level);
  const v = version ?? computed;
  const at = `${pkg.name}@${v}`;
  if (!isExactVersion(v)) throw new ReleaseError(`'${v}' isn't a version (major.minor.patch, like ${computed})`);
  const existing = cb.store.release(pkg.name, v);
  if (existing) throw new ReleaseError(`${at} is already released (as ${shortHash(existing.causal)}); releases don't change`);
  if (prev && compareVersions(v, prev.version) <= 0) throw new ReleaseError(`${v} isn't after ${prev.version}, the release of ${pkg.name} this branch's history has`);
  if (!force) {
    const blocked = blockers(cb, pkg, all, rows);
    if (blocked) throw new ReleaseError(blocked);
    if (report && !report.findings.length && version === undefined) {
      throw new ReleaseError(`${pkg.name} has nothing new since ${prev!.version}${report.following.length ? " (only what it uses changed, in other packages)" : ""}: no release to make (give a version, or --force, to make one anyway)`);
    }
    if (compareVersions(v, computed) < 0) {
      const why = [...new Set(report!.findings.filter((f) => levelOf(f) === level).map((f) => f.path))];
      throw new ReleaseError(
        `${v} is too small a step from ${prev!.version}: ${level === "major" ? "breaking changes" : "additions"} (${why.slice(0, 5).join(", ")}${why.length > 5 ? ", …" : ""}) call for ${computed} (\`tcm release check ${pkg.name}\` shows why; --force releases anyway)`,
      );
    }
  }
  return { pkg, version: v, computed, head, now, prev, report, level };
}

/** Why a package can't be released as it stands (work left in `tcm todo`), if so. */
export function blockers(cb: Codebase, pkg: Pkg, all: Pkg[], rows: NameRow[]): string | undefined {
  const kinds = new Map<string, DefKind[]>();
  for (const n of rows) if (owns(pkg, all, n.path)) kinds.set(n.path, [...(kinds.get(n.path) ?? []), n.kind]);
  const live = cb.liveHashes();
  const broken = cb.store.todos().filter((t) => live.has(t.hash) && cb.store.pathsOf(t.hash).some((p) => owns(pkg, all, p)));
  if ([...kinds.values()].some(isConflicted) || broken.length) return `${pkg.name} has work left (\`tcm todo\`): release it when that's done, or --force`;
  return undefined;
}

/** The generated part of a release's notes. */
export function generatedNotes(cb: Codebase, plan: Plan, contributions: Contribution[]): string {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => items.length && lines.push(`### ${title}`, "", ...items.map((i) => `- ${i}`), "");
  if (!plan.report) {
    const subs = [...new Set(plan.now.exported.values())].sort();
    lines.push(`The first release: ${plan.now.exported.size} definition(s)${subs.length > 1 ? `, from ${subs.map(code).join(", ")}` : ""}.`, "");
  } else {
    const { findings, summaries, signatures } = plan.report;
    const line = (f: Finding) => {
      if (f.lint === "definition_removed") return `${code(f.path)} removed`;
      if (f.lint === "definition_renamed") return `${code(f.path)} renamed to ${code(f.detail!)}`;
      if (f.lint === "bin_removed" || f.lint === "bin_added") return `the ${code(f.path)} command ${f.lint === "bin_removed" ? "removed" : "added"}`;
      if (f.lint === "definition_added") return `${code(f.path)}${signatures.has(f.path) ? ` ${code(signatures.get(f.path)!)}` : ""}${summaries.has(f.path) ? `: ${summaries.get(f.path)}` : ""}`;
      if (f.lint === "implementation_changed") return `${code(f.path)}${summaries.has(f.path) ? `: ${summaries.get(f.path)}` : ""} (new implementation, same API)`;
      return `${code(f.path)} ${LINTS[f.lint].summary}${f.detail ? `: ${code(f.detail)}` : ""}`;
    };
    section("Breaking changes", findings.filter((f) => levelOf(f) === "major").map(line));
    section("Added", findings.filter((f) => f.lint === "definition_added" || f.lint === "bin_added").map(line));
    section("Extended", findings.filter((f) => levelOf(f) === "minor" && f.lint !== "definition_added" && f.lint !== "bin_added").map(line));
    section("Changed", findings.filter((f) => levelOf(f) === "patch").map(line));
    if (!findings.length) lines.push(`No changes to the API since ${plan.prev!.version}.`, "");
  }
  section("Contributions", contributionsIn(cb, contributions, plan).map((c) => `#${c.id} ${c.title} (${c.author})`));
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** A release's notes in full: a heading, what people wrote, then what's generated. */
function notesOf(version: string, date: number, written: string, generated: string): string {
  const day = new Date(date).toISOString().slice(0, 10);
  return [`## ${version} (${day})`, "", ...(written.trim() ? [written.trim(), ""] : []), MARKER, "", generated].join("\n") + "\n";
}

/** What people wrote in a draft (or a notes file): everything above the marker, without the heading tcm writes. */
export function writtenPart(text: string): string {
  const above = text.includes(MARKER) ? text.slice(0, text.indexOf(MARKER)) : text;
  return above.replace(/^## .*\n/, "").trim();
}

/** The draft of a package's next release (its version is only settled when it's made). */
export const draftFile = (cb: Codebase, pkg: string) => path.join(cb.lay.root, `release-${pkg.replace(/^@/, "").replace("/", "-")}.md`);
const PLACEHOLDER = "<!-- what this release is about, for the people who use it -->";

/** Write the draft: a heading and room for a summary, then the generated part (regenerated when the release is made). */
export function writeDraft(cb: Codebase, plan: Plan, generated: string): string {
  const file = draftFile(cb, plan.pkg.name);
  const kept = fs.existsSync(file) ? writtenPart(fs.readFileSync(file, "utf8")) : "";
  fs.writeFileSync(file, notesOf(plan.version, Date.now(), kept || PLACEHOLDER, generated));
  return file;
}

/** Make the release: its notes are what was written (a draft, or a file), then the generated part. */
export function publish(cb: Codebase, plan: Plan, written: string, generated: string, author: string): Release {
  const ts = Date.now();
  const words = written.replace(/<!--[\s\S]*?-->/g, "").trim();
  const r: Release = { package: plan.pkg.name, version: plan.version, namespace: plan.pkg.namespace, causal: plan.head, notes: notesOf(plan.version, ts, words, generated), author, ts };
  cb.store.putRelease(r);
  return r;
}

/** A package's changelog: its releases' notes, newest first (up to `upTo`, if given). */
export function changelog(cb: Codebase, pkg: string, upTo?: string): string {
  const until = upTo ? cb.store.release(pkg, upTo) : undefined;
  const rs = cb.store.releases(pkg).filter((r) => !until || cb.store.isAncestor(r.causal, until.causal));
  const body = rs.map((r) => r.notes.replace(`${MARKER}\n\n`, "").trimEnd()).join("\n\n");
  return `# Changelog\n\n${body || "No releases yet."}\n`;
}

/** `name@1.2.3` (or `@scope/name@1.2.3`), or a bare name. */
export function parseSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1).replace(/^v/, "") } : { name: spec };
}

/**
 * Pack a package: a release of it (`version`), or the branch as it is. What it exports and its commands come from
 * its manifest; what it uses of the codebase's other packages comes from their releases, as dependencies.
 */
export function packPackage(cb: Codebase, name: string | undefined, version: string | undefined, out: string | undefined) {
  // the branch exactly where a release of it is: that release
  const head = cb.store.head();
  const atRelease = version === undefined ? cb.store.releases(name).find((r) => r.causal === head && (!name || r.package === name)) : undefined;
  const release = atRelease ?? (version === undefined ? undefined : cb.store.release(name ?? "", version));
  if (version !== undefined && !release) throw new ReleaseError(`no release ${name}@${version} (see \`tcm releases\`)`);
  const rows = release ? rowsAt(cb, release.causal) : cb.store.names();
  const all = packagesIn(cb, rows);
  const pkg = findPackage(all, name);
  const exported = exportsOf(pkg, all, rows);
  // a definition the package has a name for is its own, even if another package has the same one (same hash)
  const mine = new Set(rows.filter((r) => owns(pkg, all, r.path)).map((r) => r.hash));
  const siblings: Sibling[] = all
    .filter((o) => o !== pkg)
    .map((o) => ({
      name: o.name,
      owned: new Map(rows.filter((r) => owns(o, all, r.path) && !mine.has(r.hash)).map((r) => [r.hash, r.path])),
      releases: cb.store.releases(o.name).flatMap((r) => {
        const st = packageState(cb, rowsAt(cb, r.causal), o.name);
        if (!st) return [];
        const byHash = new Map<string, { subpath: string; name: string }>();
        for (const row of st.rows) {
          const sub = st.exported.get(row.path);
          if (sub !== undefined && !byHash.has(row.hash)) byHash.set(row.hash, { subpath: sub, name: row.path.slice(row.path.lastIndexOf(".") + 1) });
        }
        return [{ version: r.version, exported: byHash }];
      }),
    }));
  const hasReleases = cb.store.releases(pkg.name).length > 0;
  // the fields its package.json starts from, from a JSON file of the codebase
  const jsonAt = pkg.manifest.packageJson && absolute(pkg.namespace, pkg.manifest.packageJson);
  const json = jsonAt ? cb.store.hashesAt(jsonAt).map((h) => cb.store.getDef(h)!).find((d) => d.kind === "file") : undefined;
  if (jsonAt && !json) throw new Error(`${pkg.manifestPath}: packageJson names ${jsonAt}, which isn't a file of the codebase`);
  const packageJson = json && (JSON.parse(json.sourceText) as Record<string, unknown>);
  const r = pack(cb, {
    name: pkg.name,
    version: release?.version ?? "0.0.0",
    description: pkg.manifest.description,
    entries: [...exported].map(([target, sub]) => ({ subpath: sub === "." ? "." : sub.replace(/^\.\//, ""), target })),
    bins: Object.entries(pkg.manifest.bin).map(([command, rel]) => ({ command, target: absolute(pkg.namespace, rel) })),
    with: pkg.manifest.with,
    // a path, or a namespace of the codebase's files, relative to the package's
    files: pkg.manifest.files.map((f) => (fs.existsSync(path.resolve(cb.lay.root, f)) ? f : absolute(pkg.namespace, f))),
    out: out ?? path.join(".tcm", "pack", pkg.name.replace(/^@/, "").replace("/", "__")),
    names: rows,
    changelog: release ? changelog(cb, pkg.name, release.version) : hasReleases ? changelog(cb, pkg.name) : undefined,
    siblings,
    ...(packageJson ? { packageJson } : {}),
  });
  return { ...r, pkg, version: release?.version ?? "0.0.0" };
}

/** The merged contributions a remote knows (where a release's are, when it's made off the server); none if it can't say. */
export async function contributionsOn(cb: Codebase, remote: string | undefined): Promise<Contribution[]> {
  const spec = remote ?? (cb.store.getSetting("remote.origin") ? "origin" : undefined);
  if (!spec) return [];
  try {
    return await openRemote(cb, spec).remote.contributions(true);
  } catch (e) {
    if (remote) throw e;
    return [];
  }
}

/**
 * Release a package: plan it, write its notes (the words from `notesFile`, or its draft if there is one; the
 * changes from the codebase), record it. A draft whose words were used is removed: they're in the release now.
 */
export async function releasePackage(
  cb: Codebase,
  o: { name?: string; version?: string; notesFile?: string; remote?: string; force: boolean; author: string },
): Promise<{ release: Release; plan: Plan }> {
  const plan = planRelease(cb, o.name, o.version, o.force);
  const generated = generatedNotes(cb, plan, [...cb.store.contributions(), ...(await contributionsOn(cb, o.remote))]);
  const draft = draftFile(cb, plan.pkg.name);
  const notesFile = o.notesFile ?? (fs.existsSync(draft) ? draft : undefined);
  if (notesFile && !fs.existsSync(notesFile)) throw new ReleaseError(`no file ${notesFile}`);
  const release = publish(cb, plan, notesFile ? writtenPart(fs.readFileSync(notesFile, "utf8")) : "", generated, o.author);
  if (notesFile === draft) fs.rmSync(draft);
  return { release, plan };
}

/** Why a release has the version it has, in a few words. */
export function reasonFor(plan: Plan): string {
  if (plan.version !== plan.computed) return "as asked";
  if (!plan.prev) return "its first release";
  if (!plan.level) return "no API changes";
  return { major: "breaking changes", minor: "additions", patch: "changes with the same API" }[plan.level];
}
