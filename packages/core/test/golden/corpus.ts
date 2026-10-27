// Golden corpus for IR v4. Hashes of these definitions are pinned in golden.test.ts: if they change,
// the hash format changed, and every stored codebase would need migrating. Don't edit this file.
import { readFileSync } from "node:fs";

export type Pair<A, B = A> = readonly [first: A, second?: B];
export type Keys<T> = { [K in keyof T as `get${Capitalize<string & K>}`]-?: () => T[K] };
export type Unwrap<T> = T extends Promise<infer U> ? Unwrap<U> : T;
export interface Shape {
  readonly kind: "circle" | "square";
  area(): number;
  [extra: string]: unknown;
}

export function first<T>(xs: readonly T[]): T | undefined;
export function first<T>(xs: readonly T[], fallback: T): T;
export function first<T>(xs: readonly T[], fallback?: T): T | undefined {
  return xs.length ? xs[0] : fallback;
}

export const tag = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values);
export const misc = async function* (o?: { a?: { b?: () => number } }) {
  const { a: { b } = {}, ...rest } = o ?? {};
  label: for (const [i, x] of [1n, 0x10, 1e3].entries()) {
    if (typeof x === "bigint") continue label;
    yield (o?.a?.b?.() ?? i) satisfies number;
  }
  yield* [tag`a\n${b}`, `t${rest}`, /re+/g.source, void 0, !!(b as unknown)];
  return readFileSync;
};

export class Counter<T extends number = number> implements Pick<Shape, "kind"> {
  static #instances = 0;
  readonly kind = "circle" as const;
  #n: T;
  declare note?: string;
  constructor(start: T) {
    this.#n = start;
    Counter.#instances++;
  }
  get value(): T {
    return this.#n;
  }
  static {
    Counter.#instances = 0;
  }
}

export function isEven(n: number): boolean { return n === 0 || isOdd(n - 1); }
export function isOdd(n: number): boolean { return n !== 0 && isEven(n - 1); }
