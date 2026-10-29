# Releases and changelogs

A release names a point in a package's history as a version, for good, as on Unison Share. Its notes are
markdown kept in the codebase, and the part that lists what changed is written by tcm from the codebase, so
it can't be wrong or leave something out. The version is decided the same way: semver checks, in the manner
of [cargo-semver-checks](https://github.com/obi1kenobi/cargo-semver-checks), find what changed in the package's
API since its last release and what that calls for. A codebase can hold any number of
[packages](publishing.md#packages), each with its own releases.

```text
$ tcm release check geo
geo's next release: 0.2.0 (after 0.1.0): breaking changes

  major  geo.Point has a new required property: label
         type_required_property_added: values written for the old type lack it

  minor  geo.distance takes a new optional parameter: digits
         function_optional_parameter_added: old calls still work

$ tcm release geo
released geo@0.2.0 as #nbbd6qqu, after 0.1.0: breaking changes

## 0.2.0 (2026-10-29)

### Breaking changes

- `geo.Point` has a new required property: `label`

### Extended

- `geo.distance` takes a new optional parameter: `digits`
```

## Making a release

- **`tcm release [package]`** releases a package at the version its changes call for. The package's name can be
  left out when the codebase has one. Its first release is `0.1.0`.
- **`tcm release <package>@<version>`** releases at a version further than that, `1.0.0` say, to declare an API
  stable. A version smaller than the changes call for is refused (`--force` releases anyway).
- **`tcm release check [package]`** shows what the next release would be and why: each finding, the lint it
  trips, and what it means for the code using the package.
- A release is refused while the package has work left in [`tcm todo`](history.md#tcm-todo): conflicts, or
  definitions that stopped typechecking (`--force` releases anyway).
- **Releases don't change.** A version names one release; making it again is refused, and so is syncing with a
  codebase that has a different one under the same version.
- **Releases sync** with [`tcm push` and `tcm pull`](sync.md), with the history they name.
- `tcm diff` and `tcm reset` take a release (`tcm diff geo@0.1.0`) wherever they take a history entry, and
  `tcm pack geo@0.2.0` packs one ([publishing](publishing.md)); `tcm pack geo` on a branch exactly at a release
  packs it as that release.

## Releases kept in git

A codebase that [mirrors](importing.md#mirrors) a directory in a git repository can be made again from its
files, so its releases are kept with them. Releasing records the release in `tcm-releases.json` in the mirrored
directory (its version, notes, author and date, and the commit holding the files as released), and is refused
while the mirror has changes git doesn't have yet. Commit the record with the files.

A codebase linked to the mirror afresh (`tcm import <dir> --into ns --mirror`) makes the recorded releases again
before importing the files as they are: each one's commit is taken from git and imported, in order, and the
release is put at the history entry that makes, with its notes as they were. Hashes don't depend on where or when
code is imported, so the releases name the same definitions they did, and the next release's semver checks
compare against them.

## Release notes

A release's notes are a heading, a summary people write, and the list of changes tcm writes:

- **Breaking changes, Added, Extended, Changed:** what the semver checks found, by name. An addition shows its
  signature and the first sentence of its documentation. A definition that only changed because something it uses
  did (re-hashed, code untouched) isn't listed again.
- **Contributions:** the [contributions](contributions.md) merged since the last release that changed this
  package. They're read from this codebase and from `origin` (or `--remote <name>`), wherever they were merged.

To write the summary, draft the release first:

```text
$ tcm release geo --draft
wrote release-geo.md (geo's next release, 0.2.0 as things stand): write what it's about above the marker, then `tcm release geo`; the changes below the marker are regenerated
```

`release-geo.md` is a markdown scratch file: write above the marker, and `tcm release geo` takes your words from
it (and deletes it; they're in the release now). Everything below the marker is written again from the codebase
when the release is made, so editing it changes nothing, and changes made since the draft are in. `--notes <file>`
takes the summary from another file.

## Changelogs

`tcm changelog [package]` prints a package's releases' notes, newest first, as markdown; `--out CHANGELOG.md`
writes it to a file. `tcm pack` puts it in the package as `CHANGELOG.md`. The changelog is made from the releases,
so it's never edited by hand and never out of date. `tcm releases` lists every package and its releases.

## Semver checks

The checks compare each changed definition the package exports, as it was at the last release and as it is now,
with the TypeScript checker, from the side of the code that uses it: every use that typechecked against the old
version must still. A function that gains an optional parameter is extended (old calls still work); one that
gains a required parameter, or accepts less for a parameter, or can return more, is breaking. Types are compared
by their cases and properties, and as a whole.

The version they call for follows semver, as npm and Cargo read it: from `1.0.0`, a major release for breaking
changes, a minor one for additions and extensions, and a patch otherwise. Before `1.0.0`, a minor release for
breaking changes and a patch for anything else.

| Lint | Calls for | Finding | What it means for code using it |
|---|---|---|---|
| `definition_removed` | major | removed | code that uses it no longer compiles |
| `definition_renamed` | major | renamed | code that imports it by its old name no longer compiles |
| `export_moved` | major | is exported from a different subpath | imports of it from the old one no longer compile |
| `bin_removed` | major | command removed | scripts that run it fail |
| `bin_added` | minor | command added | new API |
| `kind_changed` | major | is now a type rather than a value, or the other way around | code that uses it the old way no longer compiles |
| `function_became_value` | major | can't be called any more | calls to it no longer compile |
| `function_required_parameter_added` | major | takes a required parameter it didn't | calls written for the old version are missing an argument |
| `function_parameter_removed` | major | takes fewer parameters | calls that pass the removed argument no longer compile |
| `function_parameter_made_required` | major | requires a parameter that was optional | calls that leave it out no longer compile |
| `function_parameter_type_narrowed` | major | accepts less for a parameter | arguments the old version accepted may not be accepted |
| `function_return_type_widened` | major | can return more kinds of value | callers may get a value they don't handle |
| `function_type_parameter_count_changed` | major | has a different number of type parameters | explicit type arguments no longer match |
| `function_signature_incompatible` | major | has a signature old calls don't fit | some calls written for the old version no longer compile |
| `constructor_incompatible` | major | is constructed differently | `new` written for the old version no longer compiles |
| `value_type_widened` | major | can hold more kinds of value | code reading it may get a value it doesn't handle |
| `type_property_removed` | major | lost a property | code reading the property no longer compiles |
| `type_required_property_added` | major | has a new required property | values written for the old type lack it |
| `type_property_made_optional` | major | has a property that may now be missing | code reading it may get undefined |
| `type_property_made_required` | major | requires a property that was optional | values written for the old type may lack it |
| `type_property_made_readonly` | major | has a property that's now readonly | code assigning to it no longer compiles |
| `type_property_type_changed` | major | has a property of a different type | code reading or writing the property may no longer compile |
| `type_union_member_added` | major | has a new case | code handling every case no longer does |
| `type_union_member_removed` | major | lost a case | values of the removed case no longer fit |
| `type_type_parameter_count_changed` | major | has a different number of type parameters | uses with type arguments no longer match |
| `type_changed` | major | changed | code using it may no longer compile |
| `definition_added` | minor | added | new API |
| `function_optional_parameter_added` | minor | takes a new optional parameter | old calls still work |
| `function_parameter_made_optional` | minor | no longer requires a parameter | old calls still work |
| `function_parameter_type_widened` | minor | accepts more for a parameter | old calls still work |
| `function_return_type_narrowed` | minor | returns a narrower type | what old callers expect still fits |
| `function_signature_extended` | minor | accepts more (a new overload, say) | old calls still work |
| `value_type_narrowed` | minor | holds a narrower type | what old readers expect still fits |
| `type_optional_property_added` | minor | has a new optional property | old values still fit |
| `type_property_made_writable` | minor | has a property that's no longer readonly | old uses still work |
| `implementation_changed` | patch | changed, with the same API | uses still compile; behaviour may differ |

A change to a type the API mentions shows where the type is, and isn't repeated at each definition that uses it.
Behaviour isn't checked: a definition whose code changed with the same API is a patch, `implementation_changed`.
Release at a higher version when a change in behaviour deserves one.
