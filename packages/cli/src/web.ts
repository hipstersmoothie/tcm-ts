// Browser apps served straight from the codebase, with server functions called by hash.
//
// - `ucm dev <app>`: a Vite dev server, reloading when the codebase changes under the app.
// - `ucm build <app>`: a production build into .ucm/apps/<app hash>/, immutable and content-addressed.
// - `ucm start <app>`: serves whichever build the app's name points to now, and keeps earlier builds working:
//   their assets stay served and their server functions stay callable, so a tab opened before a deploy keeps
//   calling the code it was built against. Deploying and rolling back are both just moving the name.
//
// In all three, a Vite plugin swaps every component that has to run on the server for a stub module whose exports
// call it by hash (`POST /__ucm/rpc/<hash>`), so server code never reaches the browser. The server answers those
// calls by importing the real module, but only for hashes a build actually calls (its endpoints): anything the
// browser can reach is a public endpoint.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { checkArgs, exportId, shortHash } from "@ucm/core";
import { materialize, writeIfChanged } from "@ucm/loader";
import type { Codebase } from "./codebase.ts";
import { codecSource, decode, encode } from "./codec.ts";
import { Placement, type AppPlan } from "./placement.ts";
import { bold, dim, green, red, yellow } from "./style.ts";

const RUNTIME = "virtual:ucm-runtime";
const CODEC = "virtual:ucm-codec";
const STUB = "\0ucm-stub:";
const HASH_FILE = /(?:^|\/)([a-z2-7]{52})\.ts$/;

const runtimeSource = `import { encode, decode } from ${JSON.stringify(CODEC)};

/** A function that runs on the server, called by hash. */
export function remote(hash, name, callable) {
  const fn = async (...args) => {
    if (!callable) throw new Error(name + " runs on the server and this app doesn't call it from the browser");
    let res;
    try {
      res = await fetch("/__ucm/rpc/" + hash, { method: "POST", headers: { "content-type": "application/json" }, body: encode(args, "arguments to " + name) });
    } catch (e) {
      throw new Error(name + ": the server is unreachable (" + e.message + ")");
    }
    // this page's build was retired: reload to get the current version
    if (res.status === 410 && !globalThis.__ucmReloading) {
      globalThis.__ucmReloading = true;
      location.reload();
      return new Promise(() => {});
    }
    const body = decode(await res.text());
    if (!res.ok) {
      const err = new Error(body && body.message ? body.message : res.statusText);
      err.name = body && body.name ? body.name : "RemoteError";
      err.status = res.status;
      throw err;
    }
    return body;
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/** A server-side async generator, iterated from the browser: chunks arrive as they're produced. */
export function remoteStream(hash, name) {
  const fn = (...args) => ({
    [Symbol.asyncIterator]() {
      const stop = new AbortController();
      const decoder = new TextDecoder();
      let reader;
      let buf = "";
      const opened = (async () => {
        const res = await fetch("/__ucm/rpc/" + hash, { method: "POST", headers: { "content-type": "application/json" }, body: encode(args, "arguments to " + name), signal: stop.signal });
        if (res.status === 410 && !globalThis.__ucmReloading) {
          globalThis.__ucmReloading = true;
          location.reload();
          await new Promise(() => {});
        }
        if (!res.ok) {
          const body = decode(await res.text());
          const err = new Error(body && body.message ? body.message : res.statusText);
          err.name = body && body.name ? body.name : "RemoteError";
          err.status = res.status;
          throw err;
        }
        reader = res.body.getReader();
      })();
      return {
        async next() {
          await opened;
          for (;;) {
            const nl = buf.indexOf("\\n");
            if (nl >= 0) {
              const msg = decode(buf.slice(0, nl));
              buf = buf.slice(nl + 1);
              if (msg.e) {
                const err = new Error(msg.e.message);
                err.name = msg.e.name;
                err.status = msg.e.status;
                throw err;
              }
              if (msg.done) return { done: true, value: undefined };
              return { done: false, value: msg.v };
            }
            const { value, done } = await reader.read();
            if (done) return { done: true, value: undefined };
            buf += decoder.decode(value, { stream: true });
          }
        },
        async return() {
          stop.abort();
          return { done: true, value: undefined };
        },
      };
    },
  });
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}
`;

