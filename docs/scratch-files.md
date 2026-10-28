# Working in scratch files

Your code lives in the codebase; scratch files are where you write it. This page is the everyday loop: writing,
saving, changing, fixing, renaming and undoing.

## Scratch files

Any `.ts` or `.tsx` file at the top of your codebase directory is a scratch file (`tcm init` makes `scratch.ts`). It's
ordinary TypeScript: your editor checks it, and `node scratch.ts` runs it.

- **Namespaces.** `// tcm: namespace lib.util` as the first line puts the file's definitions under `lib.util`.
  Without it they go at the root. `tcm add --into lib.util` does the same from the command line.
- **Using the codebase.** `import { square } from "#codebase"` imports from the root namespace;
  `#codebase/lib/util` from `lib.util`. Packages and Node builtins import as usual ([packages](packages.md)).
- **Watch expressions.** An expression on its own line, like `square(12)`, is run and its value shown. It's never
  stored. Values are cached by hash; `tcm check --fresh` runs them again (for ones that read files or the clock).
- **What goes in.** Top-level functions, `const`s, classes, types and interfaces each become a definition. `export`
  is optional and makes no difference to tcm. A few things are refused with a reason, like top-level `let` (a
  definition can't change) and enums (Node can't run them); see [what a definition is](hashing.md#what-a-definition-is).

Once code is saved, you can empty or delete the file. Many people keep one scratch file and reuse it.

## Check, add, update

`tcm check` (or `tcm`, which checks every time you save) reports each definition in the file:

| status | meaning | to save it |
|---|---|---|
| `new` | not in the codebase yet | `tcm add` |
| `identical` | already saved, exactly this | nothing to do |
| `update` | the name exists, with different code | `tcm update` |
| `doc` | same code, a new doc comment | `tcm add` or `tcm update` |
| `alias` | this exact code is already saved under another name | `tcm add` gives it a second name |
| `conflict` | the name has several definitions (after a merge) | `tcm resolve`, see [merging](history.md#merging) |

`tcm add` saves new things and never replaces anything: a name that's already taken is skipped with a note.
`tcm update` also replaces, and that's where the codebase does its work.

## When an update breaks something

`tcm update` re-checks everything that uses what you changed. What still typechecks is updated along with it.
What doesn't keeps its old version, so the codebase is never half-changed, and goes on the todo list:

```text
$ tcm update
  ~ update    geo.distance : (a: Point, b: Point, unit: "m" | "km") => number  (was #vwvxl53m)

  1 dependent definition(s) no longer typecheck; see `tcm todo`

$ tcm todo
needs fixing geo.pathLength: Expected 3 arguments, but got 2.

fix with `tcm edit <name>`, change the scratch file, then `tcm update`
```

`tcm edit` writes a definition back into a scratch file, already pointing at the *new* versions of what it uses:

```text
$ tcm edit geo.pathLength
wrote geo.pathLength to scratch.ts
```

```ts
// tcm: namespace geo
import { distance } from "#codebase/geo";
import type { Point } from "#codebase/geo";

/**
 * How far you travel visiting the points in order.
 */
export const pathLength = (ps: Point[]): number => ps.slice(1).reduce((n, p, i) => n + distance(ps[i]!, p), 0)
```

Fix it (here, pass the unit: `distance(ps[i]!, p, "m")`) and update:

```text
$ tcm update
  ~ update    geo.pathLength : (ps: Point[]) => number  (was #3ah7ke6j)

$ tcm todo
nothing to do
```

## Editing what's saved

`tcm edit <name>...` is also how you change anything: it writes definitions into `scratch.ts` (refusing to
overwrite a file with something in it; `--file other.ts` picks another, `--force` overwrites). Edit, then
`tcm update`. You can edit several at once, from different namespaces: each gets a `// tcm: path a.b.c` comment
when its path isn't the file's namespace plus its name, so `update` puts it back where it came from.

## Names

Names are labels; changing them never touches code.

- `tcm mv lib.parse lib.parseConfig` renames a definition, or a whole namespace (`tcm mv lib util`).
- `tcm alias lib.parse lib.read` gives a definition a second name.
- `tcm rm lib.parse` removes a name. If it's the last name of something other definitions use, it refuses unless
  `--force`; those definitions keep working either way.

## Undo

`tcm history` lists every change to names on this branch, newest first, and `tcm reset <id>` goes back to just
after an entry. Code is never deleted, so a reset can always be reset again. `tcm diff` shows what the last
command changed, or what changed since an entry: `tcm diff 12`.

## Browsing

- `tcm ls [namespace]` lists names, with hashes and types.
- `tcm view <name>` shows a definition with current names, and where it runs.
- `tcm find <text>` searches names; `tcm find ':(xs: T[]) => T'` searches by type ([finding code](search.md)).
- `tcm deps <name>` and `tcm dependents <name>` show what it uses and what uses it.
- `tcm docs <name>` shows its documentation ([docs](documentation.md)).

In VS Code, all of this is in the sidebar and in hovers ([editors](editors.md)).
