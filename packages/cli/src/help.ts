// Help and usage errors, read from the command definitions (commands.ts): what `tcm help`, `tcm <command>
// --help` and a mistyped command print.
import { bold, cyan, dim } from "./style.ts";
import { commands, root, SECTIONS } from "./commands.ts";

/** What tcm reads of a route definition: its description, parameters and child routes. */
export interface RouteShape {
  name: string;
  description?: string;
  phases: { model: { params: Record<string, ParamShape> }; routes: RouteShape[] }[];
}
export interface ParamShape {
  name: string;
  description?: string;
  cardinality: "one" | "many";
  schema: { "~standard": { validate: (v: unknown) => unknown } };
  cli: { syntax?: { type: "argument" | "option"; label: string } };
}

export const shape = (definition: unknown) => definition as RouteShape;
export const paramsOf = (r: RouteShape) => r.phases.flatMap((p) => Object.values(p.model.params)).filter((p) => p.cli.syntax);
export const childrenOf = (r: RouteShape) => r.phases.flatMap((p) => p.routes);
export const isToggle = (p: ParamShape) => p.cli.syntax!.label.includes(", --no-");

/** What a parameter is when it's left out: undefined if it's required. */
function fallback(p: ParamShape): { value: unknown } | undefined {
  const r = p.schema["~standard"].validate(undefined) as { value?: unknown; issues?: unknown };
  return r && !("issues" in r && r.issues) ? { value: r.value } : undefined;
}

/** `<name>`, `[file]`, `[names...]`: an argument as usage shows it. */
function argLabel(p: ParamShape): string {
  const n = `${p.name}${p.cardinality === "many" ? "..." : ""}`;
  return fallback(p) ? `[${n}]` : `<${n}>`;
}

function optionLabel(p: ParamShape): string {
  if (isToggle(p)) return fallback(p)?.value === true ? `--no-${p.name}` : `--${p.name}`;
  return `--${p.name} <${p.name === "port" || p.name === "keep" ? "n" : "value"}>`;
}

function described(p: ParamShape): string {
  const d = fallback(p)?.value;
  const shown = d === undefined || d === false || d === true || (Array.isArray(d) && !d.length) ? "" : dim(` (default ${String(d)})`);
  return `${p.description ?? ""}${shown}`;
}

function rows(items: [string, string][]): string[] {
  const width = Math.max(...items.map(([l]) => l.length));
  return items.map(([l, d]) => `  ${cyan(l.padEnd(width))}  ${d}`);
}

/** Help for a command (`path` from its name down, e.g. ["data", "migrate"]), or for tcm itself. */
export function helpText(path: string[]): string {
  if (!path.length) return rootHelp();
  const r = lookup(path);
  const params = paramsOf(r);
  const args = params.filter((p) => p.cli.syntax!.type === "argument");
  const options = params.filter((p) => p.cli.syntax!.type === "option");
  const children = childrenOf(r);
  const usage = [`tcm ${path.join(" ")}`, ...args.map(argLabel), ...(options.length ? ["[options]"] : [])].join(" ");
  const out = [`${bold(`tcm ${path.join(" ")}`)} ${dim("—")} ${r.description ?? ""}`, "", bold("Usage"), `  ${usage}`];
  for (const c of children) out.push(`  tcm ${path.join(" ")} ${c.name}${paramsOf(c).some((p) => p.cli.syntax!.type === "argument") ? " " + paramsOf(c).filter((p) => p.cli.syntax!.type === "argument").map(argLabel).join(" ") : ""}`);
  if (args.length) out.push("", bold("Arguments"), ...rows(args.map((p) => [p.name, described(p)])));
  if (children.length) out.push("", bold("Commands"), ...rows(children.map((c) => [c.name, c.description ?? ""])));
  out.push("", bold("Options"), ...rows([...options.map((p): [string, string] => [optionLabel(p), described(p)]), ["-h, --help", "show this help"]]));
  return out.join("\n");
}

function rootHelp(): string {
  const out = [`${bold("tcm")} ${dim("—")} ${shape(root).description}`, "", bold("Usage"), `  tcm ${dim("[options]")}             watch scratch files (tcm watch)`, `  tcm <command> ${dim("[args] [options]")}`];
  const all = Object.keys(commands);
  const width = Math.max(...all.map((c) => c.length));
  for (const [title, names] of SECTIONS) {
    out.push("", bold(title));
    for (const n of names) out.push(`  ${cyan(n.padEnd(width))}  ${shape(commands[n as keyof typeof commands]).description ?? ""}`);
  }
  out.push("", dim("`tcm <command> --help` shows a command's arguments and options. `source <(tcm complete zsh)` completes"), dim("commands, options and the codebase's names as you type (also bash, fish and powershell)."));
  return out.join("\n");
}

/** The edit distance between two words, for suggesting the command someone meant. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** The commands closest to a mistyped one (or starting with it). */
export function suggest(word: string): string[] {
  const scored = Object.keys(commands).map((c) => [c, c.startsWith(word) ? 0 : distance(word, c)] as const);
  const best = Math.min(...scored.map(([, d]) => d));
  return best <= Math.max(1, Math.floor(word.length / 3)) ? scored.filter(([, d]) => d === best).map(([c]) => c) : [];
}

/** A parse failure, as tcm reports it: what's wrong, and where to look. */
export function usageError(path: string[], result: { code: string; issues?: { message: string; path?: unknown[] }[] }): string {
  const where = `tcm ${path.join(" ")}`.trim();
  const problems =
    result.code === "method-not-allowed"
      ? [`${where} needs a command: ${childrenOf(lookup(path)).map((c) => c.name).join(", ")}`]
      : (result.issues ?? []).map((i) => {
          const param = Array.isArray(i.path) && i.path.length ? String(i.path.at(-1)) : undefined;
          return param ? `${param}: ${i.message}` : i.message.replace(/^unexpected "(.*)"$/, "unexpected '$1'");
        });
  // `tcm run lib.main --verbose`: the flag is for the definition
  const flag = path[0] === "run" && (result.issues ?? []).some((i) => /^unexpected "-/.test(i.message));
  return `${where}: ${problems.join("; ")}${flag ? " (arguments for the definition that start with - go after `--`)" : ""}\n${dim(`see \`${where} --help\``)}`;
}

/** A command's route, or one of its subcommands' (`["data", "migrate"]`). */
function lookup(path: string[]): RouteShape {
  let r = shape(commands[path[0] as keyof typeof commands] as unknown);
  for (const seg of path.slice(1)) r = childrenOf(r).find((c) => c.name === seg) ?? r;
  return r;
}
