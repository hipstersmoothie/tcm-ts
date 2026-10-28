// Server components without directives. Placement decides which components render on the server (async ones,
// and ones that use the server); this module renders them there and turns the result back into React elements in
// the browser.
//
// The server walks the element tree a server component returns, calling every component that can run there, and
// sends the result as plain data through the same codec as server function results:
//
// - host elements (`<li>`) as `{ $tcm: "e", type, key, props }`, their children rendered;
// - browser components (state, effects, event handlers) as `{ $tcm: "c", ref: <hash>, key, props }`: a reference to
//   code the browser already has, by hash, with the props the server gave it;
// - context providers as `{ $tcm: "x", ref: <the context's hash>, key, value, children }`;
// - `<Suspense>` boundaries as `{ $tcm: "s", id, key, fallback }`: the fallback goes out with the tree, and what's
//   inside follows as its own chunk once it's rendered, so a slow part doesn't hold up the rest.
//
// In the browser, a server component is a stub component that fetches its tree (`POST /__tcm/rpc/<hash>`, its
// props as the argument) and renders it, suspending until the tree arrives. After any server function call from
// the page, mounted server components fetch their trees again, in a transition, so the old tree stays on screen
// until the new one is ready.
//
// When tcm renders the page's HTML on the server (the first paint), the same stubs render their server component
// directly, and the trees they rendered go into the page, so the browser hydrates with exactly that data.

const ELEMENT = new Set([Symbol.for("react.transitional.element"), Symbol.for("react.element")]);
const SUSPENSE = Symbol.for("react.suspense");
const PASS_THROUGH = new Set([Symbol.for("react.fragment"), Symbol.for("react.strict_mode"), Symbol.for("react.profiler")]);
const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");
const CONTEXT = Symbol.for("react.context");
const PROVIDER = Symbol.for("react.provider");
const TCM_HASH = Symbol.for("tcm.hash");

interface Element {
  $$typeof: symbol;
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
}

type Props = Record<string, unknown>;
export type Wire =
  | null
  | string
  | number
  | bigint
  | Wire[]
  | { $tcm: "e"; type: string; key: string | null; props: Props }
  | { $tcm: "c"; ref: string; key: string | null; props: Props }
  | { $tcm: "x"; ref: string; key: string | null; value: unknown; children: Wire }
  | { $tcm: "s"; id: number; key: string | null; fallback: Wire };

/** What's inside a `<Suspense>` boundary, rendered after the tree it's part of. */
export type Chunk = { id: number; tree: Wire } | { id: number; error: { name: string; message: string } };

export interface Rendered {
  root: Wire;
  /** the boundaries' contents, in the order they finish */
  chunks: AsyncIterable<Chunk>;
}

const isElement = (v: unknown): v is Element => !!v && typeof v === "object" && ELEMENT.has((v as Element).$$typeof);
const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === "function";
const nameOf = (type: unknown) => (typeof type === "function" ? type.name || "a component" : String(type));

export interface RenderContext {
  /** browser components: rendered in the browser, so sent as references */
  isClientRef(hash: string): boolean;
  /** how to name a definition in errors */
  name(hash: string): string;
  /** what the browser is told about an error inside a boundary (production hides the details) */
  describe(error: unknown): { name: string; message: string };
}

