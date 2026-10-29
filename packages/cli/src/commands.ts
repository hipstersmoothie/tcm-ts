// The command line, declared once: every command, argument and option as a @bomb.sh/router route tree. Parsing
// gives main() a typed intent per command; help, usage errors and shell completions (@bomb.sh/tab) are all read
// from the same tree, so they can't drift from what the commands accept.
import { argument, command, description, multiple, name, option, schema, toggle, version } from "@bomb.sh/router";
import { IR_VERSION, TS_VERSION } from "@tcm/core";

/** A Standard Schema (what router validates and types parameters with), for the few shapes tcm's take. */
interface Schema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: T } | { readonly issues: readonly { readonly message: string }[] };
    readonly types?: { readonly input: unknown; readonly output: T };
  };
}
const valid = <T>(validate: (value: unknown) => { value: T } | { issues: { message: string }[] }): Schema<T> => ({ "~standard": { version: 1, vendor: "tcm", validate } });

/** Text; required unless there's a default. */
function text(): Schema<string>;
function text(fallback: string): Schema<string>;
function text(fallback: undefined | null): Schema<string | undefined>;
function text(fallback?: string | null): Schema<string | undefined> {
  return valid((v) => (typeof v === "string" ? { value: v } : v === undefined && fallback !== undefined ? { value: fallback ?? undefined } : { issues: [{ message: "required" }] }));
}
/** Any number of words (a variadic argument). */
const words = valid<string[]>((v) => ({ value: Array.isArray(v) ? v.map(String) : [] }));
/** A comma-separated list (`--with a,b`). */
const list = valid<string[]>((v) => ({ value: typeof v === "string" ? v.split(",").filter(Boolean) : [] }));
/** A whole number; optional with a default, or with `null` for none. */
function count(fallback: number): Schema<number>;
function count(fallback: null): Schema<number | undefined>;
function count(fallback?: number | null): Schema<number | undefined> {
  return valid((v) => {
    if (v === undefined) return fallback === undefined ? { issues: [{ message: "required" }] } : { value: fallback ?? undefined };
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? { value: n } : { issues: [{ message: `expected a whole number, not '${String(v)}'` }] };
  });
}
/** A toggle that's on unless turned off (`--no-run`). */
const on = valid<boolean>((v) => ({ value: v === undefined ? true : Boolean(v) }));

const into = option(name("into"), description("the namespace to save into (default: the file's `// tcm: namespace` pragma)"), schema(text(null)));
const fresh = toggle(name("fresh"), description("re-run watch expressions and tests even when their results are cached"));
const force = (what: string) => toggle(name("force"), description(what));
const file = argument(name("file"), description("a scratch file"), schema(text("scratch.ts")));
const namespace = (what: string) => argument(name("namespace"), description(what), schema(text(null)));
const definition = (what = "a name or #hash") => argument(name("name"), description(what), schema(text(null)));
const port = (n: number) => option(name("port"), description("port to listen on"), schema(count(n)));
const http = option(name("http"), description("serve a namespace's functions as HTTP endpoints: <namespace>[=/prefix]"), schema(text(null)));
const tls = [
  toggle(name("tls"), description("serve HTTPS; without --tls-cert, with a self-signed certificate")),
  option(name("tls-cert"), description("certificate file (PEM)"), schema(text(null))),
  option(name("tls-key"), description("private key file (PEM)"), schema(text(null))),
] as const;

/** `tcm` alone: watch. */
const remote = option(name("remote"), description("the remote it's on"), schema(text("origin")));
const contributionId = argument(name("id"), description("its number (see tcm contribution)"), schema(count(null)));

export const root = command(name("tcm"), description("a content-addressed codebase manager for TypeScript"), version(`hash format v${IR_VERSION}, TypeScript ${TS_VERSION}`), fresh, into);

/**
 * Every command, by name, each its own route tree: parsing one command's arguments has a type TypeScript can
 * work out (the union of every route's intents, for all of tcm at once, is too deep for it).
 */
