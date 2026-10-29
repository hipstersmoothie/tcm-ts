# Publishing to npm

Code in a codebase is definitions, not files, so there's nothing to point `npm publish` at. `tcm pack` makes
the package: the definitions you name and everything they use, compiled to JavaScript with type declarations,
with an entry point that exports them by name and a `package.json` that depends on the packages they import.

```ts
// tcm: namespace greet
import escape from "escape-string-regexp";

export interface Greeting {
  to: string;
  text: string;
}

/** A greeting, and a pattern that finds it. */
export function greet(to: string): Greeting {
  return { to, text: `hello, ${to}` };
}

export const finder = (g: Greeting): RegExp => new RegExp(escape(g.text));

export function main(...names: string[]): number {
  for (const n of names) console.log(greet(n).text);
  return names.length ? 0 : 2;
}
```

```text
$ tcm pack greet --name greeter@1.2.0 --bin greeter=greet.main --files README.md
packed greeter@1.2.0 into .tcm/pack/greeter: 4 module(s), depends on escape-string-regexp
$ cd .tcm/pack/greeter && npm publish
```

Anyone can then use it like any other package:

```ts
import { greet, finder, type Greeting } from "greeter";
```

```text
$ npx greeter Ada
hello, Ada
```

## What goes in

- **Entries** are namespaces or definitions. A namespace exports every definition beneath it, each under its
  last name (`greet.greet` as `greet`). Several entries can share an entry point, and two definitions that would
  be exported under one name are refused; give them separate subpaths. A type and a value can share a name.
- **Subpaths:** `subpath=<entry>` exports from `<package>/<subpath>` instead: `tcm pack greet ui=ui --name greeter`
  makes `greeter` and `greeter/ui`.
- **Bins:** `--bin cmd=<name>` makes a command that runs the definition as [`tcm run`](cli.md) does. A function
  is called with the command's arguments and awaited; a number it returns becomes the exit code, and anything
  else is printed. Separate several bins with commas (`--bin tcm=cli.run,tcm-ts=cli.run`).
- **Modules:** every component the entries and bins need, under its hash (`modules/<hash>.js`, with a `.d.ts`
  beside it). Doc comments go into the declarations, so editors show them on hover.
- **Dependencies** are the packages the code imports, at the versions the codebase has
  [locked](packages.md#versions), along with the DefinitelyTyped types tcm added for packages that ship none
  (`@types/react` beside `react`). A package that's pinned at two ranges, like code on React 18 next to code
  on 19, is installed twice side by side under the cache's aliases (`"npm__react__18": "npm:react@18.3.1"`), and
  each module imports the one it was checked against.
- **`--with pkg[@version],...`** adds packages the code doesn't import but needs anyway, such as ones it loads at
  runtime by name, or `@types/node` when the declarations mention Node's types. Without a version you get the
  locked one if there is one, and `*` otherwise.
- **`--files a,b`** copies files or directories in, such as a README or a licence. They keep their path under the
  codebase root; files from outside it go in by name.
- **`--name <pkg>@<version>`** sets the version, `0.0.0` without one; **`--out`** defaults to `.tcm/pack/<name>`. `--description` fills that field
  of `package.json`. The output directory is replaced each time, so it has to be empty or an earlier pack.

The package is ESM (`"type": "module"`) and needs Node 22.18 or newer, as tcm does.

## What a package can hold

A packed package runs on its own, without tcm. Code that only makes sense under `tcm dev` or `tcm start` packs,
but has no app server to talk to: a server function the browser calls, typed tables and background jobs. Use
an app for those ([apps](apps.md), [deploying](production.md)).

tcm itself is packed this way: `pnpm selfhost` makes tcm's package from tcm's own codebase, and the test suite
passes against it ([developing](developing.md#self-hosting)).
