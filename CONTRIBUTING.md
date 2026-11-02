# Contributing

tcm is developed in tcm, so there are no source files here to change: this repository only says how to get tcm's
codebase. A change is a contribution, proposed on tcm's server and reviewed there as definitions, as on Unison
Share. The whole guide is [contributing](https://tcm-server-production.up.railway.app/contributing.html); in short:

```sh
git clone https://github.com/hipstersmoothie/tcm-ts && cd tcm-ts
pnpm tcm status                    # gets tcm and its codebase (into codebase/; no token needed to read)
pnpm tcm remote add origin https://tcm-server-production.up.railway.app --token <your token>
pnpm tcm branch my-change && pnpm tcm switch my-change
# … change it (pnpm tcm patch, or edit and update; an agent works through .mcp.json and AGENTS.md)
TCM_BRANCH=my-change pnpm verify   # everything a change needs (verify reads main unless told)
pnpm tcm contribute --title "What it does" --description "Why"
```

- **A token** is the maintainer's to give: ask for one. It pushes your branches (as `@<handle>/…`) and proposes them.
- **A change is one thing,** with tests (test definitions) and its docs (`tcmts.docs`) updated with it.
- **Only want to use tcm?** [Install it](https://tcm-server-production.up.railway.app/getting-started.html).

More: [developing tcm-ts](https://tcm-server-production.up.railway.app/developing.html) ·
[contributions](https://tcm-server-production.up.railway.app/contributions.html) ·
[AGENTS.md](AGENTS.md)
