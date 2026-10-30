// The command line itself: help and usage errors read from the command definitions, shell completion from
// them and the codebase, and prompts for what a command is missing when there's a person at a terminal.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { okIn, plainEnv, strip, tcmBin, tcmIn, tempDir } from "./harness.ts";

/** Runs tcm in `dir`: `run` gives the status and output, `tcm` fails on an error; `write` writes a file there. */
function inDir(dir: string) {
  const run = (...args: string[]) => tcmIn(dir, ...args);
  const tcm = (...args: string[]) => okIn(dir, ...args);
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  /** What the shell offers after these words (the last is the one being completed): `value\tdescription` lines. */
  const completions = (...words: string[]) =>
    tcm("complete", "--", ...words)
      .split("\n")
      .filter((l) => l && !l.startsWith(":"))
      .map((l) => l.split("\t")[0]);
  return { dir, run, tcm, write, completions };
}

/** A codebase with lib.echo and lib.id, added from scratch.ts. */
function withEcho() {
  const c = inDir(tempDir("cli"));
  c.tcm("init");
  c.write("scratch.ts", `// tcm: namespace lib\n/** Echoes. */\nexport const echo = (...args: string[]): string => args.join(" ");\nexport const id = <T>(x: T): T => x;\n`);
  c.tcm("add");
  return c;
}

