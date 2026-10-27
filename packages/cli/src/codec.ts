// Wire format for calls between the browser and the server. Shared verbatim by both sides: ucm dev sends these
// functions' own source to the browser (see codecSource), so they must not use anything outside this file.
//
// Plain data crosses: JSON values plus undefined, Date, BigInt, Map, Set, NaN/±Infinity and -0. Functions, class
// instances, symbols and cycles are refused with a message saying what couldn't be sent, rather than silently
// turning into `{}`.

type Tagged = { $u: 1 } | { $d: string } | { $b: string } | { $m: unknown[] } | { $s: unknown[] } | { $n: string } | { $o: Record<string, unknown> };

function toWire(v: unknown, path: string, seen: Set<object>): unknown {
  if (v === undefined) return { $u: 1 };
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $n: Object.is(v, -0) ? "-0" : String(v) };
  if (typeof v === "bigint") return { $b: v.toString() };
  if (typeof v !== "object") throw new TypeError(`can't send ${typeof v} at ${path} over the network (only plain data crosses)`);
  if (seen.has(v)) throw new TypeError(`can't send a circular structure at ${path}`);
  seen.add(v);
  try {
    if (v instanceof Date) return { $d: v.toISOString() };
    if (Array.isArray(v)) return v.map((x, i) => toWire(x, `${path}[${i}]`, seen));
    if (v instanceof Map) return { $m: [...v].map(([k, x], i) => [toWire(k, `${path}<key ${i}>`, seen), toWire(x, `${path}.get(…)`, seen)]) };
    if (v instanceof Set) return { $s: [...v].map((x, i) => toWire(x, `${path}<item ${i}>`, seen)) };
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`can't send a ${proto?.constructor?.name ?? "class"} instance at ${path} over the network (only plain data crosses)`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toWire(x, `${path}.${k}`, seen);
    // an object that looks like one of our tags is wrapped so it decodes as itself
    const keys = Object.keys(out);
    return keys.length === 1 && keys[0]!.startsWith("$") ? { $o: out } : out;
  } finally {
    seen.delete(v);
  }
}

function fromWire(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(fromWire);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const t = v as Tagged;
    if ("$u" in t) return undefined;
    if ("$d" in t) return new Date(t.$d);
    if ("$b" in t) return BigInt(t.$b);
    if ("$n" in t) return t.$n === "-0" ? -0 : Number(t.$n);
    if ("$m" in t) return new Map((t.$m as [unknown, unknown][]).map(([k, x]) => [fromWire(k), fromWire(x)]));
    if ("$s" in t) return new Set(t.$s.map(fromWire));
    if ("$o" in t) return Object.fromEntries(Object.entries(t.$o).map(([k, x]) => [k, fromWire(x)]));
  }
  return Object.fromEntries(keys.map((k) => [k, fromWire(o[k])]));
}

export function encode(value: unknown, what = "value"): string {
  return JSON.stringify(toWire(value, what, new Set()));
}

export function decode(text: string): unknown {
  return fromWire(JSON.parse(text));
}

/**
 * The codec as a browser module, built from the functions' own source text, so it is the same code wherever ucm
 * itself runs from (its source, a built package, or a codebase's .ucm/cache).
 */
export function codecSource(): string {
  return `${toWire}\n${fromWire}\nexport ${encode}\nexport ${decode}\n`;
}
