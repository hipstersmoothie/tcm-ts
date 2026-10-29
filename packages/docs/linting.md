# Linting

tcm lints with [oxlint](https://oxc.rs/docs/guide/usage/linter), with nothing to install or configure. It runs:

- on scratch files: in VS Code as diagnostics (source `oxlint`) as you type, and in `tcm check`;
- on what you save: `tcm add` and `tcm update` show the findings in the definitions being saved, and a rule set
  to `"error"` stops the save;
- on the codebase: `tcm lint [namespace]`.

`tcm check` and saving look only at code that's new or changed. A definition in a cycle with one you changed is
saved with it and re-hashed, but its code is as it was, so it isn't linted.

```text
$ tcm lint
ui.Pic #uds7r4nm
  2:10  warning  Missing `alt` attribute. jsx-a11y(alt-text)
    return <img src={src} />;
    Must have `alt` prop, either with meaningful text, or an empty string for decorative images.
no errors, 1 warning(s) in 12 definition(s) (11 cached)
```

Positions are in the definition as `tcm view` shows it. `tcm lint` exits with 1 when there are errors.

## Cached by hash

A definition's findings depend only on its code, the linter's version and the configuration, so they're cached
by those: linting a whole codebase lints what's new. Changing the configuration or upgrading oxlint
(`tcm upgrade oxlint`; it's in the lock like any package) lints everything again. `--fresh` re-lints regardless.

## What's checked

oxlint's correctness rules, as warnings, plus its plugins for what the code uses:

| the code | adds |
|---|---|
| any | `typescript`, `unicorn`, `oxc` |
| JSX | `react`, `jsx-a11y` |
| tests | `vitest` |
| Node builtins (`node:fs`, …) | `node` |

## lint.config

A definition at `lint.config` configures it. Its value is oxlint configuration: `rules`, `categories`,
`plugins` (oxlint's built-in ones) and `settings`.

```ts
// tcm: namespace lint
import noOnlyTests from "eslint-plugin-no-only-tests";

export const config = {
  jsPlugins: [noOnlyTests],
  categories: { suspicious: "warn" },
  rules: { "no-debugger": "error", "no-only-tests/no-only-tests": "error" },
};
```

**Plugins are imports.** The packages `lint.config` imports are its JS plugins (ESLint-compatible ones;
[oxlint's JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)). List them under `jsPlugins`, so the
import counts as used. Like any import they're provided, pinned and upgraded by tcm. Since the configuration
is a definition, changing it is an update, and its history is the codebase's.
