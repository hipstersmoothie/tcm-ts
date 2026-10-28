# Finding code

## By name or signature text

`ucm find <query>` lists names containing `query`, or whose signature text contains it.

## By type

`ucm find ':<type>'` finds terms by the shape of their type, as Unison's type search does. The query is a
TypeScript type:

```sh
$ ucm find ':(xs: T[]) => T | undefined'
type variables: T
lib.first  #q5xh6tqo  <A>(xs: A[]) => A | undefined
lib.head   #glnvgmf6  <T>(xs: T[]) => T | undefined

$ ucm find ':(n: number, s: string) => string'
lib.repeat  #66hwcb26  (s: string, n: number) => string  arguments reordered

$ ucm find ':(id: string) => User'
lib.loadUser  #sjksocbz  (id: string) => Promise<User>  async
```

- **Type variables.** Names in the query that are neither codebase types nor TypeScript globals become type
  variables, so `(xs: a[]) => a` works like Unison's `[a] -> a`. Explicit generics (`<T>(xs: T[]) => T`) work
  too.
- **Codebase types are found by name:** `User`, or `lib.User` when the short name is ambiguous (ucm says which
  paths it could be).
- **Parameter names don't matter**, nor do type-variable names: `<A>(xs: A[]) => A` and `<T>(ys: T[]) => T` are
  the same shape.

### Ranking

Exact matches (the same type up to renaming) come first. Then, closest first, each labelled:

| label | meaning |
|---|---|
| `arguments reordered` | the same parameters in another order |
| `async` | returns a `Promise` of the queried result type |
| `more specific` | an instance of the query: `sum: (xs: number[]) => number` for `(xs: a[]) => a` |
| `more general` | the query is an instance of it: `last: <T>(xs: T[]) => T` for `(xs: number[]) => number` |
| `partly compared` | parts too deep, or conditional or mapped types, were compared only as "some type" |

Overloads are searched one by one; a function matches through its closest overload.

### How it works

When a term is added, ucm records its type as a *shape* (metadata, not part of the hash): functions,
parameters, arrays, tuples, unions, object types and literals. Type parameters become numbered variables.
Codebase types are referenced **by hash**, so renaming a type (`ucm mv lib.User lib.Person`) doesn't lose any
matches; library types (`Promise`, `Map`, a package's types) by name. Definitions stored before shapes existed
get theirs on the first search.

The query is typechecked against the `#codebase` shim, turned into the same kind of shape, and unified with
each term's: query variables can stand for parts of a definition's type (more specific) and the definition's
variables for parts of the query (more general).
