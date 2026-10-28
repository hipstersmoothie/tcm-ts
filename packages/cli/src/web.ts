// Browser apps served straight from the codebase, with server functions called by hash.
//
// - `tcm dev <app>`: a Vite dev server, reloading when the codebase changes under the app.
// - `tcm build <app>`: a production build into .tcm/apps/<app hash>/, immutable and content-addressed.
// - `tcm start <app>`: serves whichever build the app's name points to now, and keeps earlier builds working:
//   their assets stay served and their server functions stay callable, so a tab opened before a deploy keeps
//   calling the code it was built against. Deploying and rolling back are both just moving the name.
//
// In all three, a Vite plugin swaps every component that has to run on the server for a stub module whose exports
// call it by hash (`POST /__tcm/rpc/<hash>`), so server code never reaches the browser. The server answers those
// calls by importing the real module, but only for hashes a build actually calls (its endpoints): anything the
// browser can reach is a public endpoint.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { checkArgs, exportId, SERVER_API_MODULE, shortHash, type DefRecord } from "@tcm/core";
import { ensureExternals, materialize, moduleFile, npmAlias, writeIfChanged } from "@tcm/loader";
import type { Codebase } from "./codebase.ts";
import { codecSource, decode, encode } from "./codec.ts";
import { Placement, type AppPlan } from "./placement.ts";
import { reactRuntimeSource, renderServerComponent } from "./rsc.ts";
import { bold, dim, green, red, yellow } from "./style.ts";

const RUNTIME = "virtual:tcm-runtime";
const CODEC = "virtual:tcm-codec";
const STUB = "\0tcm-stub:";
const REACT_RUNTIME = "\0tcm-react:";
const HASH_FILE = /(?:^|\/)([a-z2-7]{52})\.tsx?$/;

const runtimeSource = `import { encode, decode } from ${JSON.stringify(CODEC)};

const callListeners = new Set();
/** Run \`f\` after each server function call this page makes; returns an unsubscribe function. */
export function onServerCall(f) {
  callListeners.add(f);
  return () => callListeners.delete(f);
}

/** This page's build was retired: reload to get the current version. */
export function reloadOutdated() {
  if (!globalThis.__tcmReloading) {
    globalThis.__tcmReloading = true;
    location.reload();
  }
  return new Promise(() => {});
}

/** A function that runs on the server, called by hash. */
export function remote(hash, name, callable) {
  const fn = async (...args) => {
    if (!callable) throw new Error(name + " runs on the server and this app doesn't call it from the browser");
    let res;
    try {
      res = await fetch("/__tcm/rpc/" + hash, { method: "POST", headers: { "content-type": "application/json" }, body: encode(args, "arguments to " + name) });
    } catch (e) {
      throw new Error(name + ": the server is unreachable (" + e.message + ")");
    }
    // this page's build was retired: reload to get the current version
    if (res.status === 410) return reloadOutdated();
    const body = decode(await res.text());
    // whether it worked or not, the call may have changed what the server shows
    for (const f of callListeners) f();
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
        const res = await fetch("/__tcm/rpc/" + hash, { method: "POST", headers: { "content-type": "application/json" }, body: encode(args, "arguments to " + name), signal: stop.signal });
        if (res.status === 410 && !globalThis.__tcmReloading) {
          globalThis.__tcmReloading = true;
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
  /** the app is a React component: the pinned React and React DOM (aliases) its entry renders it with */
  react?: { react: string; dom: string };
}

/** Resolve the app's name, materialize its closure, and work out what goes where. */
export function planApp(cb: Codebase, appName: string): AppState {
  const hash = cb.lookupOne(appName, "value");
  materialize([hash], cb.source(), cb.lay); // the whole closure, server side included, with npm packages
  const placement = new Placement(cb);
  const plan = placement.planApp(hash);
  cb.ensureParams(plan.endpoints);
  const jsx = cb.store.getDef(hash)?.jsx;
  if (!placement.isComponent(hash) || !jsx?.startsWith("npm:react@")) return { hash, plan };
  // React and React DOM are released together: the same version renders it
  const dom = { module: jsx.replace(/^npm:react@/, "npm:react-dom@"), subpath: "client", export: "createRoot" };
  ensureExternals(cb.lay, [dom]);
  return { hash, plan, react: { react: npmAlias(jsx), dom: npmAlias(dom.module) } };
}

/** The entry module for a build root: start the app, or show why it can't run in the browser. */
function entrySource(cb: Codebase, appName: string, s: AppState, cacheRel: string): string {
  if (s.plan.errors.length) {
    const html = `<pre style="color:#b00;white-space:pre-wrap;font:14px ui-monospace,monospace;padding:1em">${escapeHtml(s.plan.errors.join("\n\n"))}</pre>`;
    return `// ${appName} can't run in the browser yet\ndocument.body.innerHTML = ${JSON.stringify(html)};\n`;
  }
  const rec = cb.store.getDef(s.hash)!;
  const from = `${cacheRel}/${path.basename(cb.modulePath(rec.componentHash))}`;
  if (s.react) {
    // the app is a component: render it into the page with the React DOM of the same version
    return [
      `// generated by tcm: ${appName} ${rec.hash}`,
      `import { createElement } from "${s.react.react}";`,
      `import { createRoot, hydrateRoot } from "${s.react.dom}/client";`,
      `import { ${exportId(rec.hash)} as App } from "${from}";`,
      `// cookies the server set while streaming this page, after its headers had gone out`,
      `declare const __TCM_COOKIES__: string | undefined;`,
      `if (typeof __TCM_COOKIES__ === "string") void fetch("/__tcm/cookies/" + __TCM_COOKIES__, { method: "POST" });`,
      `const root = document.getElementById("app")!;`,
      `// the server rendered the first paint: take it over, rather than render it again`,
      `if (root.hasChildNodes()) hydrateRoot(root, createElement(App));`,
      `else createRoot(root).render(createElement(App));`,
      "",
    ].join("\n");
  }
  return `// generated by tcm: ${appName} ${rec.hash}\nimport { ${exportId(rec.hash)} as main } from "${from}";\nconst app: unknown = main;\nif (typeof app === "function") await app();\n`;
}

