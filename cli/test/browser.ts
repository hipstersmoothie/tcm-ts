// A real headless Chrome for tests, driven over the DevTools protocol: load a page, then poll the live DOM in real
// time. (`--dump-dom` with `--virtual-time-budget` fast-forwards a fake clock and gives up on pending streams, and
// `--timeout` stops all page activity, so neither is a faithful browser for async network code.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));

export interface Page {
  /** evaluate an expression in the page (awaiting a promise), returning its JSON value */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** poll `expression` until `until` accepts its value; returns the last value seen */
  waitFor<T = unknown>(expression: string, until: (v: T) => boolean, timeoutMs?: number): Promise<T>;
  /** the page's console errors and uncaught exceptions so far */
  errors: string[];
}

/** Open `url` in a fresh headless Chrome, run `fn` against it, then close Chrome. */
export async function withPage<R>(url: string, fn: (page: Page) => Promise<R>): Promise<R> {
  if (!CHROME) throw new Error("no Chrome installed");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tcm-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"]);
  try {
    const ws = await new Promise<string>((resolve, reject) => {
      let err = "";
      chrome.stderr.setEncoding("utf8").on("data", (d: string) => {
        err += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) resolve(m[1]!);
      });
      chrome.on("exit", () => reject(new Error(`chrome exited: ${err}`)));
    });
    const sock = new WebSocket(ws);
    await new Promise((r, j) => ((sock.onopen = r), (sock.onerror = j)));
    let id = 0;
    const pending = new Map<number, (v: Record<string, unknown>) => void>();
    const errors: string[] = [];
    sock.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; method?: string; result?: Record<string, unknown>; params?: Record<string, any> };
      if (msg.id !== undefined) pending.get(msg.id)?.(msg.result ?? {});
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") errors.push(msg.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text);
    };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    // attach before loading, so the page's errors from the first moment are seen
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url }, sessionId);
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)) as { result?: { value?: T } };
      return r.result?.value as T;
    };
    const page: Page = {
      errors,
      evaluate,
      async waitFor<T>(expression: string, until: (v: T) => boolean, timeoutMs = 15000) {
        let v = undefined as T;
        for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
          v = await evaluate<T>(expression);
          if (until(v)) break;
        }
        return v;
      },
    };
    try {
      return await fn(page);
    } finally {
      sock.close();
    }
  } finally {
    // Chrome writes to its profile while shutting down: wait for it to exit before removing it
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    // Chrome's helper processes can hold its pipes open after it exits; they mustn't keep this process alive
    for (const pipe of [chrome.stdin, chrome.stdout, chrome.stderr]) pipe?.destroy();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Wait until React has taken over (hydrated or rendered) the page's `#app`: before that, clicks do nothing. */
export const hydrated = (page: Page) =>
  page.waitFor<boolean>(`Object.keys(document.getElementById("app") ?? {}).some((k) => k.startsWith("__reactContainer"))`, (v) => !!v);

/**
 * Open `url` in a fresh headless Chrome and return the text of `selector` once `until` accepts it (or the last text
 * seen when `timeoutMs` runs out).
 */
export function pageText(url: string, selector: string, until: (text: string) => boolean, timeoutMs = 15000): Promise<string> {
  return withPage(url, (page) => page.waitFor<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`, (t) => until(t ?? ""), timeoutMs).then((t) => t ?? ""));
}
