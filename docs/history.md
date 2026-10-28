# History, branches and merging

Names are the only mutable thing in a codebase, so history is a log of name changes.

## Reviewing changes: `ucm diff`

`ucm diff` reviews changes by meaning: what the last command changed, or `ucm diff <id>` since a history entry,
`ucm diff <branch>` against another branch, `ucm diff <a> <b>` between two branches.

- Edits are shown as line diffs, with each side's own names.
- Definitions re-hashed only because a dependency changed are listed separately, with what triggered them.
- Renames and aliases are recognized as such.
- Renaming locals or reformatting doesn't count as a change, because it doesn't change the hash.

## History and undo

- `ucm history [n]` shows the reflog of name changes on this branch.
- `ucm reset <id>` undoes back to an entry. Code is never deleted, so this is always safe; in an app it's also
  how you roll back a deploy ([production](production.md)).

## Branches

`ucm branch [name]` lists or creates branches; `ucm switch <name>` changes branch. A branch is a set of names;
the definitions themselves are shared.

## Merging

`ucm merge <branch>` is a three-way merge of names, against the other branch as of the last merge, sync or fork.

- A name changed on one side takes that side.
- A name changed differently on both sides becomes a conflict, listed by `ucm todo` and settled with
  `ucm resolve <name> <#hash>`.
- A definition only re-hashed because a dependency moved doesn't count as a change.
- Each one-sided update is a patch, so the other side's code is re-derived against it. What no longer
  typechecks goes to `todo`.

## `ucm todo`

Conflicts, plus dependents that stopped typechecking after an update or merge. `ucm edit` them, fix, and
`ucm update`.
