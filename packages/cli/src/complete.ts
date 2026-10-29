// Shell completion with @bomb.sh/tab: `tcm complete zsh` prints a script for the shell, which then asks
// `tcm complete -- <words>` what can come next. Commands and options are read from the command definitions;
// arguments complete from the codebase: definitions and namespaces by name, branches, remotes, packages, tables.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RootCommand, type Command } from "@bomb.sh/tab";
import { Store } from "@tcm/store";
import { commands, root } from "./commands.ts";
import { childrenOf, isToggle, paramsOf, shape, type RouteShape } from "./help.ts";

type Complete = (value: string, description: string) => void;

/** What the shell's asking about, read lazily: completing a command name shouldn't open the codebase. */
class Sources {
  private store: Store | undefined | null = null;
  private cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private root(): string | undefined {
    for (let dir = this.cwd; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".tcm", "codebase.sqlite"))) return dir;
      if (path.dirname(dir) === dir) return undefined;
    }
  }
  private db(): Store | undefined {
    if (this.store === null) {
      const r = this.root();
      this.store = r ? new Store(path.join(r, ".tcm", "codebase.sqlite")) : undefined;
    }
    return this.store;
  }
  definitions(complete: Complete, kind?: "value") {
    for (const n of this.db()?.names() ?? []) if (!kind || n.kind !== "type") complete(n.path, n.kind);
  }
  namespaces(complete: Complete) {
    const seen = new Set<string>();
    for (const n of this.db()?.names() ?? []) {
      const parts = n.path.split(".");
      for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join("."));
    }
    for (const ns of [...seen].sort()) complete(ns, "namespace");
  }
  branches(complete: Complete) {
    const db = this.db();
    for (const b of db?.branches() ?? []) complete(b, b === db!.branch().name ? "current branch" : "branch");
  }
  remotes(complete: Complete) {
    for (const [key, value] of this.db()?.settings("remote.") ?? []) complete(key.slice("remote.".length), (JSON.parse(value) as { url?: string }).url ?? "");
  }
  packages(complete: Complete) {
    const seen = new Set<string>();
    for (const p of this.db()?.lockedPackages() ?? []) if (!p.name.startsWith("@types/") && !seen.has(p.name)) (seen.add(p.name), complete(p.name, p.version));
  }
  tables(complete: Complete) {
    const r = this.root();
    const file = r && path.join(r, ".tcm", "data", "store.sqlite");
    if (!file || !fs.existsSync(file)) return;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const t of db.prepare("SELECT tbl, count(*) AS n FROM rows GROUP BY tbl ORDER BY tbl").all() as { tbl: string; n: number }[]) complete(t.tbl, `${t.n} row(s)`);
    } finally {
      db.close();
    }
  }
  /** Directories under this one (tab can't hand a word back to the shell's own path completion). */
  directories(complete: Complete) {
    const walk = (dir: string, depth: number) => {
      for (const e of fs.readdirSync(path.join(this.cwd, dir), { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        complete(rel, "directory");
        if (depth < 2) walk(rel, depth + 1);
      }
    };
    walk("", 1);
  }
  scratchFiles(complete: Complete) {
    const r = this.root() ?? this.cwd;
    for (const f of fs.readdirSync(r)) if (/\.tsx?$/.test(f) && !f.endsWith(".d.ts")) complete(f, "scratch file");
  }
}

/** Where each argument or option completes from: by command, then by parameter name. */
function sourceFor(command: string, param: string, s: Sources): ((complete: Complete) => void) | undefined {
  const definitions = (c: Complete) => s.definitions(c);
  const values = (c: Complete) => s.definitions(c, "value");
  const namespaces = (c: Complete) => s.namespaces(c);
  const both = (c: Complete) => (s.namespaces(c), s.definitions(c));
  const dirs = (c: Complete) => s.directories(c);
  const byCommand: Record<string, (c: Complete) => void> = {
    "mv from": both,
    "pack entries": both,
    "upgrade namespace": namespaces,
    "upgrade package": (c) => s.packages(c),
    "import dir": dirs,
    "pull branch": () => {},
    "branch branch": () => {},
    "complete shell": (c) => ["zsh", "bash", "fish", "powershell"].forEach((sh) => c(sh, "")),
  };
  const byName: Record<string, (c: Complete) => void> = {
    name: definitions,
    names: definitions,
    app: values,
    namespace: namespaces,
    into: namespaces,
    branch: (c) => s.branches(c),
    remote: (c) => s.remotes(c),
    on: (c) => s.remotes(c),
    table: (c) => s.tables(c),
    file: (c) => s.scratchFiles(c),
  };
  return byCommand[`${command} ${param}`] ?? byName[param];
}

function addParams(cmd: Command, route: RouteShape, command: string, s: Sources) {
  for (const p of paramsOf(route)) {
    const from = sourceFor(command, p.name, s);
    if (p.cli.syntax!.type === "argument") cmd.argument(p.name, from ? (complete) => from(complete) : undefined, p.cardinality === "many");
    // tab reads an option with a handler as taking a value, one without as a switch
    else if (isToggle(p)) cmd.option(p.name, p.description ?? "");
    else cmd.option(p.name, p.description ?? "", (complete) => from?.(complete));
  }
}

/** `tcm complete <shell>` (the script) or `tcm complete -- <words>` (what can come next). */
export function complete(shell: string | undefined, words: string[], cwd: string): void {
  const t = new RootCommand();
  const s = new Sources(cwd);
  addParams(t, shape(root), "", s);
  for (const [name, definition] of Object.entries(commands)) {
    const route = shape(definition);
    addParams(t.command(name, route.description ?? ""), route, name, s);
    for (const child of childrenOf(route)) addParams(t.command(`${name} ${child.name}`, child.description ?? ""), child, `${name} ${child.name}`, s);
  }
  if (shell) t.setup("tcm", "tcm", shell);
  else t.parse(words);
}
