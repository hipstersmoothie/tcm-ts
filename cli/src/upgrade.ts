// tcm upgrade: moving code to newer package versions, the way `update` moves it to newer definitions.
//
// - Within a compatible range (`tcm upgrade react`): the lock moves to the newest version in each range react is
//   used at, and so do the packages built against it (those with react as a peer dependency: react-dom). Hashes
//   don't change, since definitions pin the range; everything using them is typechecked again, and the upgrade is
//   undone if anything breaks (unless --force).
// - To another range (`tcm upgrade react@20`, or `react@latest`; optionally only in a namespace): definitions are
//   re-pinned and re-hashed, as an update. Packages built against it are re-pinned to a range that accepts the new
//   version. Dependents follow, and whatever stops typechecking goes to `todo`.
import { compareVersions, compatRange, pinnedRange, satisfies, shortHash } from "@tcm/core";
import { ensureExternals, installedPeers, newestVersion, parseModule, versionsIn } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { TOOLS } from "./lint.ts";
import { bold, dim, green, red, yellow } from "./style.ts";

interface Move {
  name: string;
  range: string;
  from: string;
  to: string;
}

/** Named, live definitions that use `name` (at `range`, or any), with the ranges they use. */
export function usersOf(cb: Codebase, name: string, range?: string, namespace?: string): Map<string, string> {
  const out = new Map<string, string>();
  const live = cb.liveHashes();
  for (const n of cb.store.names()) {
    if (namespace && n.path !== namespace && !n.path.startsWith(`${namespace}.`)) continue;
    if (!live.has(n.hash)) continue;
    const rec = cb.store.getDef(n.hash);
    for (const d of rec?.deps ?? []) {
      const r = pinnedRange(d.ref, name);
      if (r && (!range || r === range)) out.set(n.hash, r);
    }
    if (rec?.jsx?.startsWith(`npm:${name}@`) && (!range || rec.jsx === `npm:${name}@${range}`)) out.set(n.hash, parseModule(rec.jsx).version);
  }
  return out;
}

/**
 * The newest version of `name` that `fits` accepts, looking range by range from the newest (asking the registry
 * for every version's peers at once is more than it answers).
 */
function newestFitting(name: string, fits: (c: { version: string; peers: Record<string, string> }) => boolean): string | undefined {
  const ranges = [...new Set(versionsIn(name, ">=0.0.0").map((c) => compatRange(c.version)))];
  for (const range of ranges) {
    const hit = versionsIn(name, range).find(fits);
    if (hit) return hit.version;
  }
  return undefined;
}

/** Locked packages built against `name`: they list it as a peer dependency. */
function builtAgainst(cb: Codebase, name: string): { name: string; range: string; version: string }[] {
  return cb.store.lockedPackages().filter((l) => !l.name.startsWith("@types/") && l.name !== name && name in installedPeers(cb.lay, `npm:${l.name}@${l.range}`));
}

const typesFor = (name: string) => `@types/${name.replace(/^@/, "").replace("/", "__")}`;

/** Move the lock to the newest versions within the ranges `name` is used at. */
export function upgradeWithin(cb: Codebase, name: string, force: boolean): boolean {
  const moves: Move[] = [];
  const locked = cb.store.lockedPackages();
  for (const l of locked.filter((l) => l.name === name)) {
    const newest = versionsIn(name, l.range)[0]?.version;
    if (newest && compareVersions(newest, l.version) > 0) moves.push({ name, range: l.range, from: l.version, to: newest });
  }
  if (!locked.some((l) => l.name === name)) {
    console.log(dim(`nothing in the codebase uses ${name}`));
    return true;
  }
  // what's built against it moves along, to versions that accept the new one
  const next = (n: string, r: string) => moves.find((m) => m.name === n && m.range === r)?.to ?? cb.store.lockedVersion(n, r);
  for (const q of builtAgainst(cb, name)) {
    const fits = versionsIn(q.name, q.range).find((c) => {
      const peer = c.peers[name];
      return !peer || cb.store.lockedPackages().filter((l) => l.name === name).some((l) => satisfies(next(name, l.range)!, peer));
    });
    if (fits && compareVersions(fits.version, q.version) > 0) moves.push({ name: q.name, range: q.range, from: q.version, to: fits.version });
  }
  for (const m of [...moves]) {
    const t = typesFor(m.name);
    const was = cb.store.lockedVersion(t, m.range);
    const newest = was && versionsIn(t, m.range)[0]?.version;
    if (was && newest && compareVersions(newest, was) > 0) moves.push({ name: t, range: m.range, from: was, to: newest });
  }
  if (!moves.length) {
    console.log(green(`${name} is up to date`) + dim(` (${locked.filter((l) => l.name === name).map((l) => `${l.range}: ${l.version}`).join(", ")})`));
    return true;
  }
  const apply = (version: (m: Move) => string) => {
    for (const m of moves) cb.store.lockVersion(m.name, m.range, version(m));
    ensureExternals(cb.lay, moves.filter((m) => !m.name.startsWith("@types/")).map((m) => ({ module: `npm:${m.name}@${m.range}`, subpath: "", export: "*" })));
  };
  apply((m) => m.to);
  for (const m of moves) console.log(`  ${bold(m.name)} ${dim(m.range)}  ${m.from} → ${green(m.to)}`);
  // nothing's hash changes; check that everything using them still typechecks
  const users = new Set(moves.flatMap((m) => [...usersOf(cb, m.name, m.range).keys()]));
  const problems = cb.recheck(users);
  if (problems.length && !force) {
    apply((m) => m.from);
    for (const p of problems.slice(0, 5)) process.stdout.write(p);
    console.log(red(`\n${problems.length} problem(s) in the ${users.size} definition(s) using them; the lock is back where it was. --force upgrades anyway.`));
    return false;
  }
  if (problems.length) console.log(yellow(`  upgraded with ${problems.length} type problem(s) (--force)`));
  console.log(dim(`  ${users.size} definition(s) re-checked; no hashes changed`));
  return true;
}

