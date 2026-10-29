// Golden corpus: definitions covering most syntax, whose hashes golden.test.ts pins. Changing this file means
// re-pinning them.
import { readFileSync } from "node:fs";
import type * as fs from "node:fs";

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

// `?` and `!` on members, interface `extends` and class `implements` (qualified too), holes in array patterns, and
// strings starting with a byte order mark (TypeScript 7's API used to drop it when decoding)
export interface Opt {
  a?: number;
  b: { c?: string };
  m?(): void;
}
export interface Both extends Opt, fs.ObjectEncodingOptions {}
export class Holder implements Opt, fs.ObjectEncodingOptions, Partial<fs.StatsBase<bigint>> {
  a?: number;
  b!: { c?: string };
  declare d?: string;
  m?(): void {}
  encoding?: null;
  dev?: bigint;
}
export const holes = (xs: readonly number[]) => {
  const [, second, , ...rest] = xs;
  return [second, rest, [, 1]];
};
export const bom = ["\uFEFF", "\uFEFFx", "x"] as const;
