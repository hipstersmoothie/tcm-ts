// Talking to a person at a terminal, with @clack/prompts: a command missing something it needs asks for it (a
// name to view, a branch to switch to, which definition to keep), and long steps show progress. Anywhere
// else (pipes, CI, editors, tests) nothing is asked: a missing argument is a usage error, as it always was.
import * as p from "@clack/prompts";
import { shortHash } from "@tcm/core";
import { setProgress } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";

export class UsageError extends Error {}

/** Whether there's someone to ask: a terminal on both ends, and not CI. */
export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI && process.env.TERM !== "dumb";
}

/** The answer, or out if they cancelled (Ctrl-C, Esc). */
function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("cancelled");
    throw new UsageError("cancelled");
  }
  return value as T;
}

/** What `usage` describes, asked for if a person can be: `message`, choosing from `options`. */
export async function choose<T>(usage: string, message: string, options: { value: T; label: string; hint?: string }[], search = options.length > 8): Promise<T> {
  if (!interactive()) throw new UsageError(`usage: tcm ${usage}`);
  if (!options.length) throw new UsageError(`nothing to choose from (usage: tcm ${usage})`);
  const asked = search ? p.autocomplete<T>({ message, options: options as never, placeholder: "type to search", maxItems: 12 }) : p.select<T>({ message, options: options as never });
  return answer<T>(await asked);
}

/** One of the branch's names (values only, for `kind: "value"`), asked for by search. */
export function chooseName(cb: Codebase, usage: string, message: string, kind?: "value"): Promise<string> {
  const names = cb.store.names().filter((n) => !kind || n.kind !== "type");
  return choose(usage, message, names.map((n) => ({ value: n.path, label: n.path, hint: `${n.kind} ${shortHash(n.hash)}` })), true);
}

/** Free text, asked for if a person can be. */
export async function ask(usage: string, message: string, placeholder?: string): Promise<string> {
  if (!interactive()) throw new UsageError(`usage: tcm ${usage}`);
  return answer<string>(await p.text({ message, placeholder, validate: (v) => (v?.trim() ? undefined : "required") }));
}

/** Yes or no; without a terminal, the answer is no. */
export async function confirm(message: string): Promise<boolean> {
  if (!interactive()) return false;
  return answer<boolean>(await p.confirm({ message, initialValue: false }));
}

/** Package installs (which tcm runs as it needs them) as spinners on a terminal, not lines of text. */
export function showInstallProgress() {
  if (!process.stderr.isTTY || process.env.CI) return;
  setProgress({
    start(message) {
      // the install blocks the event loop, so no animation or timer: the line, then what happened and how long it took
      const s = p.spinner({ output: process.stderr, withGuide: false });
      s.start(message);
      return { stop: (done) => s.stop(done), fail: (why) => s.error(why) };
    },
  });
}

export const intro = (title: string) => interactive() && p.intro(title);
export const success = (message: string) => (interactive() ? p.log.success(message) : console.log(message));
export const outro = (message: string) => (interactive() ? p.outro(message) : console.log(message));
