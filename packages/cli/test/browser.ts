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
    sock.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> };
      if (msg.id !== undefined) pending.get(msg.id)?.(msg.result ?? {});
    };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = (await send("Target.createTarget", { url })) as { targetId: string };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)) as { result?: { value?: T } };
      return r.result?.value as T;
    };
    const page: Page = {
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
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Open `url` in a fresh headless Chrome and return the text of `selector` once `until` accepts it (or the last text
 * seen when `timeoutMs` runs out).
 */
export function pageText(url: string, selector: string, until: (text: string) => boolean, timeoutMs = 15000): Promise<string> {
  return withPage(url, (page) => page.waitFor<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`, (t) => until(t ?? ""), timeoutMs).then((t) => t ?? ""));
}
