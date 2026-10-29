// React apps end to end: placement of hooks, classes and contexts; server components streaming <Suspense>
// boundaries; the first paint rendered on the server and hydrated, in tcm dev and in a production build.
// Nothing is installed in the project: tcm provides React from its cache.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CHROME, hydrated, withPage } from "../browser.ts";
import { okIn, plainEnv, tcmBin, tempDir, withChildren } from "./harness.ts";

function hashOf(dir: string, name: string): string {
  const db = new DatabaseSync(path.join(dir, ".tcm", "codebase.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT hash FROM names WHERE path = ?").get(name) as { hash: string }).hash;
  } finally {
    db.close();
  }
}

/** Start `tcm dev` or `tcm start` in `dir`, kept by `keep`; resolves with its URL. */
function serve(keep: <C extends ChildProcess>(c: C) => C, dir: string, command: "dev" | "start", app: string): Promise<string> {
  const child = keep(spawn(process.execPath, [tcmBin(), command, app, "--port", "0"], { cwd: dir, env: plainEnv() }));
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const m = /url\s+(http:\/\/\S+)/.exec(out);
      if (m) {
        clearInterval(t);
        resolve(m[1]!);
      }
    }, 50);
    child.on("exit", (code) => reject(new Error(`tcm ${command} exited ${code}:\n${out}`)));
  });
}

/** A response body as it arrives: each chunk with the milliseconds since the request. */
async function timed(res: Response): Promise<{ ms: number; text: string }[]> {
  const t0 = Date.now();
  const out: { ms: number; text: string }[] = [];
  const dec = new TextDecoder();
  for await (const c of res.body!) out.push({ ms: Date.now() - t0, text: dec.decode(c as Uint8Array, { stream: true }) });
  return out;
}

const APP = `// tcm: namespace ui
import { Suspense, createContext, lazy, useContext } from "react";
import * as React from "react";
import { setCookie } from "#tcm/server";

export const Theme = createContext("light");

export async function Slow({ ms }: { ms: number }) {
  await new Promise((r) => setTimeout(r, ms));
  // set after the page's headers have gone out
  setCookie("late", "yes", { httpOnly: false });
  return <p id="slow">slow part, {ms}ms</p>;
}

export function Themed() {
  const theme = useContext(Theme);
  return <b id="theme">{theme}</b>;
}

export function Counter() {
  const [n, setN] = React.useState(0);
  return <button id="count" onClick={() => setN(n + 1)}>{n}</button>;
}

// code split: loads in the browser
export const LazyCounter = lazy(async () => ({ default: Counter }));

export class Clock extends React.Component<{ label: string }, { ticks: number }> {
  state = { ticks: 0 };
  render() {
    return <span id="clock" onClick={() => this.setState({ ticks: this.state.ticks + 1 })}>{this.props.label} {this.state.ticks}</span>;
  }
}

export async function Page() {
  setCookie("early", "yes", { httpOnly: false });
  return (
    <Theme value="dark">
      <Theme.Consumer>{(t) => <i id="consumed">{t}</i>}</Theme.Consumer>
      <LazyCounter />
      <h1 id="title">streaming</h1>
      <Themed />
      <Counter />
      <Clock label="ticks" />
      <Suspense fallback={<p id="slow">loading</p>}>
        <Slow ms={1200} />
      </Suspense>
    </Theme>
  );
}

export async function Outside() {
  return <Theme.Consumer>{(t) => <i id="default">{t}</i>}</Theme.Consumer>;
}

export function App() {
  return <main><Page /><Outside /></main>;
}
`;