export const commands = {
  init: command(name("init"), description("set up a codebase in this directory")),
  watch: command(name("watch"), description("watch scratch files: typecheck, hash, evaluate watch expressions and tests (the default command)"), fresh, into),
  check: command(name("check"), description("one-shot version of watch"), file, fresh, into),
  add: command(name("add"), description("save new definitions from a scratch file"), file, into),
  update: command(name("update"), description("save, and replace changed definitions; dependents are re-hashed"), file, into),
  import: command(
    name("import"),
    description("add an existing project: one namespace per file"),
    argument(name("dir"), description("the project's directory"), schema(text())),
    into,
    toggle(name("update"), description("replace definitions that changed since an earlier import")),
    option(name("exclude"), description("paths to skip, comma-separated"), schema(list)),
    toggle(name("verbose"), description("report every definition")),
    toggle(name("tests"), description("also import test/ and tests/ directories of test definitions (*.test.ts files stay skipped)")),
    toggle(name("mirror"), description("keep the directory in step with the codebase: changes made in tcm are written back to its files")),
  ),
  mirror: command(
    name("mirror"),
    description("the directory this codebase writes its changes back to (see `tcm import --mirror`)"),
    toggle(name("check"), description("re-analyze the files: they must hash to what the codebase holds")),
    toggle(name("unlink"), description("stop writing back; the files stay as they are")),
  ),
  edit: command(name("edit"), description("write definitions to a scratch file for editing"), argument(name("names"), description("names or #hashes"), multiple(), schema(words)), option(name("file"), description("the scratch file (default scratch.ts, or scratch.tsx for JSX)"), schema(text(null))), force("overwrite a scratch file that has unsaved definitions")),
  view: command(name("view"), description("show definitions with current names"), argument(name("names"), description("names or #hashes"), multiple(), schema(words))),
  ls: command(name("ls"), description("list names"), namespace("a namespace (default: everything)")),
  find: command(name("find"), description("search names and signatures; ':<type>' searches by type, e.g. ':(xs: T[]) => T'"), argument(name("query"), description("words, or :<type>"), multiple(), schema(words))),
  deps: command(name("deps"), description("what a definition uses"), definition()),
  dependents: command(name("dependents"), description("what uses a definition"), definition()),
  docs: command(name("docs"), description("show a definition's documentation, examples evaluated"), definition()),
  run: command(
    name("run"),
    description("run a definition: a function is called with the arguments (after `--` they can start with -)"),
    definition("a name or #hash"),
    argument(name("args"), description("arguments for it"), multiple(), schema(words)),
    option(name("on"), description("run on a remote, URL or codebase directory instead"), schema(text(null))),
  ),
  mv: command(name("mv"), description("rename a definition or namespace (no code changes)"), argument(name("from"), description("a name or namespace"), schema(text(null))), argument(name("to"), description("its new name"), schema(text(null)))),
  alias: command(name("alias"), description("add another name for a definition"), definition(), argument(name("to"), description("the new name"), schema(text(null)))),
  rm: command(name("rm"), description("remove a name"), definition("a name"), force("remove it even if named definitions use it (they keep working)")),
  todo: command(name("todo"), description("conflicts and dependents that need fixing")),
  resolve: command(name("resolve"), description("pick one definition for a conflicted name"), definition("a conflicted name"), argument(name("hash"), description("the #hash to keep"), schema(text(null)))),
  test: command(
    name("test"),
    description("run tests (definitions named test… or under `tests`), and the suites packages declare; results are cached by hash, and by the code a suite ran"),
    namespace("only tests under this namespace"),
    fresh,
    toggle(name("definitions"), description("only the test definitions, not the suites")),
  ),
  lint: command(name("lint"), description("lint definitions with oxlint (configure with a `lint.config` definition)"), namespace("only definitions under this namespace"), fresh),
  fmt: command(name("fmt"), description("reformat stored definitions with oxfmt; no hashes change"), namespace("only definitions under this namespace")),
  verify: command(name("verify"), description("re-render and re-hash every live definition; must be the identity")),
  packages: command(name("packages"), description("the npm packages the codebase runs: range, locked version, what uses them")),
  upgrade: command(
    name("upgrade"),
    description("newest versions within the ranges in use; <pkg>@<range|latest> re-pins code to another range"),
    argument(name("package"), description("<pkg>, or <pkg>@<range|latest>"), schema(text(null))),
    namespace("with a range: only re-pin code under this namespace"),
    force("upgrade even if something built against it can't follow"),
  ),
  release: command(
    name("release"),
    description("release a package: its version and its notes' list of changes come from what changed in its API"),
    argument(name("package"), description("<package>[@version], a version past what the changes call for (1.0.0, say); with one package, just @version or nothing"), schema(text(null))),
    toggle(name("draft"), description("write release-<package>.md to write a summary in, instead of releasing")),
    option(name("notes"), description("a markdown file with the summary (default: the draft, if there is one)"), schema(text(null))),
    option(name("remote"), description("where the contributions it brings are (default origin, if there is one)"), schema(text(null))),
    force("release anyway: past a version step too small for the changes, or with work left in tcm todo"),
    command(name("check"), description("what a package's next release would be, and why: each API change, the lint it trips, what it means"), argument(name("package"), description("a package (default: the only one)"), schema(text(null)))),
    command(name("view"), description("a release's notes"), argument(name("release"), description("<package>@<version> (or @<version>, with one package)"), schema(text(null)))),
  ),
  releases: command(name("releases"), description("the codebase's packages and their releases, newest first"), argument(name("package"), description("only this package"), schema(text(null)))),
  changelog: command(
    name("changelog"),
    description("a package's releases' notes, newest first, as markdown"),
    argument(name("package"), description("a package (default: the only one)"), schema(text(null))),
    option(name("out"), description("write it to this file (CHANGELOG.md, say)"), schema(text(null))),
  ),
  pack: command(
    name("pack"),
    description("make an npm package: a package (<package>[@version], from its manifest), or definitions given here"),
    argument(name("entries"), description("<package>[@version], or [subpath=]<namespace|name>... with --name"), multiple(), schema(words)),
    option(name("name"), description("the package's name, and version: <pkg>[@version] (default version 0.0.0)"), schema(text(null))),
    option(name("description"), description("its description"), schema(text(null))),
    option(name("bin"), description("commands, comma-separated: cmd=<name>"), schema(list)),
    option(name("with"), description("more dependencies, comma-separated: pkg[@version]"), schema(list)),
    option(name("files"), description("files to copy in, comma-separated"), schema(list)),
    option(name("out"), description("where to write it (default .tcm/pack/<name>)"), schema(text(null))),
  ),
  diff: command(name("diff"), description("what the last command changed; or since a history entry, to a branch, or between two"), argument(name("refs"), description("<n|#hash> | <branch> | <a> <b> (branches or history entries)"), multiple(), schema(words))),
  history: command(name("history"), description("this branch's history: an entry per command, and what it changed"), argument(name("n"), description("how many"), schema(count(30)))),
  reset: command(name("reset"), description("bring back the names as of a history entry (a new entry: nothing is rewritten)"), argument(name("to"), description("a number, how many entries back (see tcm history), or a #hash"), schema(text(null)))),
  branch: command(name("branch"), description("list branches, or create one from this branch"), argument(name("branch"), description("the new branch's name"), schema(text(null)))),
  switch: command(name("switch"), description("switch to another branch"), argument(name("branch"), description("a branch"), schema(text(null)))),
  merge: command(name("merge"), description("merge another branch's history into this one (three-way from their common ancestor)"), argument(name("branch"), description("the branch to merge"), schema(text(null)))),
  dev: command(name("dev"), description("serve an app from the codebase while you work on it"), argument(name("app"), description("a function or React component"), schema(text(null))), port(5173), http),
  build: command(name("build"), description("production build into .tcm/apps/<hash>/ (reused if it exists)"), argument(name("app"), description("the app"), schema(text(null))), force("build again even if this version was built")),
  start: command(
    name("start"),
    description("serve the app in production; follows its name, so deploying and rolling back are moving the name"),
    argument(name("app"), description("the app"), schema(text(null))),
    port(8080),
    option(name("host"), description("address to listen on"), schema(text("127.0.0.1"))),
    ...tls,
    option(name("keep"), description("earlier builds to keep serving for open tabs"), schema(count(null))),
    http,
  ),
  apps: command(name("apps"), description("list builds (* = current)"), command(name("prune"), description("remove builds but the current one and the newest N others"), option(name("keep"), description("others to keep"), schema(count(3))))),
  data: command(
    name("data"),
    description("typed tables: row counts, or a table's rows"),
    argument(name("table"), description("a table"), schema(text(null))),
    argument(name("n"), description("rows to show"), schema(count(20))),
    command(name("migrate"), description("upgrade every stored row to the current row type now, through migrate"), argument(name("table"), description("a table"), schema(text()))),
  ),
  jobs: command(
    name("jobs"),
    description("background jobs (enqueue() / every() from #tcm/server)"),
    argument(name("n"), description("how many"), schema(count(30))),
    command(name("retry"), description("queue a job again"), argument(name("id"), description("a job id (a prefix is enough)"), schema(text()))),
    command(name("cancel"), description("cancel a queued job"), argument(name("id"), description("a job id (a prefix is enough)"), schema(text()))),
  ),
  remote: command(
    name("remote"),
    description("remotes to push to and pull from: list, add, rm"),
    command(
      name("add"),
      description("add a remote: a tcm serve URL or another codebase directory"),
      argument(name("remote"), description("its name"), schema(text())),
      argument(name("url"), description("a URL or directory"), schema(text())),
      option(name("token"), description("the server's token"), schema(text(null))),
      option(name("fingerprint"), description("pin the server's certificate (sha256)"), schema(text(null))),
    ),
    command(name("rm"), description("remove a remote"), argument(name("remote"), description("its name"), schema(text()))),
  ),
  push: command(
    name("push"),
    description("send this branch's history and move the remote branch to it (only forward: pull first if it has changes you don't)"),
    argument(name("remote"), description("a remote"), schema(text("origin"))),
    option(name("as"), description("the branch to push to"), schema(text(null))),
    force("push even if the remote moved"),
  ),
  pull: command(name("pull"), description("fetch the remote branch's history into <remote>/<branch>; fast-forward this branch, or merge"), argument(name("remote"), description("a remote"), schema(text("origin"))), argument(name("branch"), description("the remote's branch"), schema(text(null)))),
  contribute: command(
    name("contribute"),
    description("propose this branch for merging: push it, and open a contribution on the remote (pushing again updates it)"),
    argument(name("remote"), description("a remote"), schema(text("origin"))),
    option(name("to"), description("the branch to merge into"), schema(text("main"))),
    option(name("as"), description("the name to push this branch as (default: its own)"), schema(text(null))),
    option(name("title"), description("what it's about (default: the branch's name)"), schema(text(null))),
    option(name("description"), description("more about it"), schema(text(null))),
  ),
  contribution: command(
    name("contribution"),
    description("contributions on a remote: list them (view, comment, merge or close one)"),
    remote,
    toggle(name("all"), description("merged and closed ones too")),
    command(name("view"), description("a contribution's changes (as definitions), whether it merges, and its comments"), contributionId, remote),
    command(
      name("comment"),
      description("comment on a contribution"),
      contributionId,
      argument(name("text"), description("the comment"), multiple(), schema(words)),
      option(name("about"), description("the definition it's about"), schema(text(null))),
      remote,
    ),
    command(name("merge"), description("merge it into its target, on the remote: a fast-forward or a clean merge (refused on conflicts)"), contributionId, remote),
    command(name("close"), description("close it without merging"), contributionId, remote),
    command(name("reopen"), description("reopen a closed one"), contributionId, remote),
  ),
  serve: command(
    name("serve"),
    description("serve this codebase: clients with the token can push, pull and run code"),
    port(7737),
    option(name("host"), description("address to listen on"), schema(text("127.0.0.1"))),
    option(name("token"), description("the token clients need (default $TCM_TOKEN, or a new one)"), schema(text(null))),
    toggle(name("run"), description("refuse to run code for clients"), schema(on)),
    ...tls,
    toggle(name("insecure"), description("allow clear-text tokens beyond localhost")),
  ),
  mcp: command(name("mcp"), description("tools for AI agents to work in the codebase: a Model Context Protocol server (stdio)")),
  lsp: command(name("lsp"), description("language server for editors (stdio)"), toggle(name("stdio"), description("accepted for editors that pass it; stdio is the only transport"))),
  complete: command(name("complete"), description("shell completion: `source <(tcm complete zsh)` (or bash, fish, powershell)"), argument(name("shell"), description("zsh, bash, fish or powershell"), schema(text(null)))),
}

/** Sections of `tcm help`, in order; every command is in one. */
export const SECTIONS: [string, string[]][] = [
  ["Codebase", ["init", "watch", "check", "add", "update", "import", "edit", "view", "ls", "find", "deps", "dependents", "docs", "run", "mv", "alias", "rm", "todo", "resolve", "mirror"]],
  ["Tools", ["test", "lint", "fmt", "verify", "lsp", "mcp", "complete"]],
  ["Packages and releases", ["packages", "upgrade", "release", "releases", "changelog", "pack"]],
  ["History and branches", ["diff", "history", "reset", "branch", "switch", "merge"]],
  ["Apps, data and jobs", ["dev", "build", "start", "apps", "data", "jobs"]],
  ["Sync, review and remote execution", ["remote", "push", "pull", "contribute", "contribution", "serve"]],
];