/**
 * The server-rendering entry for a component app: streams its HTML. The shell (everything outside `<Suspense>`
 * boundaries still waiting) goes out first, the rest as it's ready. Server components render through the host
 * (see renderPage).
 */
function ssrSource(cb: Codebase, appName: string, s: AppState, cacheRel: string): string {
  const rec = cb.store.getDef(s.hash)!;
  return [
    `// generated by tcm: server rendering for ${appName} ${rec.hash}`,
    `import { Writable } from "node:stream";`,
    `import { createElement } from "${s.react!.react}";`,
    `import { renderToPipeableStream } from "${s.react!.dom}/server";`,
    `import { ${exportId(rec.hash)} as App } from "${cacheRel}/${path.basename(cb.modulePath(rec.componentHash))}";`,
    `/** Resolves once the shell is written; \`done\` once all of it is. Rejects if the shell can't render. */`,
    `export function render(write: (html: string) => void, onError: (e: unknown) => void): Promise<{ done: Promise<void> }> {`,
    `  return new Promise((shell, fail) => {`,
    `    let finished!: () => void;`,
    `    const done = new Promise<void>((r) => (finished = r));`,
    `    const sink = new Writable({ write(chunk, _e, next) { write(String(chunk)); next(); }, final(next) { finished(); next(); } });`,
    `    const stream = renderToPipeableStream(createElement(App), {`,
    `      onShellReady() { stream.pipe(sink); shell({ done }); },`,
    `      onShellError: fail,`,
    `      onError,`,
    `    });`,
    `  });`,
    `}`,
    "",
  ].join("\n");
}

function writeBuildRoot(cb: Codebase, dir: string, appName: string, s: AppState) {
  fs.mkdirSync(dir, { recursive: true });
  // the pinned packages, found from here as from the cache: Vite's own lookups (server rendering decides what to
  // load with Node by them) see the same packages the generated modules import
  const modules = path.join(dir, "node_modules");
  // lstat: the link dangles until the codebase uses an npm package, and existsSync follows it
  if (!fs.lstatSync(modules, { throwIfNoEntry: false })) fs.symlinkSync(path.relative(dir, path.join(cb.lay.cacheDir, "node_modules")), modules, "dir");
  writeIfChanged(
    path.join(dir, "index.html"),
    `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>${escapeHtml(appName)}</title></head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="./entry.ts"></script>\n  </body>\n</html>\n`,
  );
  const cacheRel = path.relative(dir, cb.lay.cacheDir).split(path.sep).join("/");
  writeIfChanged(path.join(dir, "entry.ts"), entrySource(cb, appName, s, cacheRel));
  if (s.react && !s.plan.errors.length) writeIfChanged(path.join(dir, "ssr.ts"), ssrSource(cb, appName, s, cacheRel));
  else fs.rmSync(path.join(dir, "ssr.ts"), { force: true });
}

/** Swaps server components for stubs that call them by hash, and provides the browser runtime. */
/** Where definitions come from: the store, or the store plus unsaved ones (a browser test's, say). */
interface Lookup {
  get(hash: string): DefRecord | undefined;
  members(componentHash: string): DefRecord[];
}

const storeLookup = (cb: Codebase): Lookup => ({ get: (h) => cb.store.getDef(h), members: (c) => cb.store.componentMembers(c) });

/** A component's module in the cache, from a lookup (`.tsx` when it uses JSX). */
const modulePathIn = (cb: Codebase, look: Lookup, componentHash: string) => path.join(cb.lay.cacheDir, moduleFile(componentHash, look));

