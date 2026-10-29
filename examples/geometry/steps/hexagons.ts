// tcm: namespace geo
// A contribution: hexagons. A new case of a union is a breaking change (code that handles every Shape no longer
// does), so the release that brings it is geo 2.0.
import assert from "node:assert/strict";

/** The kinds of {@link area} knows. */
export type Shape = "circle" | "square" | "hexagon";

/**
 * The area of a {@link Shape} of a size: a circle's radius, a square's or a regular hexagon's side.
 *
 * ```ts
 * area("hexagon", 2)
 * ```
 */
export function area(shape: Shape, size: number): number {
  if (shape === "circle") return Math.PI * size * size;
  if (shape === "hexagon") return ((3 * Math.sqrt(3)) / 2) * size * size;
  return size * size;
}

export const testHexagon = () => assert.equal(area("hexagon", 2).toFixed(3), "10.392");
