// tcm: namespace geo
// geo 1.1: a new definition, and an optional parameter. Both are additions: code written for 1.0 still compiles.
import assert from "node:assert/strict";
import type { Point } from "#codebase/geo";

/**
 * The distance between two points, to `digits` decimal places if given.
 *
 * ```ts
 * distance({ x: 0, y: 0 }, { x: 1, y: 1 }, 3)
 * ```
 */
export const distance = (a: Point, b: Point, digits?: number): number => {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return digits === undefined ? d : Number(d.toFixed(digits));
};

/**
 * How far it is around a closed shape's corners.
 *
 * ```ts
 * perimeter([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }])
 * ```
 */
export const perimeter = (corners: Point[]): number => corners.reduce((n, p, i) => n + distance(p, corners[(i + 1) % corners.length]!), 0);

export const testPerimeter = () => assert.equal(perimeter([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }]), 12);