/** The browser runtime with the codec inlined, as a standalone module (for tests and inspection). */
export function browserRuntime(): string {
  return runtimeSource.replace(/^import \{ encode, decode \} from .*$/m, codecSource().replaceAll("export ", ""));
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export interface AppState {
  hash: string;
  plan: AppPlan;
}

/** Resolve the app's name, materialize its closure, and work out what goes where. */
export function planApp(cb: Codebase, appName: string): AppState {
  const hash = cb.lookupOne(appName, "value");
  materialize([hash], cb.source(), cb.lay); // the whole closure, server side included, with npm packages
  const plan = new Placement(cb).planApp(hash);
  cb.ensureParams(plan.endpoints);
  return { hash, plan };
}

/** The entry module for a build root: start the app, or show why it can't run in the browser. */
function entrySource(cb: Codebase, appName: string, s: AppState, cacheRel: string): string {
  if (s.plan.errors.length) {
    const html = `<pre style="color:#b00;white-space:pre-wrap;font:14px ui-monospace,monospace;padding:1em">${escapeHtml(s.plan.errors.join("\n\n"))}</pre>`;
    return `// ${appName} can't run in the browser yet\ndocument.body.innerHTML = ${JSON.stringify(html)};\n`;
  }
  const rec = cb.store.getDef(s.hash)!;
  return `// generated by ucm: ${appName} ${rec.hash}\nimport { ${exportId(rec.hash)} as main } from "${cacheRel}/${rec.componentHash}.ts";\nconst app: unknown = main;\nif (typeof app === "function") await app();\n`;
}

function writeBuildRoot(cb: Codebase, dir: string, appName: string, s: AppState) {
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(
    path.join(dir, "index.html"),
    `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>${escapeHtml(appName)}</title></head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="./entry.ts"></script>\n  </body>\n</html>\n`,
  );
  const cacheRel = path.relative(dir, cb.lay.cacheDir).split(path.sep).join("/");
  writeIfChanged(path.join(dir, "entry.ts"), entrySource(cb, appName, s, cacheRel));
}

/** Swaps server components for stubs that call them by hash, and provides the browser runtime. */
function ucmPlugin(cb: Codebase, current: () => AppPlan): Plugin {
  return {
    name: "ucm",
    // ahead of Vite's own resolver: server components must be swapped for stubs before they are resolved as files
    enforce: "pre",
    resolveId(source) {
      if (source === RUNTIME || source === CODEC) return "\0" + source;
      const m = HASH_FILE.exec(source);
      if (m && /^\.\.?\//.test(source) && current().stubbed.has(m[1]!)) return STUB + m[1];
      return null;
    },
    load(id) {
      if (id === "\0" + RUNTIME) return runtimeSource;
      if (id === "\0" + CODEC) return codecSource();
      if (!id.startsWith(STUB)) return null;
      const members = cb.store.componentMembers(id.slice(STUB.length));
      return [
        `import { remote, remoteStream } from ${JSON.stringify(RUNTIME)};`,
        ...members.map((m) =>
          current().streaming.has(m.hash)
            ? `export const ${exportId(m.hash)} = remoteStream(${JSON.stringify(m.hash)}, ${JSON.stringify(m.nameHint)});`
            : `export const ${exportId(m.hash)} = remote(${JSON.stringify(m.hash)}, ${JSON.stringify(m.nameHint)}, ${current().endpoints.has(m.hash)});`,
        ),
      ].join("\n");
    },
  };
}

type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;

/** Answers `POST /__ucm/rpc/<hash>` for hashes `isEndpoint` accepts, by importing and calling the real function. */
interface ServerApiHost {
  HttpError: new (status: number, message: string) => Error & { status: number; retryAfter?: number };
  withCall: <T>(
    call: { method: string; url: string; headers: Record<string, string | string[] | undefined>; ip: string | undefined; signal: AbortSignal },
    opts: { secure: boolean; dataDir?: string },
    fn: () => Promise<T>,
  ) => Promise<{ ok: true; value: T; setCookies: string[] } | { ok: false; error: unknown; setCookies: string[] }>;
  pendingCookies: () => string[];
}

/** The `#ucm/server` instance the codebase's generated modules import, so server functions see their call. */
function serverApiHost(cb: Codebase): () => Promise<ServerApiHost> {
  let api: Promise<ServerApiHost> | undefined;
  return () => (api ??= import(pathToFileURL(path.join(cb.lay.cacheDir, "ucm-server.js")).href) as Promise<ServerApiHost>);
}

/** App data (sessions) lives apart from the codebase: .ucm/data. */
function dataDir(cb: Codebase): string {
  const d = path.join(cb.lay.ucmDir, "data");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> => !!v && typeof (v as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";
const STREAMED = Symbol("streamed");

/** How a server-side failure reaches the caller: deliberate HttpErrors as is, anything else hidden in production. */
function errorReply(err: Error & { status?: number; retryAfter?: number }, isHttpError: boolean, name: string, production: boolean) {
  if (isHttpError) {
    const status = err.status! >= 400 && err.status! < 600 ? err.status! : 500;
    return { status, body: { name: "HttpError", message: err.message, status: err.status }, retryAfter: err.retryAfter };
  }
  if (production) {
    // unexpected errors can carry internals (paths, queries, secrets): log them here, tell the caller less
    console.error(red(`  ${name} failed: ${err?.stack ?? String(err)}`));
    return { status: 500, body: { name: "Error", message: "internal error" } };
  }
  return { status: 500, body: { name: err?.name ?? "Error", message: err?.message ?? String(err) } };
}

export interface RpcOptions {
  /** production hides unexpected errors from the browser (they're logged here); dev shows them */
  production: boolean;
  /** served over TLS: cookies default to Secure */
  secure: boolean;
}

function rpcHandler(cb: Codebase, isEndpoint: (hash: string) => boolean, retired: (hash: string) => boolean = () => false, opts: RpcOptions = { production: false, secure: false }): Middleware {
  const host = serverApiHost(cb);
  const data = dataDir(cb);
  return async (req, res, next) => {
    const m = /^\/__ucm\/rpc\/([a-z2-7]{52})$/.exec((req.url ?? "").split("?")[0]!);
    if (!m) return next();
    const started = performance.now();
    const hash = m[1]!;
    const name = cb.displayRef(`#${hash}`);
    const send = (status: number, body: unknown) => {
      let text: string;
      try {
        text = encode(body, `result of ${name}`);
      } catch (e) {
        status = 500;
        text = encode({ name: "TypeError", message: (e as Error).message });
      }
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(text);
      const mark = status === 200 ? green(String(status)) : red(String(status));
      console.log(`  ${dim("→")} ${name} ${mark} ${dim(`${Math.round(performance.now() - started)}ms`)}`);
    };
    // CSRF: server functions can read cookies, so only the app's own pages may call them. Cross-site requests
    // are refused, and requiring a JSON body rules out plain HTML form posts, which can't set that content type.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(403, { name: "RemoteError", message: "cross-origin call refused" });
    if (req.headers["sec-fetch-site"] === "cross-site") return send(403, { name: "RemoteError", message: "cross-site call refused" });
    if (req.method !== "POST") return send(405, { name: "RemoteError", message: "use POST" });
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(415, { name: "RemoteError", message: "send arguments as application/json" });
    if (!isEndpoint(hash)) {
      // a page from a pruned build: 410 tells the browser runtime to reload itself onto the current build
      if (retired(hash)) return send(410, { name: "OutdatedError", message: "this page's build is no longer served; reload for the current version" });
      return send(403, { name: "RemoteError", message: `${shortHash(hash)} isn't a server function this app calls` });
    }
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 16 * 1024 * 1024) return send(413, { name: "RemoteError", message: "arguments too large" });
    }
    let args: unknown;
    try {
      args = decode(text);
    } catch {
      return send(400, { name: "RemoteError", message: "malformed arguments" });
    }
    if (!Array.isArray(args)) return send(400, { name: "RemoteError", message: "arguments must be a list" });
    const rec = cb.store.getDef(hash)!;
    // arguments come from the network: check them against the function's parameter types before calling it
    const problem = rec.params && checkArgs(rec.params, args);
    if (problem) return send(400, { name: "TypeError", message: `${name}: ${problem}` });
    // a hash names immutable code, so Node's module cache can never serve a stale version of it
    const fn = ((await import(pathToFileURL(path.join(cb.lay.cacheDir, `${rec.componentHash}.ts`)).href)) as Record<string, (...a: unknown[]) => unknown>)[exportId(hash)]!;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort(new Error("the client disconnected"));
    });
    const { HttpError, withCall, pendingCookies } = await host();
    const call = { method: req.method ?? "POST", url: req.url ?? "/", headers: req.headers, ip: req.socket.remoteAddress, signal: abort.signal };
    const r = await withCall(call, { secure: opts.secure, dataDir: data }, async () => {
      const out = await fn(...(args as unknown[]));
      if (!isAsyncIterable(out)) return out;
      // A stream: newline-delimited chunks, iterated inside the call so the request context lasts as long as it.
      // Cookies set before the first chunk go out with the headers; the client stopping ends the iteration.
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", ...(pendingCookies().length ? { "set-cookie": pendingCookies() } : {}) });
      let chunks = 0;
      try {
        for await (const v of out) {
          if (abort.signal.aborted) break;
          res.write(encode({ v }, `chunk ${chunks} of ${name}`) + "\n");
          chunks++;
        }
        res.end(encode({ done: true }) + "\n");
      } catch (e) {
        const err = errorReply(e as Error, e instanceof HttpError, name, opts.production);
        res.end(encode({ e: err.body }) + "\n");
      }
      console.log(`  ${dim("→")} ${name} ${green("stream")} ${dim(`${chunks} chunk(s), ${Math.round(performance.now() - started)}ms${abort.signal.aborted ? ", stopped by the client" : ""}`)}`);
      return STREAMED;
    });
    if (r.ok && r.value === STREAMED) return;
    if (r.setCookies.length) res.setHeader("set-cookie", r.setCookies);
    if (r.ok) return send(200, r.value);
    const err = errorReply(r.error as Error & { status?: number; retryAfter?: number }, r.error instanceof HttpError, name, opts.production);
    if (err.retryAfter !== undefined) res.setHeader("retry-after", String(err.retryAfter));
    send(err.status, err.body);
  };
}

