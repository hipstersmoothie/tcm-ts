// tcm: namespace geo
// A small geometry library, published to npm as `geo`. The `manifest` below is what makes this namespace a
// package: tcm releases it, works out each release's version from what changed in what it exports, writes the
// list of changes in its notes, and packs it.
import assert from "node:assert/strict";

/** Points, distances and shapes on a plane. */
export const manifest = { name: "geo" };

/** A point on a plane. */
export interface Point {
  x: number;
  y: number;
}

/** The kinds of {@link area} knows. */
export type Shape = "circle" | "square";

/**
 * The distance between two points.
 *
 * ```ts
 * distance({ x: 0, y: 0 }, { x: 3, y: 4 })
 * ```
 */
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The area of a {@link Shape} of a size: a circle's radius, a square's side.
 *
 * ```ts
 * area("square", 3)
 * ```
 */
export function area(shape: Shape, size: number): number {
  return shape === "circle" ? Math.PI * size * size : size * size;
}

export const testDistance = () => assert.equal(distance({ x: 1, y: 1 }, { x: 4, y: 5 }), 5);
export const testArea = () => assert.equal(area("square", 3), 9);
