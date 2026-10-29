# Contributions: reviewing changes

A contribution is a branch proposed for merging into another, as on Unison Share: reviewed as a diff of
definitions rather than text, commented on, and merged on the remote by [history](history.md). Contributions
live in the codebase you [push to](sync.md): a `tcm serve` server, or another codebase directory.

## Proposing a change

Make the change on a branch, then contribute it:

```text
$ tcm branch faster && tcm switch faster
$ tcm update                      # change lib.square, add lib.cube
$ tcm contribute --title "Faster squares" --description "Uses ** now."
pushed origin/faster: 3 names (new branch); sent 3 definition(s)
opened contribution #1 on origin
  review: tcm contribution view 1 · https://tcm.example.com:7737/contributions/1#token=…
```

- **`tcm contribute [remote]`** pushes the current branch (under its own name, or `--as <name>`) and opens a
  contribution of it into `main` (or `--to <branch>`). Without `--title` you're asked at a terminal; elsewhere the
  branch's name is the title.
- **Pushing again updates it:** `tcm contribute` (or `tcm push`) on the same branch moves the open contribution
  to your latest changes.
- From `main` itself there's nothing to propose: make a branch first.

## Reviewing

```text
$ tcm contribution view 1
#1 Faster squares  open
  faster → main · opened by ada 2026-10-29 01:30 · 0 comment(s)

  Uses ** now.

  ✓ merges as a fast-forward

changes on faster since it left main (#2jut5etj)

  edited
    ~ lib.square  #tvtxd4fk → #kndlow5j
      - export const square = (x: number): number => x * x
      + export const square = (x: number): number => x ** 2

  updated because a dependency changed (code unchanged)
    ~ lib.sumSquares  #675kvzb7 → #d72molby  via lib.square

  added
    + lib.cube  #dzuntsd3 : (x: number) => number
```

- **`tcm contribution`** lists the remote's open contributions (`--all` for merged and closed ones too).
- **`tcm contribution view <id>`** shows the changes from where the branch left its target, the way
  [`tcm diff`](history.md#reviewing-changes-tcm-diff) does: edits, what was re-hashed because of them (and
  why), what's added, removed and renamed. Renames and reformatting aren't changes. It also says whether it
  merges: as a fast-forward, cleanly, or with conflicts in which names.
- **`tcm contribution comment <id> <text> [--about <name>]`** comments on the whole change, or on one definition.
- Comments and merges are signed with `$TCM_AUTHOR`, or your user name.

### The review page

`tcm serve` has a page for each contribution, at the link `tcm contribute` prints: the same diff, whether it
merges, the comments, a form to comment (on the whole change or a definition), and buttons to merge or close.
`/contributions` lists them all. The page holds no data itself: the token travels in the link's fragment, which
browsers never send to a server, and stays in that browser.

## Merging

**`tcm contribution merge <id>`** (or the page's button) merges it on the remote, by history:

- a fast-forward if the target hasn't moved since the branch left it;
- otherwise a three-way merge from their common ancestor, recorded with both as parents;
- refused if the two changed the same names differently. Bring the target into the branch, settle the
  conflicts, and push again:

```text
$ tcm contribution merge 3
#3 conflicts with main in lib.square: merge main into b (`tcm pull <remote> main` on that branch), resolve, push, and merge again
$ tcm switch b && tcm pull origin main      # merges origin/main into b
$ tcm resolve lib.square '#…'
$ tcm contribute                             # updated contribution #3
$ tcm contribution merge 3
merged #3 on origin as #mio7i2g5
```

Afterwards `tcm pull` on your `main` fast-forwards to the merge, and the contribution shows what the merge
brought. **`tcm contribution close <id>`** closes one without merging; **`reopen`** opens it again.
