// Source maps from generated modules back to definitions, so stack traces and debuggers show the code you read
// (a definition's file in .tcm/src, or the scratch file it came from), not .tcm/cache/<hash>.ts.
//
// The maps are by line: a definition's body is the same text in its module and in its view, only placed
// differently, so each line of it maps to the same line of the view.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += B64[digit];
  } while (v);
  return out;
}

/** One generated line's mapping: the source file and line it comes from (0-based), and its columns. */
export interface LineMapping {
  line: number;
  source: string;
  sourceLine: number;
  /** generated column → source column, at the start of each token; [[0, 0]] when omitted */
  columns?: [number, number][];
}

/** A source map (v3); `sources` are as given (paths relative to the generated file). */
export function lineSourceMap(file: string, mappings: LineMapping[]): string {
  const sources = [...new Set(mappings.map((m) => m.source))];
  const byLine = new Map(mappings.map((m) => [m.line, m]));
  const lastLine = Math.max(-1, ...mappings.map((m) => m.line));
  let prevSource = 0;
  let prevLine = 0;
  let prevCol = 0;
  const lines: string[] = [];
  for (let l = 0; l <= lastLine; l++) {
    const m = byLine.get(l);
    if (!m) {
      lines.push("");
      continue;
    }
    const s = sources.indexOf(m.source);
    let genPrev = 0;
    const segments: string[] = [];
    for (const [gen, col] of m.columns ?? [[0, 0]]) {
      // [generated column, source index delta, source line delta, source column delta]
      segments.push(vlq(gen - genPrev) + vlq(s - prevSource) + vlq(m.sourceLine - prevLine) + vlq(col - prevCol));
      genPrev = gen;
      prevSource = s;
      prevLine = m.sourceLine;
      prevCol = col;
    }
    lines.push(segments.join(","));
  }
  return JSON.stringify({ version: 3, file, sources, names: [], mappings: lines.join(";") });
}

/** The comment that attaches a map to a module. */
export function inlineSourceMap(map: string): string {
  return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString("base64")}`;
}
