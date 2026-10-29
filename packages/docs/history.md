# History, branches and merging

Names are the only mutable thing in a codebase, so history is a history of namespaces, kept the way Unison keeps
it:

- **A namespace is a tree of hashed nodes.** Each node is hashed from the names in it and the hashes of the nodes
  under it, so one state of all your names has one hash, and a change rewrites only the nodes on its path.
- **A history entry (a causal) is a namespace and the entries it came from.** Its hash is made from just those,
  not from who made it or when, so the same change made from the same point is the same entry, and history has
  the same hashes in every codebase that has it. Each command that changes names makes one entry.
- **A branch points at its latest entry.** Every history starts from the same empty one, so any two codebases
  share an ancestor.

## Reviewing changes: `tcm diff`

`tcm diff` reviews changes by meaning: what the last command changed, or `tcm diff <n|#hash>` since a history
entry, `tcm diff <branch>` against another branch, `tcm diff <a> <b>` between two branches or entries.

- Edits are shown as line diffs, with each side's own names.
- Definitions re-hashed only because a dependency changed are listed separately, with what triggered them.
- Renames and aliases are recognized as such.
- Renaming locals or reformatting doesn't count as a change, because it doesn't change the hash.

## History and undo

```text
$ tcm history 3
#upoceguk   0  2026-10-29 01:08:47  mv geo.distance geo.dist
    geo.dist                     + #ot2b562p
    geo.distance                 - #ot2b562p
#eizpcqxs   1  2026-10-29 01:08:47  update scratch.ts
    geo.distance                 #c5ttv34t → #ot2b562p
    geo.pathLength               #2gf3dz43 → #rphcibxn
#ufvwor4x   2  2026-10-29 01:08:46  add scratch.ts
    geo.pathLength               + #2gf3dz43
```

- `tcm history [n]` shows this branch's latest entries: each one's hash, how many entries back it is, the command
  that made it, and what it changed. A merge is one entry, listing the history it merged.
- `tcm reset <n|#hash>` brings back the names as they were at an entry, as a new entry on top: history is never
  rewritten, so a reset can be reset too, and it's safe after a push. Code is never deleted. In an app it's also
  how you roll back a deploy ([production](production.md)).
- An entry is a number (how many back on this branch: `tcm reset 1` undoes the last command) or a hash from any
  branch's history; the `#` is optional, which helps in shells that read `#…` as a comment.

## Branches

`tcm branch [name]` lists or creates branches; `tcm switch <name>` changes branch. A branch is a set of names
(and the history that led to them); the definitions themselves are shared.

## Merging

`tcm merge <branch>` goes by history:

- If this branch already has the other's history, there's nothing to merge.
- If the other branch has this one's, this branch moves to it (a fast-forward, with no merge entry).
- Otherwise it's a three-way merge of names from the best common ancestor of the two histories, recorded as an
  entry with both as parents. The next merge starts from there, in any codebase that has this history, so pulling
  and pushing back and forth never merges the same change twice.

- A name changed on one side takes that side.
- A name changed differently on both sides becomes a conflict, listed by `tcm todo` and settled with
  `tcm resolve <name> <#hash>`.
- A definition only re-hashed because a dependency moved doesn't count as a change.
- Each one-sided update is a patch, so the other side's code is re-derived against it. What no longer
  typechecks goes to `todo`.

## `tcm todo`

Conflicts, plus dependents that stopped typechecking after an update or merge. `tcm edit` them, fix, and
`tcm update`.
