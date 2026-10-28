# npm packages and Node builtins

Use packages the way you always do: install them, import them.

```sh
npm install ms @types/ms
```

```ts
// tcm: namespace time
import ms from "ms";

/** A duration as words: 90000 → "2m". */
export const short = (millis: number): string => ms(millis);

short(90_000);
```

```text
$ tcm check
scratch.ts → time
  + new       time.short : (millis: number) => string
installing ms@2.1.3

    7 │ short(90_000)
      ⧩ '2m'
```

## Versions

When you add a definition that imports a package, tcm records the package's **compatible range**, as semver
defines it: the major version (`lodash` 4.17.21 → `npm:lodash@4`), the minor below 1.0 (`0.3.7` → `0.3`), or the
exact version for a prerelease. The range is part of the definition's hash:

```text
$ tcm deps time.short
npm:ms@2#default
```

So a definition says what API it was written against, not which patch release happened to be installed. Code
written against `ms` 2 is shareable with any other code on `ms` 2, in this codebase or after a pull into another.

**The codebase runs one version per range.** Its lock (in `codebase.sqlite`) records the exact version for each
package and range, so everything on React 19 runs on the same React 19.x:

- Adding code checked against a newer version in the range moves the lock up to it (newer only adds, by semver).
- A range nothing has locked yet gets the newest version in it whose peer dependencies accept what's already
  locked: React DOM at a version that matches the React it's used with.
- A new major is a different range: code on `lodash` 3 and code on `lodash` 4 run side by side, each on its own
  version.

Each locked version is installed into `.tcm/cache` under an alias for its range (`npm__ms__2`), separately from
your `node_modules`. tcm uses pnpm when it's installed, which keeps one copy of each exact version, peers included,
and npm otherwise. A package without types of its own gets its DefinitelyTyped types (`@types/react`) installed
beside it, at the newest version for the same range.

Only the package you import is pinned, not the packages it depends on.

## Node builtins

`node:fs`, `node:path` and the rest import as usual and aren't versioned. Using one marks code as server-only in
a [web app](apps.md).

## Types

If a package has no types of its own, install its `@types` package, as you would anyway: tcm typechecks
everything you add. tcm installs the same `@types` version beside the pinned package (React's types for
`react@19.3.1`, say), so generated modules and re-checks see the types you wrote against. `@types/node` comes
with tcm, so Node's builtins are typed out of the box.

A package another one installs as a peer (React DOM's `react`) is linked to the pinned copy at the same version,
so there's one instance of it: React's hooks need that.

## Packages in web apps

Browser code can use packages too; Vite bundles them. A package that only works on Node (no browser build, and
it imports Node builtins) makes the code using it run on the server.

## Running things

`tcm run <name> [args...]` runs a definition: functions are called with the arguments (as strings, as on any
command line), the result is awaited and printed.