/** Plain HTTP endpoints: the definitions under `namespace`, served under `prefix` (names are the routes). */
export interface HttpRoutes {
  namespace: string;
  prefix: string;
}

export function parseHttpFlag(flag: string): HttpRoutes {
  const [namespace, prefix = "/api"] = flag.split("=") as [string, string | undefined];
  return { namespace, prefix: "/" + prefix.replace(/^\/+|\/+$/g, "") };
}

/** URL → name: `/api/hooks/stripe` → `<namespace>.hooks.stripe`, `/api` → `<namespace>.index`; `-` reads as `_`. */
function routeName(routes: HttpRoutes, pathname: string): string | undefined {
  if (pathname !== routes.prefix && !pathname.startsWith(routes.prefix + "/")) return undefined;
  const rest = pathname.slice(routes.prefix.length).replace(/^\/+|\/+$/g, "");
  const segs = rest ? rest.split("/").map((s) => s.replaceAll("-", "_")) : ["index"];
  return segs.every((s) => /^[A-Za-z_$][\w$]*$/.test(s)) ? [routes.namespace, ...segs].join(".") : "";
}

/**
 * Serve plain HTTP endpoints, for webhooks and API clients outside the app. A handler takes a standard `Request`
 * and returns a `Response`, plain data (sent as JSON) or nothing (204). The name is resolved on every request,
 * so moving a name moves its URL. There are no CSRF checks here: these are meant to be called from elsewhere.
 */