function tcmPlugin(cb: Codebase, current: () => AppPlan, look: Lookup = storeLookup(cb)): Plugin {
  return {
    name: "tcm",
    // ahead of Vite's own resolver: server components must be swapped for stubs before they are resolved as files
    enforce: "pre",
    async resolveId(source, importer) {
      if (source === RUNTIME || source === CODEC) return "\0" + source;
      if (source.startsWith(REACT_RUNTIME)) return source;
      const m = HASH_FILE.exec(source);
      if (m && (/^\.\.?\//.test(source) || path.isAbsolute(source)) && current().stubbed.has(m[1]!)) return STUB + m[1];
      // generated modules import pinned packages (npm__react__19.3.1), installed in the cache
      if (/^npm__/.test(source) && importer && !importer.startsWith(cb.lay.cacheDir + path.sep)) return this.resolve(source, path.join(cb.lay.cacheDir, "index.js"), { skipSelf: true });
      return null;
    },
    load(id) {
      if (id === "\0" + RUNTIME) return runtimeSource;
      if (id === "\0" + CODEC) return codecSource();
      if (id.startsWith(REACT_RUNTIME)) return reactRuntimeSource(id.slice(REACT_RUNTIME.length), RUNTIME, CODEC);
      if (!id.startsWith(STUB)) return null;
      const members = look.members(id.slice(STUB.length));
      const plan = current();
      const lines = [`import { remote, remoteStream } from ${JSON.stringify(RUNTIME)};`];
      for (const m of members) {
        if (plan.components.has(m.hash) && m.jsx?.startsWith("npm:")) {
          // a server component: the browser components its tree can contain ship with it, referenced by hash
          const refs = [...(plan.refsOf.get(m.hash) ?? [])];
          lines.unshift(`import { serverComponent as serverComponent_${m.hash} } from ${JSON.stringify(REACT_RUNTIME + npmAlias(m.jsx))};`);
          for (const r of refs) lines.push(`import { ${exportId(r)} } from ${JSON.stringify(modulePathIn(cb, look, look.get(r)!.componentHash))};`);
          lines.push(`export const ${exportId(m.hash)} = serverComponent_${m.hash}(${JSON.stringify(m.hash)}, ${JSON.stringify(m.nameHint)}, { ${refs.map((r) => `${JSON.stringify(r)}: ${exportId(r)}`).join(", ")} });`);
        } else if (plan.streaming.has(m.hash)) lines.push(`export const ${exportId(m.hash)} = remoteStream(${JSON.stringify(m.hash)}, ${JSON.stringify(m.nameHint)});`);
        else lines.push(`export const ${exportId(m.hash)} = remote(${JSON.stringify(m.hash)}, ${JSON.stringify(m.nameHint)}, ${plan.endpoints.has(m.hash)});`);
      }
      return lines.join("\n");
    },
  };
}

type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;

/** Answers `POST /__tcm/rpc/<hash>` for hashes `isEndpoint` accepts, by importing and calling the real function. */
type Fn = (...args: unknown[]) => unknown;

interface ServerApiHost {
  startWorker: (opts: { dataDir: string; load: (hash: string) => Promise<Fn>; log: (line: string) => void }) => () => void;
  setSchedules: (opts: { dataDir: string; jobs: { name: string; spec: string; fn: Fn; hash: string }[]; log?: (line: string) => void }) => void;
  HttpError: new (status: number, message: string) => Error & { status: number; retryAfter?: number };
  withCall: <T>(
    call: { method: string; url: string; headers: Record<string, string | string[] | undefined>; ip: string | undefined; signal: AbortSignal },
    opts: { secure: boolean; dataDir?: string },
    fn: () => Promise<T>,
  ) => Promise<{ ok: true; value: T; setCookies: string[] } | { ok: false; error: unknown; setCookies: string[] }>;
  pendingCookies: () => string[];
}

/** The `#tcm/server` instance the codebase's generated modules import, so server functions see their call. */
function serverApiHost(cb: Codebase): () => Promise<ServerApiHost> {
  let api: Promise<ServerApiHost> | undefined;
  return () => (api ??= import(pathToFileURL(path.join(cb.lay.cacheDir, "tcm-server.js")).href) as Promise<ServerApiHost>);
}

/**
 * `tcm data migrate <table>`: bring every stored row of a table up to its current row type now, through the
 * table's current code (its `migrate` steps), instead of as rows are read. `target` is a table name ("users") or
 * the name of its definition ("crm.users").
 */
export async function migrateTable(cb: Codebase, target: string): Promise<boolean> {
  const src = cb.source();
  const named = [...new Set(cb.store.names().map((n) => n.hash))];
  const byName = cb.lookup(target).filter((h) => src.get(h)?.table);
  const hashes = byName.length ? byName : named.filter((h) => src.get(h)?.table?.name === target);
  if (hashes.length !== 1) {
    const which = hashes.map((h) => cb.displayRef(`#${h}`)).join(", ");
    console.log(red(hashes.length ? `"${target}" is declared by ${hashes.length} definitions (${which}); name one` : `no table "${target}" (a table name, or the definition declaring it)`));
    return false;
  }
  const hash = hashes[0]!;
  const rec = src.get(hash)!;
  const name = rec.table!.name ?? target;
  materialize([hash], src, cb.lay);
  const api = await serverApiHost(cb)();
  const mod = (await import(pathToFileURL(cb.modulePath(rec.componentHash)).href)) as Record<string, Record<symbol, () => Promise<unknown>>>;
  const t = mod[exportId(hash)]!;
  const call = { method: "CLI", url: "/", headers: {}, ip: undefined, signal: new AbortController().signal };
  const r = await api.withCall(call, { secure: false, dataDir: dataDir(cb) }, () => t[Symbol.for("tcm.migrateAll")]!.call(t));
  if (!r.ok) throw r.error;
  const { total, restamped, migrated, newer, failed } = r.value as { total: number; restamped: number; migrated: number; newer: number; failed: { id: string; why: string }[] };
  const already = total - restamped - migrated - newer - failed.length;
  console.log(`table "${name}": ${total} row(s): ${already} already current, ${migrated} migrated, ${restamped} still fit as stored`);
  for (const f of failed) console.log(red(`  ${f.id}: ${f.why}`));
  if (newer) console.log(yellow(`  ${newer} row(s) were written by newer code than the codebase's; left as they are`));
  if (failed.length || newer) return !failed.length;
  console.log(
    green(
      rec.table!.steps?.length
        ? `every row now has the current row type, so migrate has nothing left to do: you can remove it from table("${name}"). Keep it while an older build that writes the old type is still running.`
        : "every row now has the current row type",
    ),
  );
  return true;
}

/** App data (sessions) lives apart from the codebase: .tcm/data. */
function dataDir(cb: Codebase): string {
  const d = path.join(cb.lay.tcmDir, "data");
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

/** Which endpoints are server components, and which components they send to the browser as references. */
export interface ComponentPlan {
  isComponent(hash: string): boolean;
  isClientRef(hash: string): boolean;
}

export interface RpcOptions {
  /** production hides unexpected errors from the browser (they're logged here); dev shows them */
  production: boolean;
  /** served over TLS: cookies default to Secure */
  secure: boolean;
}

function rpcHandler(
  cb: Codebase,
  isEndpoint: (hash: string) => boolean,
  retired: (hash: string) => boolean = () => false,
  opts: RpcOptions = { production: false, secure: false },
  components: ComponentPlan = { isComponent: () => false, isClientRef: () => false },
  look: Lookup = storeLookup(cb),
): Middleware {
  const host = serverApiHost(cb);
  const data = dataDir(cb);
  return async (req, res, next) => {
    const m = /^\/__tcm\/rpc\/([a-z2-7]{52})$/.exec((req.url ?? "").split("?")[0]!);
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
    const rec = look.get(hash)!;
    // arguments come from the network: check them against the function's parameter types before calling it
    // a server component gets its props: none at all if it takes none
    const component = components.isComponent(hash);
    const problem = rec.params && checkArgs(rec.params, component && !rec.params.params.length ? [] : args);
    if (problem) return send(400, { name: "TypeError", message: `${name}: ${problem}` });
    // a hash names immutable code, so Node's module cache can never serve a stale version of it
    const fn = ((await import(pathToFileURL(modulePathIn(cb, look, rec.componentHash)).href)) as Record<string, (...a: unknown[]) => unknown>)[exportId(hash)]!;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort(new Error("the client disconnected"));
    });
    const { HttpError, withCall, pendingCookies } = await host();
    const call = { method: req.method ?? "POST", url: req.url ?? "/", headers: req.headers, ip: req.socket.remoteAddress, signal: abort.signal };
    const r = await withCall(call, { secure: opts.secure, dataDir: data }, async () => {
      if (component) {
        // the tree, then each <Suspense> boundary's contents as it finishes, one message per line
        const describe = (e: unknown) => errorReply(e as Error, e instanceof HttpError, name, opts.production).body;
        let sent = 0;
        await renderComponent(cb, fn, (args as unknown[])[0], components, describe, (msg) => {
          // encoded first: a tree that can't be sent is an error reply, not half a response
          const line = encode(msg, `the tree of ${name}`) + "\n";
          if (!sent++) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", ...(pendingCookies().length ? { "set-cookie": pendingCookies() } : {}) });
          if (!abort.signal.aborted) res.write(line);
        });
        res.end(encode({ done: true }) + "\n");
        console.log(`  ${dim("→")} ${name} ${green("rendered")} ${dim(`${sent > 1 ? `${sent - 1} boundar${sent === 2 ? "y" : "ies"} streamed, ` : ""}${Math.round(performance.now() - started)}ms`)}`);
        return STREAMED;
      }
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

/**
 * Vite plugins for browser tests: like an app's (server code stubbed, called by hash), with the endpoints
 * answered by the test server itself. `get` sees definitions not stored yet.
 */
export function testPlugins(cb: Codebase, tests: string[], get: (h: string) => DefRecord | undefined, members: (c: string) => DefRecord[]): Plugin[] {
  const placement = new Placement(cb, get);
  const plan: AppPlan = {
    browser: new Set(), components: new Set(), clientRefs: new Set(), refsOf: new Map(), endpoints: new Set(), stubbed: new Set(), streaming: new Set(), errors: [], warnings: [],
    state: { server: [], browser: [], both: [] },
  };
  for (const t of tests) {
    const p = placement.planApp(t);
    for (const k of ["browser", "components", "clientRefs", "endpoints", "stubbed", "streaming"] as const) for (const h of p[k]) plan[k].add(h);
    for (const [k, v] of p.refsOf) plan.refsOf.set(k, v);
  }
  const look: Lookup = { get, members };
  const components: ComponentPlan = { isComponent: (h) => plan.components.has(h), isClientRef: (h) => plan.clientRefs.has(h) };
  const rpc = rpcHandler(cb, (h) => plan.endpoints.has(h), undefined, undefined, components, look);
  return [tcmPlugin(cb, () => plan, look), { name: "tcm-rpc", configureServer: (s) => void s.middlewares.use(rpc) }];
}

/** A server component's render as messages: `{ v }` its tree, then `{ s, v }` / `{ s, e }` for each boundary. */
type TreeMessage = { v: unknown } | { s: number; v: unknown } | { s: number; e: { name: string; message: string } };

/**
 * Render server component `fn` with `props`, passing each message to `emit` as it's ready. Errors rendering the
 * tree itself are thrown (before anything is emitted); errors inside a boundary go to that boundary.
 */
async function renderComponent(
  cb: Codebase,
  fn: (...a: unknown[]) => unknown,
  props: unknown,
  components: ComponentPlan,
  describe: (e: unknown) => { name: string; message: string },
  emit: (msg: TreeMessage) => void,
): Promise<void> {
  const ctx = { isClientRef: (h: string) => components.isClientRef(h), name: (h: string) => cb.displayRef(`#${h}`), describe };
  const rendered = await renderServerComponent(fn, (props ?? {}) as Record<string, unknown>, ctx);
  emit({ v: rendered.root });
  for await (const c of rendered.chunks) {
    try {
      emit("tree" in c ? { s: c.id, v: c.tree } : { s: c.id, e: c.error });
    } catch (e) {
      // a boundary's contents that can't be sent (encode refuses them) fail that boundary only
      emit({ s: c.id, e: describe(e) });
    }
  }
}

// ---- server rendering: the first paint ------------------------------------------------------------------------

/** One page being rendered: its URL, the server component trees rendered so far, and how to render one. */
interface SsrRequest {
  url: URL;
  cache: Map<string, unknown>;
  trees: Record<string, { root?: unknown; chunks: Record<number, { v?: unknown; e?: unknown }> }>;
  render(hash: string, body: string, onMessage: (msg: TreeMessage) => void): Promise<void>;
}

const ssrRequests = new AsyncLocalStorage<SsrRequest>();

/**
 * Cookies a page's server components set after its headers went out (in a boundary that streamed later): the
 * page tells the browser a one-time token, and the browser collects them with it (`POST /__tcm/cookies/<token>`).
 */
const lateCookies = new Map<string, { cookies: string[]; expires: number }>();

/** Answers `POST /__tcm/cookies/<token>` with the cookies kept under that token, once. */
const lateCookieHandler: Middleware = (req, res, next) => {
  const m = /^\/__tcm\/cookies\/([\w-]{20,})$/.exec((req.url ?? "").split("?")[0]!);
  if (!m) return next();
  const now = Date.now();
  for (const [k, v] of lateCookies) if (v.expires < now) lateCookies.delete(k);
  const kept = req.method === "POST" ? lateCookies.get(m[1]!) : undefined;
  lateCookies.delete(m[1]!);
  if (kept) res.setHeader("set-cookie", kept.cookies);
  res.statusCode = kept ? 204 : 404;
  res.end();
};

/**
 * What the browser runtime's stubs use while a page renders on the server (`globalThis.__tcmSsr`), and the page's
 * `location`, so browser code reading the URL renders the same on both sides. Both follow the request being
 * rendered; outside one, `location` is undefined, as it always is in Node.
 */
function installSsr() {
  const g = globalThis as { __tcmSsr?: unknown };
  if (g.__tcmSsr) return;
  g.__tcmSsr = {
    cache: () => ssrRequests.getStore()!.cache,
    render: (hash: string, body: string, onMessage: (msg: TreeMessage) => void) => ssrRequests.getStore()!.render(hash, body, onMessage),
  };
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => ssrRequests.getStore()?.url });
}

/** A request for a page, as opposed to an asset, a module or an API call. */
function isPageRequest(req: http.IncomingMessage): boolean {
  const url = (req.url ?? "/").split("?")[0]!;
  return req.method === "GET" && /text\/html/.test(req.headers.accept ?? "") && !url.startsWith("/__tcm/") && !url.startsWith("/@") && !/\.[\w]+$/.test(url);
}

/**
 * Render the app's page on the server, streaming it into `res`: its HTML in `#app`, then the server component
 * trees it rendered, which the browser hydrates with. Returns false, having written nothing, when the page can't
 * render on the server (it then renders in the browser).
 */
export type RenderApp = (write: (html: string) => void, onError: (e: unknown) => void) => Promise<{ done: Promise<void> }>;

async function renderPage(
  cb: Codebase,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  template: string,
  render: RenderApp,
  components: ComponentPlan,
  opts: RpcOptions,
): Promise<boolean> {
  installSsr();
  const host = await serverApiHost(cb)();
  const data = dataDir(cb);
  const trees: SsrRequest["trees"] = {};
  // cookies server components set: in the page's headers if they're set before those go out, else collected
  // by the browser afterwards
  let started = false;
  const early: string[] = [];
  const late: string[] = [];
  const keep = (cookies: string[]) => (started ? late : early).push(...cookies);
  const page: SsrRequest = {
    url: new URL(req.url ?? "/", `${opts.secure ? "https" : "http"}://${req.headers.host ?? "localhost"}`),
    cache: new Map(),
    trees,
    async render(hash, body, onMessage) {
      if (!components.isComponent(hash)) throw new Error(`${shortHash(hash)} isn't a server component of this app`);
      const name = cb.displayRef(`#${hash}`);
      const rec = cb.store.getDef(hash)!;
      const args = decode(body) as unknown[];
      const problem = rec.params && checkArgs(rec.params, !rec.params.params.length ? [] : args);
      if (problem) throw new TypeError(`${name}: ${problem}`);
      const fn = ((await import(pathToFileURL(cb.modulePath(rec.componentHash)).href)) as Record<string, (...a: unknown[]) => unknown>)[exportId(hash)]!;
      const recorded = (trees[hash + body] = { chunks: {} } as SsrRequest["trees"][string]);
      const describe = (e: unknown) => errorReply(e as Error, e instanceof host.HttpError, name, opts.production).body;
      const call = { method: "GET", url: req.url ?? "/", headers: req.headers, ip: req.socket.remoteAddress, signal: new AbortController().signal };
      // the page's request is the server component's request: its cookies and session
      let taken = 0;
      const take = (all: string[]) => {
        keep(all.slice(taken));
        taken = all.length;
      };
      const r = await host.withCall(call, { secure: opts.secure, dataDir: data }, () =>
        renderComponent(cb, fn, args[0], components, describe, (msg) => {
          take(host.pendingCookies());
          if ("s" in msg) recorded.chunks[msg.s] = "e" in msg ? { e: msg.e } : { v: msg.v };
          else recorded.root = msg.v;
          onMessage(msg);
        }),
      );
      take(r.setCookies);
      if (!r.ok) throw r.error;
    },
  };
  const [head, tail] = template.split('<div id="app"></div>') as [string, string];
  try {
    const { done } = await ssrRequests.run(page, () =>
      render(
        (html) => {
          if (!started) {
            started = true;
            res.setHeader("content-type", "text/html");
            if (early.length) res.setHeader("set-cookie", early);
            res.write(`${head}<div id="app">`);
          }
          res.write(html);
        },
        // a boundary that fails on the server renders in the browser instead
        (e) => console.log(yellow(`  server rendering: ${(e as Error)?.message ?? e} (that part renders in the browser instead)`)),
      ),
    );
    await done;
  } catch (e) {
    if (started) throw e;
    console.log(yellow(`  server rendering failed, so the page renders in the browser: ${(e as Error)?.message ?? e}`));
    return false;
  }
  if (!started) res.write(`${head}<div id="app">`);
  // after the HTML, before the page's script: the trees it hydrates with, and the token for late cookies
  const payload = JSON.stringify(encode(trees, "the server component trees of the page")).replace(/</g, "\\u003c");
  let cookies = "";
  if (late.length) {
    const token = randomBytes(18).toString("base64url");
    lateCookies.set(token, { cookies: late, expires: Date.now() + 60_000 });
    cookies = ` var __TCM_COOKIES__ = ${JSON.stringify(token)};`;
  }
  res.end(`</div><script>var __TCM_TREES__ = ${payload};${cookies}</script>${tail}`);
  return true;
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
    const fn = ((await import(pathToFileURL(cb.modulePath(rec.componentHash)).href)) as Record<string, unknown>)[exportId(hash)];
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

/**
 * Background work for an app: a worker for the durable job queue (functions loaded by hash, so a job runs the
 * code that enqueued it), and the recurring jobs (`every(...)` values) found in the app's namespace.
 */
async function startBackground(cb: Codebase, appName: string) {
  const api = await serverApiHost(cb)();
  const data = dataDir(cb);
  // `<hash>` is a function; `<hash>#fn` is the function inside the recurring job (schedule) with that hash
  const load = async (ref: string): Promise<Fn> => {
    const [hash, part] = ref.split("#") as [string, string | undefined];
    const rec = cb.store.getDef(hash);
    if (!rec) throw new Error(`no definition ${shortHash(hash)} in this codebase`);
    materialize([hash], cb.source(), cb.lay);
    const v = ((await import(pathToFileURL(cb.modulePath(rec.componentHash)).href)) as Record<string, unknown>)[exportId(hash)];
    const fn = part === "fn" ? (v as { fn?: unknown } | undefined)?.fn : v;
    if (typeof fn !== "function") throw new Error(`${cb.displayRef(`#${hash}`)} isn't a function`);
    return fn as Fn;
  };
  const stopWorker = api.startWorker({ dataDir: data, load, log: (line) => console.log(`  ${dim("→")} ${line}`) });
  const ns = appName.includes(".") ? appName.slice(0, appName.lastIndexOf(".")) : "";
  let described = "";
  const refresh = async (quiet = false) => {
    // found from the code itself: definitions in the app's namespace whose value is made by `every(...)`
    const candidates = cb.store
      .names()
      .filter((n) => n.kind === "term" && (!ns || n.path.startsWith(ns + ".")))
      .filter((n) => cb.store.getDef(n.hash)!.spans.some((s) => s.ext?.module === SERVER_API_MODULE && s.ext.export === "every"));
    const jobs: { name: string; spec: string; fn: Fn; hash: string }[] = [];
    for (const n of candidates) {
      const rec = cb.store.getDef(n.hash)!;
      materialize([n.hash], cb.source(), cb.lay);
      const v = ((await import(pathToFileURL(cb.modulePath(rec.componentHash)).href)) as Record<string, unknown>)[exportId(n.hash)] as
        | { [k: symbol]: unknown; spec: string; fn: Fn }
        | undefined;
      if (v && v[Symbol.for("tcm.job")]) jobs.push({ name: n.path, spec: v.spec, fn: v.fn, hash: n.hash });
    }
    api.setSchedules({ dataDir: data, jobs, log: (line) => console.log(red(`  ${line}`)) });
    const now = jobs.map((j) => `${j.name} (${j.spec})`).join(", ");
    if (!quiet && now !== described) console.log(`  jobs     ${jobs.length ? `recurring: ${now}` : dim("no recurring jobs; enqueue() from server functions runs here too")}`);
    described = now;
  };
  await refresh();
  return { refresh, stop: stopWorker };
}

function reportPlan(cb: Codebase, appName: string, plan: AppPlan) {
  if (plan.errors.length) {
    console.log(red(`\n  ${appName} can't run in the browser yet:`));
    for (const e of plan.errors) console.log(red(`    ${e}`));
    return;
  }
  console.log(`  browser  ${plan.browser.size} definition(s)`);
  const endpoints = [...plan.endpoints].filter((h) => !plan.components.has(h)).map((h) => `${cb.displayRef(`#${h}`)} ${dim(shortHash(h))}`);
  const names = (hs: string[]) => hs.map((h) => cb.displayRef(`#${h}`)).join(", ");
  if (plan.components.size) {
    console.log(`  server   ${plan.components.size} component(s) rendered on the server, fetched by hash: ${[...plan.components].map((h) => `${cb.displayRef(`#${h}`)} ${dim(shortHash(h))}`).join(", ")}`);
    if (plan.clientRefs.size) console.log(`  browser  ${names([...plan.clientRefs])} ${dim("rendered in the browser inside server components (sent by hash)")}`);
  }
  if (endpoints.length || !plan.components.size) {
    console.log(`  server   ${endpoints.length ? `${endpoints.length} function(s) the browser calls by hash: ${endpoints.join(", ")}` : dim("nothing (the app runs entirely in the browser)")}`);
  }
  if (plan.state.server.length) console.log(`  state    ${names(plan.state.server)} ${dim("on the server, shared by every client")}`);
  if (plan.state.browser.length) console.log(`  state    ${names(plan.state.browser)} ${dim("in the browser, one copy per tab")}`);
  for (const w of plan.warnings) console.log(yellow(`  warning  ${w}`));
  for (const h of plan.state.both) {
    console.log(yellow(`  warning  ${cb.displayRef(`#${h}`)} is used by both browser and server code, so the server and each tab have separate copies`));
  }
}

/**
 * Call `onChange` when the codebase changes (`tcm update`, `mv`, `pull`, ... in another shell). One command can
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
  const root = path.join(cb.lay.tcmDir, "web");
  let state = planApp(cb, appName);
  writeBuildRoot(cb, root, appName, state);

  const components: ComponentPlan = { isComponent: (h) => state.plan.components.has(h), isClientRef: (h) => state.plan.clientRefs.has(h) };
  const rpc = rpcHandler(cb, (h) => state.plan.endpoints.has(h), undefined, undefined, components);
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "warn",
    clearScreen: false,
    appType: "spa",
    plugins: [
      tcmPlugin(cb, () => state.plan),
      {
        name: "tcm-rpc",
        configureServer: (s) => {
          s.middlewares.use(rpc);
          s.middlewares.use(lateCookieHandler);
          if (routes) s.middlewares.use(httpHandler(cb, routes, { production: false, secure: false }));
          // a component app's pages are rendered on the server first, then hydrated
          s.middlewares.use(async (req, res, next) => {
            if (!state.react || state.plan.errors.length || !isPageRequest(req)) return next();
            try {
              const template = await s.transformIndexHtml(req.url ?? "/", fs.readFileSync(path.join(root, "index.html"), "utf8"));
              const { render } = (await s.ssrLoadModule(path.join(root, "ssr.ts"))) as { render: RenderApp };
              if (await renderPage(cb, req, res, template, render, components, { production: false, secure: false })) return;
              res.setHeader("content-type", "text/html");
              res.end(template);
            } catch (e) {
              next(e);
            }
          });
        },
      },
    ],
    server: { port, host: "127.0.0.1", fs: { allow: [cb.lay.tcmDir] } },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
  console.log(`${bold("tcm dev")} ${appName} ${dim(shortHash(state.hash))}\n  url      ${url}`);
  reportPlan(cb, appName, state.plan);
  if (routes) printRoutes(cb, routes, url);
  const background = await startBackground(cb, appName);

  const stop = watchCodebase(cb, async () => {
    const before = state.hash;
    state = planApp(cb, appName);
    writeBuildRoot(cb, root, appName, state);
    server.moduleGraph.invalidateAll();
    server.ws.send({ type: "full-reload" });
    console.log(`\n${yellow("reloaded")} ${appName} ${dim(before === state.hash ? "(names changed)" : `${shortHash(before)} → ${shortHash(state.hash)}`)}`);
    reportPlan(cb, appName, state.plan);
    await background.refresh();
  });
  return {
    url,
    close: async () => {
      stop();
      background.stop();
      await server.close();
    },
  };
}

// ---- build -----------------------------------------------------------------------------------------------------

export interface BuildManifest {
  app: string;
  hash: string;
  endpoints: string[];
  /** the endpoints that are server components, and the browser components they send as references */
  components?: string[];
  clientRefs?: string[];
  /** the server-rendering bundle (component apps), relative to the build */
  ssr?: string;
  builtAt: string;
}

/** Where a build keeps its server-rendering bundle: inside the build, but never served. */
const SSR_DIR = "server";

const appsDir = (cb: Codebase) => path.join(cb.lay.tcmDir, "apps");
const manifestFile = (cb: Codebase, hash: string) => path.join(appsDir(cb), hash, "tcm-app.json");

/**
 * Build the app as its name currently resolves, into .tcm/apps/<hash>/ with assets under /_app/<hash>/.
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
  const root = path.join(cb.lay.tcmDir, "build", state.hash);
  writeBuildRoot(cb, root, appName, state);
  await viteBuild({
    configFile: false,
    root,
    base: `/_app/${state.hash}/`,
    logLevel: "warn",
    plugins: [tcmPlugin(cb, () => state.plan)],
    build: { outDir, emptyOutDir: true },
  });
  if (state.react) {
    // the first paint, rendered by `tcm start`: one bundle with React in it, kept out of the served assets
    await viteBuild({
      configFile: false,
      root,
      base: `/_app/${state.hash}/`,
      logLevel: "warn",
      plugins: [tcmPlugin(cb, () => state.plan)],
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      ssr: { noExternal: true },
      build: { ssr: path.join(root, "ssr.ts"), outDir: path.join(outDir, SSR_DIR), emptyOutDir: true, rollupOptions: { output: { entryFileNames: "ssr.js" } } },
    });
  }
  const manifest: BuildManifest = {
    app: appName,
    hash: state.hash,
    endpoints: [...state.plan.endpoints],
    ...(state.plan.components.size ? { components: [...state.plan.components], clientRefs: [...state.plan.clientRefs] } : {}),
    ...(state.react ? { ssr: `${SSR_DIR}/ssr.js` } : {}),
    builtAt: new Date().toISOString(),
  };
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
  // Re-read whenever the set of builds changes (a deploy here, or `tcm apps prune` in another shell).
  let endpoints = new Set<string>();
  let components = new Set<string>();
  let clientRefs = new Set<string>();
  const ever = new Set<string>();
  let buildsSeen = "";
  const loadEndpoints = () => {
    const builds = listBuilds(cb);
    const key = builds.map((b) => b.hash).join(",");
    if (key === buildsSeen) return;
    buildsSeen = key;
    endpoints = new Set(builds.flatMap((b) => b.endpoints));
    components = new Set(builds.flatMap((b) => b.components ?? []));
    clientRefs = new Set(builds.flatMap((b) => b.clientRefs ?? []));
    for (const e of endpoints) ever.add(e);
  };
  loadEndpoints();
  const rescan = setInterval(loadEndpoints, 1000);
  const componentPlan: ComponentPlan = { isComponent: (h) => components.has(h), isClientRef: (h) => clientRefs.has(h) };
  const rpc = rpcHandler(
    cb,
    (h) => endpoints.has(h),
    // was an endpoint of a build this server has served, or is code in the codebase: an old page, not an attack
    (h) => ever.has(h) || cb.store.hasDef(h),
    { production: true, secure: !!opts.tls },
    // a hash's placement never changes, so one set across builds is right for each of them
    componentPlan,
  );

  const serveFile = (res: http.ServerResponse, file: string, immutable: boolean) => {
    res.statusCode = 200;
    res.setHeader("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    fs.createReadStream(file).pipe(res);
  };
  const routes = opts.http ? httpHandler(cb, opts.http, { production: true, secure: !!opts.tls }) : (_q: http.IncomingMessage, _s: http.ServerResponse, next: () => void) => next();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    rpc(req, res, () => lateCookieHandler(req, res, () => routes(req, res, () => {
      const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const asset = /^\/_app\/([a-z2-7]{52})\/(.+)$/.exec(url);
      if (asset) {
        // any build's assets, so pages loaded before a deploy can still fetch theirs (paths are content-addressed)
        const dir = path.join(appsDir(cb), asset[1]!);
        const file = path.resolve(dir, asset[2]!);
        const server = file.startsWith(path.join(dir, SSR_DIR) + path.sep);
        if (server || !file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end("not found");
        }
        return serveFile(res, file, true);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        return res.end();
      }
      // everything else is the current build's page (client-side routes included), rendered on the server first
      // when the app is a component
      const page = path.join(appsDir(cb), current.hash, "index.html");
      const build = current;
      if (!build.ssr || !isPageRequest(req)) return serveFile(res, page, false);
      void (async () => {
        try {
          const { render } = (await import(pathToFileURL(path.join(appsDir(cb), build.hash, build.ssr!)).href)) as { render: RenderApp };
          res.setHeader("cache-control", "no-cache");
          if (await renderPage(cb, req, res, fs.readFileSync(page, "utf8"), render, componentPlan, { production: true, secure: !!opts.tls })) return;
        } catch (e) {
          console.error(red(`  server rendering failed: ${(e as Error)?.stack ?? e}`));
          if (res.headersSent) return res.end();
        }
        serveFile(res, page, false);
      })();
    })));
  };
  const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
  await new Promise<void>((r) => server.listen(opts.port, opts.host, r));
  const { port } = server.address() as { port: number };
  const url = `${opts.tls ? "https" : "http"}://${opts.host}:${port}/`;
  console.log(`${bold("tcm start")} ${appName} ${dim(shortHash(current.hash))}\n  url      ${url}`);
  console.log(`  server   ${endpoints.size} callable function hash(es) across ${fs.readdirSync(appsDir(cb)).length} build(s)`);
  if (opts.http) printRoutes(cb, opts.http, url);
  const background = await startBackground(cb, appName);

  const stop = watchCodebase(cb, async () => {
    // recurring jobs follow names too, even when the app itself didn't change
    await background.refresh();
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
      background.stop();
      await new Promise((r) => server.close(r));
    },
  };
}