/** One render: hands out boundary ids, and collects the boundaries still rendering. */
class Render {
  private next = 0;
  private running = 0;
  private done: Chunk[] = [];
  private wake: (() => void) | undefined;
  readonly ctx: RenderContext;

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
  }

  boundary(contents: () => Promise<Wire>): number {
    const id = this.next++;
    this.running++;
    contents().then(
      (tree) => this.finish({ id, tree }),
      (e) => this.finish({ id, error: this.ctx.describe(e) }),
    );
    return id;
  }

  private finish(chunk: Chunk) {
    this.running--;
    this.done.push(chunk);
    this.wake?.();
  }

  async *chunks(): AsyncIterable<Chunk> {
    for (;;) {
      while (this.done.length) yield this.done.shift()!;
      if (!this.running) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

/** Render `component(props)` on the server into plain data: the tree, then its boundaries' contents. */
export async function renderServerComponent(component: (props: Props) => unknown, props: Props, ctx: RenderContext): Promise<Rendered> {
  const r = new Render(ctx);
  const root = await render({ $$typeof: Symbol.for("react.transitional.element"), type: component, key: null, props }, r, []);
  return { root, chunks: r.chunks() };
}

async function render(node: unknown, r: Render, path: string[]): Promise<Wire> {
  const { ctx } = r;
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return node;
  if (isThenable(node)) return render(await node, r, path);
  if (Array.isArray(node)) return Promise.all(node.map((n) => render(n, r, path)));
  if (!isElement(node)) {
    if (typeof node === "object" && Symbol.iterator in node) return Promise.all([...(node as Iterable<unknown>)].map((n) => render(n, r, path)));
    throw new Error(`${where(path)}: can't render ${typeof node === "function" ? "a function" : "an object"} as a child`);
  }
  const { type, key, props } = node;
  if (typeof type === "string") return { $tcm: "e", type, key, props: await hostProps(type, props, r, path) };
  if (type === SUSPENSE) {
    // the id before any await, so boundaries are numbered in tree order
    const id = r.boundary(() => render(props.children, r, path));
    return { $tcm: "s", id, key, fallback: await render(props.fallback, r, path) };
  }
  if (typeof type === "symbol" && PASS_THROUGH.has(type)) return render(props.children, r, path);
  if (typeof type === "function") {
    const hash = (type as unknown as Record<symbol, unknown>)[TCM_HASH];
    // codebase components by their current names
    const at = [...path, typeof hash === "string" ? ctx.name(hash) : nameOf(type)];
    if (typeof hash === "string" && ctx.isClientRef(hash)) return { $tcm: "c", ref: hash, key, props: await clientProps(props, r, at) };
    if ((type.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent) throw new Error(`${where(at)}: class components only render in the browser`);
    try {
      return await render(await (type as (p: unknown) => unknown)(props), r, at);
    } catch (e) {
      // a hook outside a component instance: React's own message doesn't say where or why
      if (e instanceof TypeError && /reading 'use\w*'/.test(e.message)) throw new Error(`${where(at)} uses a React hook, but renders on the server`);
      throw e;
    }
  }
  if (type && typeof type === "object") {
    const t = type as { $$typeof?: symbol; type?: unknown; render?: (p: unknown, r: null) => unknown; _context?: unknown };
    if (t.$$typeof === MEMO) return render({ ...node, type: t.type }, r, path);
    if (t.$$typeof === FORWARD_REF) return render(await t.render!(props, null), r, [...path, t.render!.name || "forwardRef"]);
    if (t.$$typeof === CONTEXT || t.$$typeof === PROVIDER) {
      // the browser components below read it: send which context (by hash) and its value
      const context = (t.$$typeof === PROVIDER ? t._context : t) as Record<symbol, unknown>;
      const hash = context[TCM_HASH];
      if (typeof hash !== "string") throw new Error(`${where(path)}: a context provided on the server must be a top-level definition, so the browser can find it by hash`);
      return { $tcm: "x", ref: hash, key, value: await clientValue(props.value, "value", r, path), children: await render(props.children, r, path) };
    }
  }
  throw new Error(`${where(path)}: <${typeof type === "symbol" ? type.description : nameOf(type)}> (lazy components, context consumers) only renders in the browser; render it from a browser component`);
}

const where = (path: string[]) => (path.length ? path.join(" > ") : "server component");

async function hostProps(tag: string, props: Props, r: Render, path: string[]): Promise<Props> {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") out.children = await render(v, r, path);
    else if (typeof v === "function") throw new Error(`${where(path)}: \`${k}\` on <${tag}> is a function, and functions only run in the browser`);
    else out[k] = v;
  }
  return out;
}

/** A value for the browser: plain data, with any elements in it rendered here. */
async function clientValue(v: unknown, k: string, r: Render, path: string[]): Promise<unknown> {
  if (isElement(v) || isThenable(v)) return render(v, r, path);
  if (typeof v === "function") {
    const hash = (v as unknown as Record<symbol, unknown>)[TCM_HASH];
    throw new Error(
      `${where(path)}: prop \`${k}\` is a function${typeof hash === "string" ? ` (${r.ctx.name(hash)})` : ""}, which can't be sent from the server to the browser; ` +
        `the browser component can import what it needs itself`,
    );
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => clientValue(x, k, r, path)));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o: Props = {};
    for (const [kk, x] of Object.entries(v)) o[kk] = await clientValue(x, `${k}.${kk}`, r, path);
    return o;
  }
  return v;
}

async function clientProps(props: Props, r: Render, path: string[]): Promise<Props> {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) out[k] = await clientValue(v, k, r, path);
  return out;
}

/**
 * The browser half, for one React (by its pinned alias, so it shares the app's instance): `serverComponent()`
 * makes the stub component that renders a server component's tree.
 *
 * Under server rendering (the page's first paint), `globalThis.__tcmSsr` is set: stubs render through it instead
 * of fetching, with one response cache per request. In the browser, the trees recorded that way are read from
 * `__TCM_TREES__` first, so hydration sees the same tree the HTML was made from.
 */