function httpHandler(cb: Codebase, routes: HttpRoutes, opts: RpcOptions): Middleware {
  const host = serverApiHost(cb);
  const data = dataDir(cb);
  return async (req, res, next) => {
    const url = new URL(req.url ?? "/", `${opts.secure ? "https" : "http"}://${req.headers.host ?? "localhost"}`);
    const name = routeName(routes, url.pathname);
    if (name === undefined) return next();
    const started = performance.now();
    const reply = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
      const mark = status < 400 ? green(String(status)) : red(String(status));
      console.log(`  ${dim("→")} ${req.method} ${url.pathname} ${dim(name || "?")} ${mark} ${dim(`${Math.round(performance.now() - started)}ms`)}`);
    };
    let hash: string;
    try {
      hash = cb.lookupOne(name, "value");
    } catch {
      return reply(404, { error: `no endpoint at ${url.pathname}` });
    }
    const rec = cb.store.getDef(hash)!;
    if (rec.kind !== "term") return reply(404, { error: `no endpoint at ${url.pathname}` });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 16 * 1024 * 1024) return reply(413, { error: "request body too large" });
      chunks.push(c as Buffer);
    }
    materialize([hash], cb.source(), cb.lay);
    const fn = ((await import(pathToFileURL(path.join(cb.lay.cacheDir, `${rec.componentHash}.ts`)).href)) as Record<string, unknown>)[exportId(hash)];
    if (typeof fn !== "function") return reply(404, { error: `${name} isn't a function` });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, x);
    const method = req.method ?? "GET";
    const request = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks) });
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort(new Error("the client disconnected"));
    });
    const { HttpError, withCall } = await host();
    const call = { method, url: url.href, headers: req.headers, ip: req.socket.remoteAddress, signal: abort.signal };
    const r = await withCall(call, { secure: opts.secure, dataDir: data }, async () => (fn as (r: Request) => unknown)(request));
    const cookies: Record<string, string | string[]> = r.setCookies.length ? { "set-cookie": r.setCookies } : {};
    if (!r.ok) {
      const err = errorReply(r.error as Error & { status?: number; retryAfter?: number }, r.error instanceof HttpError, name, opts.production);
      if (err.retryAfter !== undefined) cookies["retry-after"] = String(err.retryAfter);
      return reply(err.status, { error: (err.body as { message: string }).message }, cookies);
    }
    if (r.value instanceof Response) {
      const out: Record<string, string | string[]> = { ...cookies };
      r.value.headers.forEach((v, k) => (out[k] = k === "set-cookie" ? [...((out[k] as string[] | undefined) ?? []), v] : v));
      res.writeHead(r.value.status, out);
      res.end(Buffer.from(await r.value.arrayBuffer()));
      console.log(`  ${dim("→")} ${method} ${url.pathname} ${dim(name)} ${r.value.status < 400 ? green(String(r.value.status)) : red(String(r.value.status))} ${dim(`${Math.round(performance.now() - started)}ms`)}`);
      return;
    }
    if (r.value === undefined) {
      res.writeHead(204, cookies);
      return res.end();
    }
    reply(200, r.value, cookies);
  };
}

