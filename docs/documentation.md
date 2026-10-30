# Writing docs that can't go stale

Definitions are documented with ordinary JSDoc. As in Unison, where docs are code, tcm treats the parts of a doc
that name code as code: they're resolved to hashes when the definition is added, so they follow renames and
updates, and examples are typechecked and run.

```ts
/**
 * The sum of the {@link square}s of some numbers.
 *
 * {@signature square}
 *
 * ```ts
 * sumSquares([1, 2, 3])
 * ```
 */
export const sumSquares = (xs: number[]): number => xs.map(square).reduce((a, b) => a + b, 0);
```

`tcm docs lib.sumSquares` shows it rendered, with the example evaluated:

````
The sum of the `square`s of some numbers.

`square : (x: number) => number`

```ts
sumSquares([1, 2, 3])
```

```text
⧩ 14
```
````

## What a doc can contain

| syntax | |
|---|---|
| `{@link square}`, `{@link lib.square}` | a link, shown as the definition's current name (its shortest unambiguous suffix, like `square`) |
| `{@link square \| the square}`, `{@link square the square}` | a link with its own text |
| `{@linkcode square}` | a link shown as code |
| `{@signature square}` | the definition's name and type |
| `{@source square}` | the definition's source, as a code block |
| a ```` ```ts ```` block | an **example**: typechecked and run top to bottom, every statement in order; each top-level expression's value is shown after the block (strings as their text), so steps that matter only for their effect are best written as `const`s. Examples can use what the definition's file imports: other definitions, packages, Node builtins, `#tcm/server` (server code runs in memory, as in tests). Other code blocks are just text |
| `@param`, `@returns`, `@throws`, `@see`, `@example`, `@deprecated` | JSDoc's block tags, rendered as a Parameters list, headed paragraphs, and a warning for `@deprecated` |

Everything else is markdown: headings, lists, tables, emphasis.

## How it stays current

- **Names are resolved when the definition is added.** A link's name, and every name an example uses, is looked up
  where the definition is (its imports and the definitions beside it), or as a codebase path (`lib.square`), and
  stored by hash with the doc. A name that doesn't resolve in a link is a warning at `tcm add`; in an example it's
  left as written (it may be a global, like `Math`).
- **Renames are free.** The doc shows whatever the definition is called now, in prose, signatures and examples.
- **Updates carry through.** A doc refers to definitions by hash, and following `tcm update`'s patches, it always
  shows and runs the newest version, as a Unison doc term is re-derived when what it uses changes. When `update`
  re-derives a dependent, the dependent keeps its doc.
- **Examples run against current code,** each as a small scratch module that imports what it uses. Their
  values are cached by hash, keyed by the whole example (every statement's hash), so a change to any step, or to
  anything a step uses, runs it again.
- **Broken examples are reported.** After `tcm add` and `tcm update`, the examples in the docs just saved, and in
  any doc naming something that has been replaced, must still typecheck. Those that don't are listed:

  ```
  ! lib.show: doc example: Argument of type 'number' is not assignable to parameter of type 'string'.
  ```

  The rendered doc shows such an example with the reason. (`tcm import` doesn't check docs: a library's
  examples are usually written for readers, not as code that typechecks on its own.)

Docs are metadata: they're not part of a definition's hash, so editing a doc doesn't change the code's identity.

## Namespace READMEs

A definition named `README` in a namespace is that namespace's front page, as in Unison. A type alias carries a
doc and nothing else:

```ts
/**
 * # Polls
 *
 * A live polling app. Start with {@link main}.
 */
export type README = never;
```

The editor shows it at the top of the namespace's page ([editors](editors.md#pages)).

## Where docs are shown

- `tcm docs <name>` in the terminal (markdown, examples evaluated);
- hovers in the editor (rendered, examples shown but not run);
- definition and namespace pages in VS Code, with links you can click ([editors](editors.md#pages)).
