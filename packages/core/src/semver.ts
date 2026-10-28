// npm versions: what a definition's hash records about a package (its compatible range), and the comparisons
// the codebase's package lock needs to pick one version per range.

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: string): Parsed | undefined {
  const m = VERSION.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" } : undefined;
}

/**
 * The range of versions semver says are compatible with `version`, as npm writes it: the major (`4` for 4.17.21),
 * the minor below 1.0 (`0.3` for 0.3.7, `0.0.4` for 0.0.4), and the exact version for a prerelease or anything
 * that isn't semver, which promise nothing. Applied to a range it returns the range.
 */
export function compatRange(version: string): string {
  if (/^\d+$/.test(version) || /^0\.\d+$/.test(version)) return version;
  const p = parse(version);
  if (!p || p.pre) return version;
  if (p.major > 0) return String(p.major);
  if (p.minor > 0) return `0.${p.minor}`;
  return `0.0.${p.patch}`;
}

/** Whether `v` is an exact version (`2.1.3`, `3.0.0-rc.1`) rather than a range (`2`, `0.3`). */
export function isExactVersion(v: string): boolean {
  return !!parse(v);
}

/** Order versions: negative when `a` comes first. Prereleases come before their release. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  const d = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (d) return d;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Whether `version` is in npm range `range` (`^1.2.0`, `~1.2`, `>=2 <3`, `1.x`, `1 - 2`, `a || b`, `*`). */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split("||").some((set) => {
    const trimmed = set.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    const comparators = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : trimmed.split(/\s+/).filter(Boolean);
    // a prerelease only satisfies a range that names a prerelease of the same version
    if (v.pre && !comparators.some((c) => { const p = parse(c.replace(/^[\^~<>=]+/, "")); return p && p.pre && p.major === v.major && p.minor === v.minor && p.patch === v.patch; })) return false;
    return comparators.every((c) => test(version, c));
  });
}

/** `1.x`, `1.2`, `*` as the bounds they mean: [lowest allowed, first not allowed). */
function partial(spec: string): [string, string | undefined] | undefined {
  if (spec === "" || spec === "*" || spec === "x" || spec === "X") return ["0.0.0", undefined];
  const parts = spec.split(".");
  const nums = parts.map((p) => (/^[xX*]$/.test(p) ? undefined : Number(p)));
  if (nums.some((n) => n !== undefined && Number.isNaN(n))) return undefined;
  const [maj, min, pat] = nums;
  if (maj === undefined) return ["0.0.0", undefined];
  if (min === undefined) return [`${maj}.0.0`, `${maj + 1}.0.0`];
  if (pat === undefined) return [`${maj}.${min}.0`, `${maj}.${min + 1}.0`];
  return undefined;
}

function test(version: string, comparator: string): boolean {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(comparator)!;
  const op = m[1] ?? "";
  const spec = m[2]!.replace(/^v/, "");
  const cmp = (b: string) => compareVersions(version, b);
  const p = parse(spec);
  if (!p) {
    const bounds = partial(spec);
    if (!bounds) return false;
    const [lo, hi] = bounds;
    if (op === "" || op === "=" || op === "^" || op === "~") return cmp(lo) >= 0 && (hi === undefined || cmp(hi) < 0);
    if (op === ">=") return cmp(lo) >= 0;
    if (op === ">") return hi === undefined ? false : cmp(hi) >= 0;
    if (op === "<") return cmp(lo) < 0;
    if (op === "<=") return hi === undefined || cmp(hi) < 0;
    return false;
  }
  switch (op) {
    case "":
    case "=":
      return cmp(spec) === 0;
    case ">":
      return cmp(spec) > 0;
    case ">=":
      return cmp(spec) >= 0;
    case "<":
      return cmp(spec) < 0;
    case "<=":
      return cmp(spec) <= 0;
    case "~":
      return cmp(spec) >= 0 && cmp(`${p.major}.${p.minor + 1}.0`) < 0;
    case "^": {
      const upper = p.major > 0 ? `${p.major + 1}.0.0` : p.minor > 0 ? `0.${p.minor + 1}.0` : `0.0.${p.patch + 1}`;
      return cmp(spec) >= 0 && cmp(upper) < 0;
    }
  }
  return false;
}