function printRoutes(cb: Codebase, routes: HttpRoutes, url: string) {
  const names = cb.store.names().filter((n) => n.kind === "term" && n.path.startsWith(routes.namespace + "."));
  if (!names.length) return console.log(`  http     ${dim(`nothing under ${routes.namespace} yet (it would be served at ${routes.prefix}/…)`)}`);
  for (const n of names) {
    const segs = n.path.slice(routes.namespace.length + 1).split(".");
    const p = segs.join("/") === "index" ? routes.prefix : `${routes.prefix}/${segs.join("/")}`;
    console.log(`  http     ${new URL(p, url).href} ${dim(`→ ${n.path}`)}`);
  }
}

function reportPlan(cb: Codebase, appName: string, plan: AppPlan) {
  if (plan.errors.length) {
    console.log(red(`\n  ${appName} can't run in the browser yet:`));
    for (const e of plan.errors) console.log(red(`    ${e}`));
    return;
  }
  console.log(`  browser  ${plan.browser.size} definition(s)`);
  const endpoints = [...plan.endpoints].map((h) => `${cb.displayRef(`#${h}`)} ${dim(shortHash(h))}`);
  console.log(`  server   ${endpoints.length ? `${endpoints.length} function(s) the browser calls by hash: ${endpoints.join(", ")}` : dim("nothing (the app runs entirely in the browser)")}`);
  const names = (hs: string[]) => hs.map((h) => cb.displayRef(`#${h}`)).join(", ");
  if (plan.state.server.length) console.log(`  state    ${names(plan.state.server)} ${dim("on the server, shared by every client")}`);
  if (plan.state.browser.length) console.log(`  state    ${names(plan.state.browser)} ${dim("in the browser, one copy per tab")}`);
  for (const h of plan.state.both) {
    console.log(yellow(`  warning  ${cb.displayRef(`#${h}`)} is used by both browser and server code, so the server and each tab have separate copies`));
  }
}

/**
 * Call `onChange` when the codebase changes (`ucm update`, `mv`, `pull`, ... in another shell). One command can
 * change names in several steps (an update, then its propagation), so act only once things have settled for a poll.
 */
function watchCodebase(cb: Codebase, onChange: () => void | Promise<void>): () => void {
  const headOf = () => {
    cb.store.forgetBranch();
    return `${cb.store.branch().name}:${cb.store.logHead()}`;
  };
  let seen = headOf();
  let pending: string | undefined;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    const head = headOf();
    if (head === seen) return;
    if (head !== pending) {
      pending = head;
      return;
    }
    seen = head;
    busy = true;
    try {
      await onChange();
    } catch (e) {
      console.log(red(`  ${(e as Error).message}`));
    } finally {
      busy = false;
    }
  }, 400);
  return () => clearInterval(timer);
}

// ---- dev -------------------------------------------------------------------------------------------------------

export async function dev(cb: Codebase, appName: string, port: number, routes?: HttpRoutes): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("vite");
  const root = path.join(cb.lay.ucmDir, "web");
  let state = planApp(cb, appName);
  writeBuildRoot(cb, root, appName, state);

  const rpc = rpcHandler(cb, (h) => state.plan.endpoints.has(h));
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "warn",
    clearScreen: false,
    appType: "spa",
    plugins: [
      ucmPlugin(cb, () => state.plan),
      {
        name: "ucm-rpc",
        configureServer: (s) => {
          s.middlewares.use(rpc);
          if (routes) s.middlewares.use(httpHandler(cb, routes, { production: false, secure: false }));
        },
      },
    ],
    server: { port, host: "127.0.0.1", fs: { allow: [cb.lay.ucmDir] } },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
  console.log(`${bold("ucm dev")} ${appName} ${dim(shortHash(state.hash))}\n  url      ${url}`);
  reportPlan(cb, appName, state.plan);
  if (routes) printRoutes(cb, routes, url);

  const stop = watchCodebase(cb, () => {
    const before = state.hash;
    state = planApp(cb, appName);
    writeBuildRoot(cb, root, appName, state);
    server.moduleGraph.invalidateAll();
    server.ws.send({ type: "full-reload" });
    console.log(`\n${yellow("reloaded")} ${appName} ${dim(before === state.hash ? "(names changed)" : `${shortHash(before)} → ${shortHash(state.hash)}`)}`);
    reportPlan(cb, appName, state.plan);
  });
  return {
    url,
    close: async () => {
      stop();
      await server.close();
    },
  };
}

