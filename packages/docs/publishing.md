# Publishing to npm

Code in a codebase is definitions, not files, so there's nothing to point `npm publish` at. `tcm pack` makes
the package: the definitions it exports and everything they use, compiled to JavaScript with type declarations,
with entry points that export them by name and a `package.json` that depends on the packages they import.

## Packages

A definition named `manifest` makes its namespace a package. A codebase can hold any number:

```ts
// tcm: namespace greet
import escape from "escape-string-regexp";

/** Greetings, and patterns that find them. */
export const manifest = { name: "greeter", bin: { greeter: "main" } };

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
$ tcm release greeter
released greeter@0.1.0 as #pnlegqdu: its first release
$ tcm pack greeter@0.1.0
packed greeter@0.1.0 into .tcm/pack/greeter: 4 module(s), depends on escape-string-regexp
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

The manifest is a definition like any other: hashed, in the history, diffed and reviewed in
[contributions](contributions.md). Names in it are relative to its namespace, so `tcm mv greet hello` takes the
package along. A `manifest` at the root makes the whole codebase one package.

| Field | |
|---|---|
| `name` | the npm package's name |
| `exports` | subpath (`"."`, `"./ui"`) → names under the namespace whose definitions it exports (`""` is all of it). Default `{ ".": "" }` |
| `bin` | command → the definition it runs |
| `with` | packages the code needs but doesn't import, like `@types/node@^24` |
| `files` | files to copy in, relative to the codebase root (a README, a licence) |
| `suites` | command → namespaces of test definitions that run it, relative to the package's: `tcm test` runs them as programs ([suites](testing.md#suites-testing-a-command-as-a-program)). Not packed |
| `description` | defaults to the first paragraph of the manifest's doc comment |

A package's own definitions are its namespace's, except for packages nested in it (their namespaces are theirs),
tests, tool configs and the manifest. Its [releases](releases.md) are its own too: their versions come from what
changed in what it exports, and their notes are its changelog.

- **`tcm pack <package>@<version>`** packs a release: its definitions as they were, at its version, with its
  `CHANGELOG.md`.
- **`tcm pack <package>`** packs it as it is on the branch, at version `0.0.0`.

### Packages that use each other

When one package uses definitions another exports (an app's package using a library's, say), it depends on the
other's oldest release that has those exact definitions (the widest range it works with), and imports them from it: `"geo": "^0.2.0"` in its
`package.json`, `import { distance } from "geo"` in its modules. It doesn't carry a copy, which would duplicate code
and break `instanceof` across the two. If it uses something no release of the other exports as it is (changed since
its last release, or not exported), packing it is refused: release the other first.

## Packing definitions directly

Without a manifest, `tcm pack` takes the definitions on the command line:
`tcm pack greet ui=ui --name greeter@1.2.0 --bin greeter=greet.main --files README.md`.

## What goes in

In a manifest, or on the command line:


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

tcm itself is packed this way: `pnpm verify` makes tcm's package from tcm's own codebase, and the test suite
passes against it ([developing](developing.md#verifying-a-change)).
