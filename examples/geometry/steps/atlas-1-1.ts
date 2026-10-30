// tcm: namespace atlas
// atlas 1.1: round trips. An addition.
import { perimeter, type Point } from "#codebase/geo";

/**
 * How far a route goes if it comes back to where it started.
 *
 * ```ts
 * roundTrip([{ x: 0, y: 0 }, { x: 3, y: 4 }])
 * ```
 */
export const roundTrip = (route: Point[]): number => perimeter(route);
