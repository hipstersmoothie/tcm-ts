# Tutorial: your first codebase

This takes about fifteen minutes. You'll write a few functions, add them to a codebase, change one and watch the
change carry through, rename things, undo, and add a test and a doc. Every command's output below is what ucm
actually prints.

Start in an empty directory, with ucm [installed](getting-started.md):

```sh
mkdir tutorial && cd tutorial
ucm init
```

## Write something

`ucm init` made a `scratch.ts`. It's an ordinary TypeScript file:

```ts
/** Square a number. */
export const square = (x: number): number => x * x;

square(12);
```

Ask ucm what it thinks of it:

```text
$ ucm check
scratch.ts
  + new       square : (x: number) => number

    7 │ square(12)
      ⧩ 144

  run `ucm add` to save 1 definition
```

Two things happened. `square` is a **new** definition: one the codebase doesn't have yet. And `square(12)`, an
expression on its own, is a **watch expression**: ucm ran it and showed the value. Watch expressions are never
stored; they're for trying things out.

Instead of running `ucm check` each time, you can leave `ucm` (no arguments) running in a terminal: it checks
your scratch files every time you save. In VS Code, the [extension](editors.md) shows the same thing above each
definition as you type.

## Add it

```text
$ ucm add
  + new       square : (x: number) => number
```

`square` is now in the codebase. You could delete it from `scratch.ts` and it would still be there: the
codebase, not the file, is where code lives now. Files are just where you write.

## Namespaces

Replace `scratch.ts` with something a bit bigger:

```ts
// ucm: namespace geo

/** A point on a plane. */
export type Point = { x: number; y: number };

/** The distance between two points. */
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

distance({ x: 0, y: 0 }, { x: 3, y: 4 });
```

The first line puts everything in the file into the `geo` namespace:

```text
$ ucm add
  + new       geo.Point type
  + new       geo.distance : (a: Point, b: Point) => number

$ ucm ls
geo.Point     #no6urvx6  type
geo.distance  #vra42ccj  : (a: Point, b: Point) => number
square        #kor774ja  : (x: number) => number
```

The `#…` after each name is its **hash**, the short form of the hash of its code. The name points at the hash;
the hash is the definition.

## Use what you saved

Your scratch file can import anything in the codebase from `#codebase`, the root namespace, or `#codebase/<ns>`:

```ts
// ucm: namespace geo
import { distance, type Point } from "#codebase/geo";

/** How far you travel visiting the points in order. */
export const pathLength = (ps: Point[]): number => ps.slice(1).reduce((n, p, i) => n + distance(ps[i]!, p), 0);

pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }]);
```

```text
$ ucm add
  + new       geo.pathLength : (ps: Point[]) => number
```

## Change something

