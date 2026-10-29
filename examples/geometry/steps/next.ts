// tcm: namespace geo
// What's next for geo, not released yet: labelled points, and midpoints. Open the Releases view to see what the
// next release would be, and release-geo.md to write its notes.
import assert from "node:assert/strict";

/** A point on a plane, with a label to show by it. */
export interface Point {
  x: number;
  y: number;
  label?: string;
}

/**
 * The point halfway between two points.
 *
 * ```ts
 * midpoint({ x: 0, y: 0 }, { x: 4, y: 2 })
 * ```
 */
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const testMidpoint = () => assert.deepEqual(midpoint({ x: 0, y: 0 }, { x: 4, y: 2 }), { x: 2, y: 1 });
