# npm packages and Node builtins

Import a package; that's all. There's no `npm install` and no `package.json` to keep up to date: tcm provides
the package, with its types, from its own cache.

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
installing @types/ms@2.1.0

    7 │ short(90_000)
      ⧩ '2m'
```

Your editor sees the same package: tcm's VS Code extension resolves a scratch file's imports where tcm does.

## Which version a scratch file gets

Each package a scratch file imports gets a [compatible range](#versions) from the code around it:

1. the range used by the codebase definitions the file imports, so a new component beside React 18 components
   gets React 18;
2. else the range used in the file's namespace;
3. else the project's own copy, if `node_modules` has it installed (it's used as is, as before);
4. else the newest range the codebase already runs;
5. else the newest release.

What you save records that range. Other code keeps whatever range it was written against, so two apps in one
codebase can be on different majors of the same package.

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

## Seeing and upgrading packages

`tcm packages` lists what the codebase runs: each package and range, its locked version, and how many
definitions use it.

```text
$ tcm packages
ms         2   2.1.3    1 definition
react      18  18.3.1   2 definitions
react      19  19.3.1   5 definitions
react-dom  19  19.3.1   1 definition
```

**Within a range, `tcm upgrade <package>`** moves the lock to the newest version in each range the package is
used at. Packages built against it (those listing it as a peer dependency: React DOM for React) move along to
versions that accept it, and so do their types. No hash changes, since definitions pin the range; everything that
uses them is typechecked again, and if anything breaks, the lock goes back where it was (`--force` keeps it).

```text
$ tcm upgrade react
  react 19  19.3.1 → 19.4.0
  react-dom 19  19.3.1 → 19.4.0
  6 definition(s) re-checked; no hashes changed
```

**To another range, `tcm upgrade <package>@<range> [namespace]`** (or `@latest`) re-pins the definitions that
use it, in that namespace or everywhere, as an update would: they're re-hashed, dependents follow, and whatever
doesn't typecheck on the new version goes to `tcm todo` and keeps its old one. Packages built against it are
re-pinned to a range that accepts it (React 18 brings React DOM 18). Code you don't upgrade stays where it was,
so one namespace can move to a new major while another stays.

## Types

A package without types of its own gets its DefinitelyTyped package (`@types/react` for `react`) installed beside
it, at the newest version for the same range, so scratch files, generated modules and re-checks see its types.
`@types/node` comes with tcm, so Node's builtins are typed out of the box. A package version with no types
anywhere is untyped, as it would be without tcm: strict code using it doesn't typecheck.

## Packages in web apps

Browser code can use packages too; Vite bundles them. A package that only works on Node (no browser build, and
it imports Node builtins) makes the code using it run on the server.

**An app can't mix ranges of a package others are built against.** One page runs one copy of each package range,
and two copies of React (say) break it: packages built against React expect the one they were given. So when an
app's browser code would use two ranges of a package some other package lists as a peer, the app's plan is an
error naming the definitions on each range, and `tcm upgrade <package>@<range> <namespace>` moves one side over.
Two ranges of any other package are just both shipped, with a warning.

## Running things

`tcm run <name> [args...]` runs a definition: functions are called with the arguments (as strings, as on any
command line), the result is awaited and printed.
