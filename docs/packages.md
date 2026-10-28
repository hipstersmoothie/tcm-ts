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
installing npm__ms__2.1.3

    7 │ short(90_000)
      ⧩ '2m'
```

## Versions are pinned

When you add a definition that imports a package, tcm records the **exact version** it was checked against, and
that's part of the definition's hash:

```text
$ tcm deps time.short
npm:ms@2.1.3#default
```

So a definition always runs with the version it was written for. Upgrading a package doesn't silently change
saved code: after `npm install ms@3`, the definitions you `update` (or write anew) use 3; the rest keep 2.1.3, and
the two versions live side by side. tcm installs each pinned version into its own cache (`installing
npm__ms__2.1.3`), separately from your `node_modules`.

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