/**
 * Re-pin the definitions using `name` (in `namespace`, or all) to range `target` (a range, a version, or
 * "latest"), and the packages built against it to ranges that accept it; re-hash them and their dependents.
 */
export function upgradeTo(cb: Codebase, name: string, target: string, namespace: string | undefined): boolean {
  const version = target === "latest" ? newestVersion(name) : (versionsIn(name, target)[0]?.version ?? (versionsIn(name, compatRange(target))[0]?.version));
  if (!version) throw new Error(`can't find ${name}@${target} (is the registry reachable?)`);
  const range = compatRange(version);
  // the range a package built against `name` needs, to accept the new version
  const peerRanges = new Map<string, string>();
  for (const q of builtAgainst(cb, name)) {
    const fit = newestFitting(q.name, (c) => !c.peers[name] || satisfies(version, c.peers[name]!));
    if (fit) peerRanges.set(q.name, compatRange(fit));
  }
  const module = (m: string): string => {
    if (!m.startsWith("npm:")) return m;
    const p = parseModule(m);
    if (p.name === name) return `npm:${name}@${range}`;
    const r = peerRanges.get(p.name);
    return r ? `npm:${p.name}@${r}` : m;
  };
  const hashes = new Set<string>();
  for (const n of [name, ...peerRanges.keys()]) {
    for (const [h, r] of usersOf(cb, n, undefined, namespace)) if (module(`npm:${n}@${r}`) !== `npm:${n}@${r}`) hashes.add(h);
  }
  const where = namespace ? ` in ${namespace}` : "";
  // a tool (oxlint, oxfmt, vitest): no definition pins it; the codebase records which range it runs
  if (TOOLS.has(name) && !usersOf(cb, name).size && !namespace) {
    ensureExternals(cb.lay, [{ module: `npm:${name}@${range}`, subpath: "", export: "*" }]);
    cb.store.setSetting(`tool.${name}`, range);
    console.log(`${bold(name)} now runs at ${range} (${cb.store.lockedVersion(name, range)})`);
    return true;
  }
  if (!hashes.size) {
    console.log(dim(`nothing${where} uses ${name} other than at ${range}`));
    return true;
  }
  console.log(`re-pinning ${hashes.size} definition(s)${where} to ${bold(`${name} ${range}`)}${peerRanges.size ? dim(`, with ${[...peerRanges].map(([n, r]) => `${n} ${r}`).join(", ")}`) : ""}`);
  const r = cb.propagate(new Map(), { hashes, module, command: `upgrade ${name}@${range}` });
  for (const p of r.updated) console.log(`  ${green("~")} ${p}`);
  if (r.failed.length) {
    console.log(yellow(`\n${r.failed.length} definition(s) didn't typecheck on ${name} ${range}; they keep their old versions and are in \`tcm todo\`:`));
    for (const h of r.failed.slice(0, 10)) console.log(`  ${cb.displayRef(`#${h}`)} ${dim(shortHash(h))}: ${(cb.store.todos().find((t) => t.hash === h)?.message ?? "").split("\n")[0]}`);
  }
  return !r.failed.length;
}

/** `tcm packages`: what the codebase runs, and what uses it. */
export function listPackages(cb: Codebase) {
  const locked = cb.store.lockedPackages();
  if (!locked.length) return console.log(dim("no packages yet: import one in a scratch file"));
  const users = new Map<string, number>();
  for (const l of locked) users.set(`${l.name}@${l.range}`, usersOf(cb, l.name, l.range).size);
  const width = Math.max(...locked.map((l) => l.name.length));
  for (const l of locked) {
    const n = users.get(`${l.name}@${l.range}`) ?? 0;
    const tool = TOOLS.has(l.name) && (cb.store.getSetting(`tool.${l.name}`) ?? l.range) === l.range;
    const note = l.name.startsWith("@types/") ? "types" : n ? `${n} definition${n === 1 ? "" : "s"}` : tool ? "tool" : "unused";
    console.log(`${l.name.padEnd(width)}  ${dim(l.range.padEnd(6))}  ${l.version.padEnd(10)}  ${dim(note)}`);
  }
}
