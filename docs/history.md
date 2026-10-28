# History, branches and merging

Names are the only mutable thing in a codebase, so history is a log of name changes.

## Reviewing changes: `tcm diff`

`tcm diff` reviews changes by meaning: what the last command changed, or `tcm diff <id>` since a history entry,
`tcm diff <branch>` against another branch, `tcm diff <a> <b>` between two branches.

- Edits are shown as line diffs, with each side's own names.
- Definitions re-hashed only because a dependency changed are listed separately, with what triggered them.
- Renames and aliases are recognized as such.
- Renaming locals or reformatting doesn't count as a change, because it doesn't change the hash.

## History and undo

- `tcm history [n]` shows the reflog of name changes on this branch.
- `tcm reset <id>` undoes back to an entry. Code is never deleted, so this is always safe; in an app it's also
  how you roll back a deploy ([production](production.md)).

## Branches

`tcm branch [name]` lists or creates branches; `tcm switch <name>` changes branch. A branch is a set of names;
the definitions themselves are shared.

## Merging

`tcm merge <branch>` is a three-way merge of names, against the other branch as of the last merge, sync or fork.

- A name changed on one side takes that side.
- A name changed differently on both sides becomes a conflict, listed by `tcm todo` and settled with
  `tcm resolve <name> <#hash>`.
- A definition only re-hashed because a dependency moved doesn't count as a change.
- Each one-sided update is a patch, so the other side's code is re-derived against it. What no longer
  typechecks goes to `todo`.

## `tcm todo`

Conflicts, plus dependents that stopped typechecking after an update or merge. `tcm edit` them, fix, and
`tcm update`.