// ---- build -----------------------------------------------------------------------------------------------------

export interface BuildManifest {
  app: string;
  hash: string;
  endpoints: string[];
  builtAt: string;
}

const appsDir = (cb: Codebase) => path.join(cb.lay.ucmDir, "apps");
const manifestFile = (cb: Codebase, hash: string) => path.join(appsDir(cb), hash, "ucm-app.json");

/**
 * Build the app as its name currently resolves, into .ucm/apps/<hash>/ with assets under /_app/<hash>/.
 * A build is a pure function of the hash, so an existing one is reused.
 */
export async function build(cb: Codebase, appName: string, opts: { force?: boolean; quiet?: boolean } = {}): Promise<BuildManifest> {
  const state = planApp(cb, appName);
  if (state.plan.errors.length) {
    throw new Error(`${appName} can't run in the browser yet:\n  ${state.plan.errors.join("\n  ")}`);
  }
  const outDir = path.join(appsDir(cb), state.hash);
  if (!opts.force && fs.existsSync(manifestFile(cb, state.hash))) {
    return JSON.parse(fs.readFileSync(manifestFile(cb, state.hash), "utf8")) as BuildManifest;
  }
  const { build: viteBuild } = await import("vite");
  const root = path.join(cb.lay.ucmDir, "build", state.hash);
  writeBuildRoot(cb, root, appName, state);
  await viteBuild({
    configFile: false,
    root,
    base: `/_app/${state.hash}/`,
    logLevel: "warn",
    plugins: [ucmPlugin(cb, () => state.plan)],
    build: { outDir, emptyOutDir: true },
  });
  const manifest: BuildManifest = { app: appName, hash: state.hash, endpoints: [...state.plan.endpoints], builtAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile(cb, state.hash), JSON.stringify(manifest, null, 2) + "\n");
  fs.rmSync(root, { recursive: true, force: true });
  if (!opts.quiet) {
    console.log(`${green("built")} ${bold(appName)} ${dim(shortHash(state.hash))} into ${path.relative(cb.lay.root, outDir)}`);
    reportPlan(cb, appName, state.plan);
  }
  return manifest;
}