/** React: hooks, classes and contexts are placed; <Suspense> streams; the first paint is server-rendered */
export const testReactPlacementStreamingHydration = async () => {
  if (!CHROME) return console.log("skipped: no Chrome");
  await withChildren(async (keep) => {
    const dir = tempDir("react");
    const tcm = (...args: string[]) => okIn(dir, ...args);
    tcm("init");
    fs.rmSync(path.join(dir, "scratch.ts"));
    fs.writeFileSync(path.join(dir, "ui.tsx"), APP);
    tcm("add", "ui.tsx");

    assert.match(tcm("view", "ui.Counter"), /renders in the browser: it uses react\.useState/, "a hook through the React namespace");
    assert.match(tcm("view", "ui.Clock"), /renders in the browser: it is a class component/);
    assert.match(tcm("view", "ui.Themed"), /renders in the browser: it uses useContext/);
    assert.match(tcm("view", "ui.Page"), /renders on the server: it uses #tcm\/server \(setCookie\); the browser fetches its rendered tree by hash/);
    assert.match(tcm("view", "ui.Outside"), /renders on the server: it is an async component/);
    assert.match(tcm("view", "ui.Theme"), /runs anywhere/);

    const check = async (url: string) => {
      // cookies set while the page renders: before its headers go out, they're in them
      const first = await fetch(url, { headers: { accept: "text/html" } });
      assert.match(first.headers.getSetCookie().join("\n"), /early=yes/);
      assert.doesNotMatch(first.headers.getSetCookie().join("\n"), /late=yes/);
      assert.match(await first.text(), /var __TCM_COOKIES__ = "[\w-]+"/, "later ones are left for the browser to collect");
      // the server component's own response: the tree at once, the boundary's contents when they're ready
      const lines = (await timed(await fetch(new URL(`/__tcm/rpc/${hashOf(dir, "ui.Page")}`, url), { method: "POST", headers: { "content-type": "application/json" }, body: "[{}]" })))
        .flatMap((c) => c.text.split("\n").filter(Boolean).map((text) => ({ ms: c.ms, text })));
      assert.match(lines[0]!.text, /"\$tcm":"x".*"value":"dark".*"\$tcm":"s"/, "the context and the boundary's fallback come with the tree");
      const slow = lines.find((l) => /slow part/.test(l.text))!;
      assert.ok(slow.ms - lines[0]!.ms >= 800, `the slow part streams later (${lines[0]!.ms}ms, then ${slow.ms}ms)`);

      // the page's HTML: the shell first, with the fallback, then the slow part, then the trees to hydrate with
      const chunks = await timed(await fetch(url, { headers: { accept: "text/html" } }));
      const html = chunks.map((c) => c.text).join("");
      const shell = chunks.find((c) => c.text.includes('id="title"'))!;
      const rest = chunks.find((c) => c.text.includes("slow part"))!;
      assert.match(shell.text, /<i id="consumed">dark<\/i>.*<b id="theme">dark<\/b>.*<p id="slow">loading<\/p>/s, "the first paint has the context's value and the fallback");
      assert.match(html, /<i id="default">light<\/i>/, "a consumer with no provider above it in the server tree reads the default");
      assert.ok(rest.ms - shell.ms >= 800, `the shell doesn't wait for the slow part (${shell.ms}ms, then ${rest.ms}ms)`);
      assert.ok(html.indexOf("__TCM_TREES__") > html.indexOf("slow part"));

      await withPage(url, async (p) => {
        assert.ok(await hydrated(p));
        const text = (sel: string) => `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`;
        assert.match(await p.waitFor<string>(text("#slow"), (t) => /slow part/.test(t ?? "")), /slow part, 1200ms/);
        await p.evaluate(`document.querySelector("#count").click()`);
        assert.equal(await p.waitFor<string>(text("#count"), (t) => t === "1", 3000), "1");
        await p.evaluate(`document.querySelector("#clock").click()`);
        assert.equal(await p.waitFor<string>(text("#clock"), (t) => t === "ticks 1", 3000), "ticks 1");
        // the lazy component, sent by hash, loaded and rendered in the browser
        assert.equal(await p.evaluate(`document.querySelectorAll("#count").length`), 2);
        assert.match(await p.waitFor<string>("document.cookie", (c) => /late=yes/.test(c ?? "")), /early=yes.*late=yes|late=yes.*early=yes/);
        assert.deepEqual(p.errors, []);
      });
    };

    await check(await serve(keep, dir, "dev", "ui.App"));

    // production: the same, from the build's server-rendering bundle, which isn't served
    tcm("build", "ui.App");
    const url = await serve(keep, dir, "start", "ui.App");
    await check(url);
    const build = hashOf(dir, "ui.App");
    assert.ok(fs.existsSync(path.join(dir, ".tcm", "apps", build, "server", "ssr.js")));
    assert.equal((await fetch(new URL(`/_app/${build}/server/ssr.js`, url))).status, 404);
  });
};
