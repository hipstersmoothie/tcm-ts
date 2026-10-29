// tcm: namespace atlas
// A command-line tool for routes, published as `atlas`, built on `geo`. It's a package of its own (its
// `manifest`), released on its own; what it uses of `geo` comes from geo's releases when it's packed, so the
// `atlas` package depends on `geo` rather than carrying a copy of it.
import assert from "node:assert/strict";
import { distance, type Point } from "#codebase/geo";

/** Route lengths from the command line. */
export const manifest = { name: "atlas", bin: { atlas: "main" } };

/**
 * How far a route goes, visiting its points in order.
 *
 * ```ts
 * length([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }])
 * ```
 */
export const length = (route: Point[]): number => route.slice(1).reduce((n, p, i) => n + distance(route[i]!, p), 0);

/** Read a route from the command line (`0,0 3,4 3,0`). */
export const parseRoute = (args: string[]): Point[] =>
  args.map((a) => {
    const [x, y] = a.split(",").map(Number);
    return { x: x!, y: y! };
  });

/** `atlas 0,0 3,4 3,0`: the route's length. */
export function main(...args: string[]): number {
  if (!args.length) {
    console.error("usage: atlas x,y x,y ...");
    return 2;
  }
  console.log(length(parseRoute(args)).toFixed(2));
  return 0;
}

export const testLength = () => assert.equal(length(parseRoute(["0,0", "3,4", "3,0"])), 9);