// ---- start -----------------------------------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

export interface StartOptions {
  port: number;
  host: string;
  tls?: { cert: string; key: string };
  /** after each deploy, keep only this many earlier builds of the app */
  keep?: number;
  /** plain HTTP endpoints, from a namespace */
  http?: HttpRoutes;
}

/** Builds on disk, newest first. */
export function listBuilds(cb: Codebase): BuildManifest[] {
  if (!fs.existsSync(appsDir(cb))) return [];
  return fs
    .readdirSync(appsDir(cb))
    .filter((h) => fs.existsSync(manifestFile(cb, h)))
    .map((h) => JSON.parse(fs.readFileSync(manifestFile(cb, h), "utf8")) as BuildManifest)
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt));
}

/**
 * Delete old builds: per app, keep the build its name points to now plus the newest `keep` others. Tabs still
 * on a deleted build reload themselves onto the current one at their next server call.
 */
export function pruneBuilds(cb: Codebase, keep: number, quiet = false): BuildManifest[] {
  const current = new Set<string>();
  const byApp = new Map<string, BuildManifest[]>();
  for (const b of listBuilds(cb)) {
    byApp.set(b.app, [...(byApp.get(b.app) ?? []), b]);
    try {
      current.add(cb.lookupOne(b.app, "value"));
    } catch {
      // the app's name is gone: nothing of it is current
    }
  }
  const removed: BuildManifest[] = [];
  for (const builds of byApp.values()) {
    const others = builds.filter((b) => !current.has(b.hash));
    for (const b of others.slice(keep)) {
      fs.rmSync(path.join(appsDir(cb), b.hash), { recursive: true, force: true });
      removed.push(b);
    }
  }
  if (!quiet) console.log(removed.length ? `removed ${removed.length} build(s): ${removed.map((b) => `${b.app} ${shortHash(b.hash)}`).join(", ")}` : dim("nothing to prune"));
  return removed;
}