Say distances should be rounded to two decimal places. Write the new version of `distance` (the scratch file
only needs what you're changing):

```ts
// ucm: namespace geo
import type { Point } from "#codebase/geo";

/** The distance between two points, to two decimal places. */
export const distance = (a: Point, b: Point): number => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
```

Changing a definition is an **update**:

```text
$ ucm update
  ~ update    geo.distance : (a: Point, b: Point) => number  (was #vra42ccj)
  ~ updated   geo.pathLength (dependent)
```

`pathLength` uses `distance`, so ucm checked it against the new version. It still typechecks, so it was updated
too, automatically. Had it stopped typechecking, it would have kept its old version and gone on your todo list
(`ucm todo`) with the error, for you to fix. A change never leaves the codebase half-updated.

`ucm diff` shows what that did:

```text
$ ucm diff
changes from `update scratch.ts`

  edited
    ~ geo.distance  #vra42ccj → #vwvxl53m
        /**
      -  * The distance between two points.
      +  * The distance between two points, to two decimal places.
         */
      - export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
      + export const distance = (a: Point, b: Point): number => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100

  updated because a dependency changed (code unchanged)
    ~ geo.pathLength  #kuir3xdg → #3ah7ke6j  via geo.distance
```

## Rename something

```text
$ ucm mv geo.distance geo.dist
moved 1 name
  note: geo.dist is still named `distance` at runtime (`.name` is part of its hash); changing that means editing it

$ ucm view geo.pathLength
// geo.pathLength #3ah7ke6j : (ps: Point[]) => number
// runs anywhere
import { dist } from "#codebase/geo";
import type { Point } from "#codebase/geo";

/**
 * How far you travel visiting the points in order.
 */
export const pathLength = (ps: Point[]): number => ps.slice(1).reduce((n, p, i) => n + dist(ps[i]!, p), 0)
```

`pathLength`'s hash didn't change (`#3ah7ke6j`): renaming moved a label, and the code that uses it shows the new
name. There was nothing to find and replace.

(The note is about JavaScript itself: a function's `.name` is visible at runtime, so it's part of the hash, and
`ucm mv` leaves it alone. "runs anywhere" is about web apps: this code doesn't need a server or a browser.)

## Undo

Everything you do is in the history:

```text
$ ucm history 4
   8 2026-10-28 06:21:30  geo.dist                 + #vwvxl53m  mv geo.distance geo.dist
   7 2026-10-28 06:21:30  geo.distance             - #vwvxl53m  mv geo.distance geo.dist
     ·
   6 2026-10-28 06:21:30  geo.pathLength           #kuir3xdg → #3ah7ke6j  update (propagated)
   5 2026-10-28 06:21:29  geo.distance             #vra42ccj → #vwvxl53m  update scratch.ts
```

Go back to how things were after entry 6, before the rename (your numbers may differ):

```text
$ ucm reset 6
undid 2 changes
```

`distance` is called `distance` again. Code is never deleted, so you can always go back.

## Test it

A test is a definition whose name starts with `test`, and it passes if it returns without throwing:

```ts
// ucm: namespace geo
import assert from "node:assert/strict";
import { pathLength } from "#codebase/geo";

export const testPathLength = () => {
  assert.equal(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  assert.equal(pathLength([]), 0);
};
```

```text
$ ucm add
  + new       geo.testPathLength : () => void

$ ucm test
  ✓ geo.testPathLength  2ms

1 passed, 0 failed

$ ucm test
  ✓ geo.testPathLength  (cached)

1 passed, 0 failed (1 cached)
```

The second run didn't run anything. A test's hash covers everything it calls, so its result can't change until
its code, or something it uses, does. Change `distance` again and `ucm test` runs it again.

## Document it

Doc comments can link to definitions and give examples, which ucm runs:

```ts
// ucm: namespace geo
import { distance, type Point } from "#codebase/geo";

/**
 * How far you travel visiting the points in order: the sum of the {@link distance}s between neighbours.
 *
 * ```ts
 * pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }])
 * ```
 */
export const pathLength = (ps: Point[]): number => ps.slice(1).reduce((n, p, i) => n + distance(ps[i]!, p), 0);
```

The code is the same as what's stored, so only the doc changes:

````text
$ ucm update
  ~ doc       geo.pathLength : (ps: Point[]) => number  (doc changed)

$ ucm docs geo.pathLength
How far you travel visiting the points in order: the sum of the `distance`s between neighbours.

```ts
pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }])
```

```text
⧩ 9
```
````

The link and the example's names are stored by hash, like code: rename `distance` and the doc says the new name;
update it and the example runs the new version. If an update breaks an example, `ucm update` says so.

## Find it again

Search by name, or by type:

```text
$ ucm find ':(ps: Point[]) => number'
geo.pathLength  #3ah7ke6j  (ps: Point[]) => number
```

## What you've done

You've used the whole loop: write in a scratch file, `check`, `add`, `update` (with dependents following along),
`mv`, `history` and `reset`, `test`, and docs. Day to day, that's most of ucm.

Next:

- [Your first web app](tutorial-app.md): server and browser code in one codebase.
- [Working in scratch files](scratch-files.md): the daily loop in more detail, including editing existing code
  and fixing what an update broke.