/** help, read from the command definitions */
export const testHelp = () => {
  const { tcm } = inDir(tempDir("cli"));
  const help = tcm("help");
  for (const section of ["Codebase", "Packages and releases", "History and branches", "Apps, data and jobs", "Sync, review and remote execution"]) assert.match(help, new RegExp(`^${section}$`, "m"));
  assert.match(help, /^ {2}view +show definitions with current names$/m);
  assert.equal(tcm("--help"), help);

  // a command's arguments and options, with their defaults; no codebase needed
  const serve = tcm("serve", "--help");
  assert.match(serve, /^tcm serve — serve this codebase/);
  assert.match(serve, /^ {2}--port <n> +port to listen on \(default 7737\)$/m);
  assert.match(serve, /^ {2}--no-run +refuse to run code for clients$/m);
  assert.match(tcm("help", "data", "migrate"), /Usage\n {2}tcm data migrate <table>\n/);
  assert.match(tcm("help", "run"), /tcm run \[name\] \[args\.\.\.\] \[options\]/);
  assert.match(tcm("--version"), /^tcm \(hash format v\d+, TypeScript \d/);
};

/** usage errors say what's wrong and where to look */
export const testUsageErrors = () => {
  const { run } = inDir(tempDir("cli"));
  const typo = run("vew");
  assert.equal(typo.status, 1);
  assert.match(typo.out, /unknown command 'vew'; did you mean `tcm view`\?\nsee `tcm help`/);
  assert.match(run("serve", "--port", "nope").out, /tcm serve: port: expected a whole number, not 'nope'\nsee `tcm serve --help`/);
  assert.match(run("dev", "app", "--prot", "1").out, /tcm dev: unexpected '--prot'/);
  assert.match(run("run", "lib.main", "--verbose").out, /arguments for the definition that start with - go after `--`/);
  assert.match(run("pack", "--bin", "x", "--name", "x").out, /no tcm codebase here|--bin wants cmd=<name>/);
};

/** arguments after -- reach the definition */
export const testArgumentsAfterDashDash = () => {
  const { run, tcm } = withEcho();
  assert.equal(tcm("run", "lib.echo", "a", "--", "--b", "-c"), "a --b -c\n");
  // without a terminal, a missing argument is a usage error, as before
  assert.deepEqual(run("view"), { status: 1, out: "usage: tcm view <name|#hash>...\n" });
};

/** shell completion: commands, options, and names from the codebase */
export const testShellCompletion = () => {
  const { tcm, completions } = withEcho();
  tcm("branch", "feature");
  tcm("remote", "add", "origin", path.join(os.tmpdir(), "elsewhere"));
  assert.match(tcm("complete", "zsh"), /^#compdef tcm/);
  assert.match(tcm("complete", "bash"), /complete .*tcm/);
  assert.deepEqual(completions("vi"), ["view"]);
  assert.deepEqual(completions("view", ""), ["lib.echo", "lib.id"]);
  assert.deepEqual(completions("ls", ""), ["lib"]);
  assert.deepEqual(completions("switch", ""), ["main", "feature"]);
  assert.deepEqual(completions("push", ""), ["origin"]);
  assert.deepEqual(completions("run", "x", "--on", ""), ["origin"]);
  assert.deepEqual(completions("serve", "--p"), ["--port"]);
  assert.deepEqual(completions("data", ""), ["migrate"]);
  assert.deepEqual(completions("complete", ""), ["zsh", "bash", "fish", "powershell"]);
  assert.ok(completions("add", "").includes("scratch.ts"));
  // outside a codebase, commands still complete (and names just don't)
  const r = spawnSync(process.execPath, [tcmBin(), "complete", "--", "view", ""], { cwd: os.tmpdir(), encoding: "utf8", env: plainEnv() });
  assert.equal(r.status, 0, r.stderr);
};

/** A terminal 120 columns wide (prompts lay themselves out to its width) between a child and our pipes. */
const PTY = `
import os, pty, sys, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.execvp(sys.argv[1], sys.argv[1:])
inputs = [fd, 0]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data)
        else:
            inputs = [fd]
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

/**
 * Run tcm in `dir` on a pseudo-terminal (Python's pty module, the same on macOS and Linux), answering
 * prompts: each step waits for text on screen, then types. Resolves with everything shown.
 */
function onTerminal(dir: string, args: string[], steps: [RegExp, string][]): Promise<string> {
  const child = spawn("python3", ["-c", PTY, process.execPath, tcmBin(), ...args], { cwd: dir, env: { ...plainEnv(), CI: "", TERM: "xterm-256color" } });
  let screen = "";
  let next = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (child.kill(), reject(new Error(`timed out waiting for ${steps[next]?.[0]}:\n${strip(screen)}`))), 30_000);
    child.stdout.on("data", (d: Buffer) => {
      screen += d.toString();
      while (next < steps.length && steps[next]![0].test(strip(screen))) child.stdin.write(steps[next++]![1]);
    });
    child.on("close", () => (clearTimeout(timer), resolve(strip(screen))));
  });
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

/** on a terminal, a missing argument is asked for */
export const testMissingArgumentAskedFor = async () => {
  if (!hasPty) return console.log("skipped: no python3 for a pseudo-terminal");
  const { dir, tcm, write } = withEcho();
  tcm("branch", "feature");
  // a name, found by typing part of it
  const viewed = await onTerminal(dir, ["view"], [[/Which definition\?/, "ech"], [/lib\.echo/, "\r"]]);
  assert.match(viewed, /export const echo = \(\.\.\.args: string\[\]\): string => args\.join\(" "\)/);

  // a branch, picked from a list
  assert.match(await onTerminal(dir, ["switch"], [[/Switch to\?/, "\r"]]), /on branch feature/);
  tcm("switch", "main");

  // removing a name others use: asked, not refused
  write("scratch.ts", `// tcm: namespace lib\nimport { echo } from "#codebase/lib";\nexport const shout = (s: string): string => echo(s, "!");\n`);
  tcm("add");
  assert.match(await onTerminal(dir, ["rm", "lib.echo"], [[/Remove the name anyway\?/, "y"]]), /removed lib\.echo/);
  assert.match(tcm("run", "lib.shout", "hi"), /hi !/);
};

/** a codebase made by a tcm that stores codebases differently is refused, with what to do */
export const testOtherLayoutRefused = async () => {
  const other = tempDir("layout");
  assert.equal(spawnSync(process.execPath, [tcmBin(), "init"], { cwd: other, env: plainEnv() }).status, 0);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(other, ".tcm", "codebase.sqlite"));
  db.prepare("UPDATE settings SET value = 'another' WHERE key = 'layout'").run();
  db.close();
  const r = spawnSync(process.execPath, [tcmBin(), "ls"], { cwd: other, encoding: "utf8", env: plainEnv() });
  assert.equal(r.status, 1);
  assert.match(strip(r.stdout + r.stderr), /was made by a tcm that stores codebases differently, and this one can't read it; make the codebase again with this tcm/);
};

/**
 * a codebase moved away from the @types/node its tsconfig names (or the tcm that made it moved) finds this tcm's
 */
export const testMovedCodebaseFindsNodeTypes = () => {
  const dir = tempDir("moved");
  okIn(dir, "init");
  const file = path.join(dir, "tsconfig.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.compilerOptions.typeRoots = [path.join(dir, "gone", "node_modules", "@types")];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, "scratch.ts"), `// tcm: namespace lib\nimport fs from "node:fs";\nexport const here = (p: string): boolean => fs.existsSync(p);\n`);
  assert.match(okIn(dir, "add"), /\+ new +lib\.here/);
  const roots: string[] = JSON.parse(fs.readFileSync(file, "utf8")).compilerOptions.typeRoots;
  assert.ok(roots.every((r) => fs.existsSync(r)), roots.join(", "));
}