/**
 * Serve the app in production: the build its name points to now, plus every earlier build, so open tabs keep
 * working across deploys. When the name moves, the new version is built (if needed) and becomes current.
 */
export async function start(cb: Codebase, appName: string, opts: StartOptions): Promise<{ url: string; close: () => Promise<void> }> {
  let current = await build(cb, appName);
  // every retained build's endpoints stay callable: old clients call the hashes they were built against.
  // Re-read whenever the set of builds changes (a deploy here, or `ucm apps prune` in another shell).
  let endpoints = new Set<string>();
  const ever = new Set<string>();
  let buildsSeen = "";
  const loadEndpoints = () => {
    const builds = listBuilds(cb);
    const key = builds.map((b) => b.hash).join(",");
    if (key === buildsSeen) return;
    buildsSeen = key;
    endpoints = new Set(builds.flatMap((b) => b.endpoints));
    for (const e of endpoints) ever.add(e);
  };
  loadEndpoints();
  const rescan = setInterval(loadEndpoints, 1000);
  const rpc = rpcHandler(
    cb,
    (h) => endpoints.has(h),
    // was an endpoint of a build this server has served, or is code in the codebase: an old page, not an attack
    (h) => ever.has(h) || cb.store.hasDef(h),
    { production: true, secure: !!opts.tls },
  );

  const serveFile = (res: http.ServerResponse, file: string, immutable: boolean) => {
    res.statusCode = 200;
    res.setHeader("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    fs.createReadStream(file).pipe(res);
  };
  const routes = opts.http ? httpHandler(cb, opts.http, { production: true, secure: !!opts.tls }) : (_q: http.IncomingMessage, _s: http.ServerResponse, next: () => void) => next();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    rpc(req, res, () => routes(req, res, () => {
      const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const asset = /^\/_app\/([a-z2-7]{52})\/(.+)$/.exec(url);
      if (asset) {
        // any build's assets, so pages loaded before a deploy can still fetch theirs (paths are content-addressed)
        const dir = path.join(appsDir(cb), asset[1]!);
        const file = path.resolve(dir, asset[2]!);
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end("not found");
        }
        return serveFile(res, file, true);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        return res.end();
      }
      // everything else is the current build's page (client-side routes included)
      serveFile(res, path.join(appsDir(cb), current.hash, "index.html"), false);
    }));
  };
  const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
  await new Promise<void>((r) => server.listen(opts.port, opts.host, r));
  const { port } = server.address() as { port: number };
  const url = `${opts.tls ? "https" : "http"}://${opts.host}:${port}/`;
  console.log(`${bold("ucm start")} ${appName} ${dim(shortHash(current.hash))}\n  url      ${url}`);
  console.log(`  server   ${endpoints.size} callable function hash(es) across ${fs.readdirSync(appsDir(cb)).length} build(s)`);
  if (opts.http) printRoutes(cb, opts.http, url);

  const stop = watchCodebase(cb, async () => {
    const next = await build(cb, appName, { quiet: true });
    if (next.hash === current.hash) return;
    const before = current.hash;
    current = next;
    if (opts.keep !== undefined) pruneBuilds(cb, opts.keep, true);
    loadEndpoints();
    console.log(`${yellow("deployed")} ${appName} ${dim(`${shortHash(before)} → ${shortHash(next.hash)}`)}; earlier builds keep working`);
    reportPlan(cb, appName, planApp(cb, appName).plan);
  });
  return {
    url,
    close: async () => {
      clearInterval(rescan);
      stop();
      await new Promise((r) => server.close(r));
    },
  };
}