export function reactRuntimeSource(react: string, runtime: string, codec: string): string {
  return `import { createElement, startTransition, Suspense, use, useEffect, useState } from ${JSON.stringify(react)};
import { encode, decode } from ${JSON.stringify(codec)};
import { onServerCall, reloadOutdated } from ${JSON.stringify(runtime)};

// a promise React reads without suspending: already settled
const settled = (value) => Object.assign(Promise.resolve(value), { status: "fulfilled", value });
const failed = (reason) => {
  const p = Object.assign(Promise.reject(reason), { status: "rejected", reason });
  p.catch(() => {});
  return p;
};
const deferred = () => {
  const d = {};
  d.promise = new Promise((a, b) => ((d.resolve = a), (d.reject = b)));
  d.promise.catch(() => {});
  return d;
};

/** One response: the tree, and a promise for each boundary's contents. */
function response() {
  const chunks = new Map();
  const res = {
    root: deferred(),
    chunk(id) {
      if (!chunks.has(id)) chunks.set(id, deferred());
      return chunks.get(id);
    },
    fail(e) {
      res.root.reject(e);
      for (const c of chunks.values()) c.reject(e);
    },
  };
  return res;
}

// messages: { v } the tree, { s, v } a boundary's contents, { s, e } a boundary's error, { done }
function apply(res, msg) {
  if (msg.s === undefined) {
    if ("v" in msg) res.root.resolve(msg.v);
  } else if (msg.e) res.chunk(msg.s).reject(remoteError(msg.e));
  else res.chunk(msg.s).resolve(msg.v);
}

function remoteError(e) {
  const err = new Error(e && e.message ? e.message : "the server failed");
  err.name = e && e.name ? e.name : "RemoteError";
  if (e && e.status) err.status = e.status;
  return err;
}

async function fetchInto(res, hash, name, body) {
  let r;
  try {
    r = await fetch("/__tcm/rpc/" + hash, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (e) {
    throw new Error(name + ": the server is unreachable (" + e.message + ")");
  }
  if (r.status === 410) return reloadOutdated();
  if (!r.ok) throw remoteError(decode(await r.text()));
  const reader = r.body.getReader();
  const text = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += text.decode(value, { stream: true });
    for (let nl; (nl = buf.indexOf("\\n")) >= 0; buf = buf.slice(nl + 1)) apply(res, decode(buf.slice(0, nl)));
  }
}

// responses by server component and props, for the current generation (each server function call starts one)
let generation = 0;
const responses = new Map();
const listeners = new Set();
onServerCall(() => {
  generation++;
  for (const [k, e] of responses) if (e.generation < generation) responses.delete(k);
  // a transition: what's on screen stays until the new trees are ready
  startTransition(() => {
    for (const f of listeners) f();
  });
});

// trees the server rendered into this page: the first render reads them, so hydration matches the HTML
const recorded = typeof __TCM_TREES__ === "string" ? decode(__TCM_TREES__) : {};

function responseFor(hash, name, body) {
  const key = hash + body;
  const ssr = globalThis.__tcmSsr;
  const cache = ssr ? ssr.cache() : responses;
  const entry = cache.get(key);
  if (entry && entry.generation === generation) return entry.res;
  const res = response();
  const seen = !ssr && generation === 0 ? recorded[key] : undefined;
  if (seen) {
    res.root.promise = settled(seen.root);
    for (const [id, c] of Object.entries(seen.chunks)) res.chunk(Number(id)).promise = c.e ? failed(remoteError(c.e)) : settled(c.v);
  } else if (ssr) {
    ssr.render(hash, body, (msg) => apply(res, msg)).catch((e) => res.fail(e));
  } else {
    fetchInto(res, hash, name, body).catch((e) => res.fail(e));
  }
  cache.set(key, { generation, res });
  return res;
}

function Boundary({ res, id, refs }) {
  return toElement(use(res.chunk(id).promise), refs, res);
}

function toElement(node, refs, res) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => toElement(n, refs, res));
  if (node.$tcm === "e") return create(node.type, node, node.props, refs, res);
  if (node.$tcm === "c") return create(ref(refs, node.ref), node, node.props, refs, res);
  if (node.$tcm === "x") return create(ref(refs, node.ref), node, { value: node.value, children: node.children }, refs, res);
  if (node.$tcm === "s") {
    const props = { fallback: toElement(node.fallback, refs, res) };
    if (node.key !== null) props.key = node.key;
    return createElement(Suspense, props, createElement(Boundary, { res, id: node.id, refs }));
  }
  return node;
}

function ref(refs, hash) {
  const found = refs[hash];
  if (!found) throw new Error("the server rendered something this page doesn't have (" + hash.slice(0, 8) + "); reload");
  return found;
}

// children go in as arguments, as JSX passes them: lists inside keep their keys, siblings need none
function create(type, node, all, refs, res) {
  const { children, ...rest } = all;
  const props = {};
  for (const k in rest) props[k] = value(rest[k], refs, res);
  if (node.key !== null) props.key = node.key;
  if (children === undefined) return createElement(type, props);
  return Array.isArray(children) ? createElement(type, props, ...children.map((c) => toElement(c, refs, res))) : createElement(type, props, toElement(children, refs, res));
}

function value(v, refs, res) {
  if (v === null || typeof v !== "object") return v;
  if (v.$tcm) return toElement(v, refs, res);
  if (Array.isArray(v)) return v.map((x) => value(x, refs, res));
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const o = {};
  for (const k in v) o[k] = value(v[k], refs, res);
  return o;
}

/** A component rendered on the server: suspends until its tree arrives, and follows server function calls. */
export function serverComponent(hash, name, refs) {
  const C = (props) => {
    const body = encode([props], "props of " + name);
    const [, rerender] = useState(0);
    useEffect(() => {
      const f = () => rerender((n) => n + 1);
      listeners.add(f);
      return () => listeners.delete(f);
    }, []);
    const res = responseFor(hash, name, body);
    return toElement(use(res.root.promise), refs, res);
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}
`;
}
