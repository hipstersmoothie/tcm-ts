// Server components without directives. Placement decides which components render on the server (async ones,
// and ones that use the server); this module renders them there and turns the result back into React elements in
// the browser.
//
// The server walks the element tree a server component returns, calling every component that can run there, and
// sends the result as plain data through the same codec as server function results:
//
// - host elements (`<li>`) as `{ $tcm: "e", type, key, props }`, their children rendered;
// - browser components (state, effects, event handlers) as `{ $tcm: "c", ref: <hash>, key, props }`: a reference to
//   code the browser already has, by hash, with the props the server gave it.
//
// In the browser, a server component is a stub component that fetches its tree (`POST /__tcm/rpc/<hash>`, its
// props as the argument) and renders it. After any server function call from the page, mounted server components
// fetch their trees again, so what they show follows the data without any wiring.

const ELEMENT = new Set([Symbol.for("react.transitional.element"), Symbol.for("react.element")]);
const FRAGMENT = Symbol.for("react.fragment");
const PASS_THROUGH = new Set([FRAGMENT, Symbol.for("react.suspense"), Symbol.for("react.strict_mode"), Symbol.for("react.profiler")]);
const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");
const TCM_HASH = Symbol.for("tcm.hash");

interface Element {
  $$typeof: symbol;
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
}

export type Wire = null | string | number | bigint | Wire[] | { $tcm: "e"; type: string; key: string | null; props: Record<string, unknown> } | { $tcm: "c"; ref: string; key: string | null; props: Record<string, unknown> };

const isElement = (v: unknown): v is Element => !!v && typeof v === "object" && ELEMENT.has((v as Element).$$typeof);
const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === "function";
const nameOf = (type: unknown) => (typeof type === "function" ? type.name || "a component" : String(type));

export interface RenderContext {
  /** browser components: rendered in the browser, so sent as references */
  isClientRef(hash: string): boolean;
  /** how to name a definition in errors */
  name(hash: string): string;
}

/** Render `component(props)` on the server into plain data. */
export function renderServerComponent(component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>, ctx: RenderContext): Promise<Wire> {
  return render({ $$typeof: Symbol.for("react.transitional.element"), type: component, key: null, props }, ctx, []);
}

async function render(node: unknown, ctx: RenderContext, path: string[]): Promise<Wire> {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return node;
  if (isThenable(node)) return render(await node, ctx, path);
  if (Array.isArray(node)) return Promise.all(node.map((n) => render(n, ctx, path)));
  if (!isElement(node)) {
    if (typeof node === "object" && Symbol.iterator in node) return Promise.all([...(node as Iterable<unknown>)].map((n) => render(n, ctx, path)));
    throw new Error(`${where(path)}: can't render ${typeof node === "function" ? "a function" : "an object"} as a child`);
  }
  const { type, key, props } = node;
  if (typeof type === "string") return { $tcm: "e", type, key, props: await hostProps(type, props, ctx, path) };
  if (typeof type === "symbol" && PASS_THROUGH.has(type)) return render(props.children, ctx, path);
  if (typeof type === "function") {
    const hash = (type as unknown as Record<symbol, unknown>)[TCM_HASH];
    // codebase components by their current names
    const at = [...path, typeof hash === "string" ? ctx.name(hash) : nameOf(type)];
    if (typeof hash === "string" && ctx.isClientRef(hash)) return { $tcm: "c", ref: hash, key, props: await clientProps(props, ctx, at) };
    if ((type.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent) throw new Error(`${where(at)}: class components only render in the browser`);
    try {
      return await render(await (type as (p: unknown) => unknown)(props), ctx, at);
    } catch (e) {
      // a hook outside a component instance: React's own message doesn't say where or why
      if (e instanceof TypeError && /reading 'use\w*'/.test(e.message)) throw new Error(`${where(at)} uses a React hook, but renders on the server; import hooks by name (\`import { useState } from "react"\`) so tcm can tell it needs the browser`);
      throw e;
    }
  }
  if (type && typeof type === "object") {
    const t = type as { $$typeof?: symbol; type?: unknown; render?: (p: unknown, r: null) => unknown };
    if (t.$$typeof === MEMO) return render({ ...node, type: t.type }, ctx, path);
    if (t.$$typeof === FORWARD_REF) return render(await t.render!(props, null), ctx, [...path, t.render!.name || "forwardRef"]);
  }
  throw new Error(`${where(path)}: <${typeof type === "symbol" ? type.description : nameOf(type)}> (context providers, lazy components) only renders in the browser; render it from a browser component`);
}

const where = (path: string[]) => (path.length ? path.join(" > ") : "server component");

async function hostProps(tag: string, props: Record<string, unknown>, ctx: RenderContext, path: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") out.children = await render(v, ctx, path);
    else if (typeof v === "function") throw new Error(`${where(path)}: \`${k}\` on <${tag}> is a function, and functions only run in the browser`);
    else out[k] = v;
  }
  return out;
}

/** Props for a browser component: plain data, with any elements in them rendered here. */
async function clientProps(props: Record<string, unknown>, ctx: RenderContext, path: string[]): Promise<Record<string, unknown>> {
  const value = async (v: unknown, k: string): Promise<unknown> => {
    if (isElement(v) || isThenable(v)) return render(v, ctx, path);
    if (typeof v === "function") {
      const hash = (v as unknown as Record<symbol, unknown>)[TCM_HASH];
      throw new Error(
        `${where(path)}: prop \`${k}\` is a function${typeof hash === "string" ? ` (${ctx.name(hash)})` : ""}, which can't be sent from the server to the browser; ` +
          `the browser component can import what it needs itself`,
      );
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => value(x, k)));
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const o: Record<string, unknown> = {};
      for (const [kk, x] of Object.entries(v)) o[kk] = await value(x, `${k}.${kk}`);
      return o;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = await value(v, k);
  return out;
}

/**
 * The browser half, for one React (by its pinned alias, so it shares the app's instance): `serverComponent()`
 * makes the stub component that fetches and renders a server component's tree.
 */
export function reactRuntimeSource(react: string, runtime: string, codec: string): string {
  return `import { createElement, useEffect, useState } from ${JSON.stringify(react)};
import { encode, decode } from ${JSON.stringify(codec)};
import { onServerCall, reloadOutdated } from ${JSON.stringify(runtime)};

const trees = new Map();

function toElement(node, refs) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => toElement(n, refs));
  if (node.$tcm === "e") return create(node.type, node, refs);
  if (node.$tcm === "c") {
    const C = refs[node.ref];
    if (!C) throw new Error("the server rendered a browser component this page doesn't have (" + node.ref.slice(0, 8) + "); reload");
    return create(C, node, refs);
  }
  return node;
}

// children go in as arguments, as JSX passes them: lists inside keep their keys, siblings need none
function create(type, node, refs) {
  const { children, ...rest } = node.props;
  const props = {};
  for (const k in rest) props[k] = value(rest[k], refs);
  if (node.key !== null) props.key = node.key;
  if (children === undefined) return createElement(type, props);
  return Array.isArray(children) ? createElement(type, props, ...children.map((c) => toElement(c, refs))) : createElement(type, props, toElement(children, refs));
}

function value(v, refs) {
  if (v === null || typeof v !== "object") return v;
  if (v.$tcm === "e" || v.$tcm === "c") return toElement(v, refs);
  if (Array.isArray(v)) return v.map((x) => value(x, refs));
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const o = {};
  for (const k in v) o[k] = value(v[k], refs);
  return o;
}

async function fetchTree(hash, name, body) {
  let res;
  try {
    res = await fetch("/__tcm/rpc/" + hash, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (e) {
    throw new Error(name + ": the server is unreachable (" + e.message + ")");
  }
  if (res.status === 410) return reloadOutdated();
  const out = decode(await res.text());
  if (!res.ok) {
    const err = new Error(out && out.message ? out.message : res.statusText);
    err.name = out && out.name ? out.name : "RemoteError";
    err.status = res.status;
    throw err;
  }
  return out;
}

/** A component rendered on the server: fetches its tree, and fetches it again after the page calls the server. */
export function serverComponent(hash, name, refs) {
  const C = (props) => {
    const body = encode([props], "props of " + name);
    const key = hash + body;
    const [state, setState] = useState(() => trees.get(key));
    const [version, setVersion] = useState(0);
    useEffect(() => onServerCall(() => setVersion((v) => v + 1)), []);
    useEffect(() => {
      let live = true;
      fetchTree(hash, name, body).then(
        (tree) => {
          trees.set(key, { tree });
          if (live) setState({ tree });
        },
        (error) => live && setState({ error }),
      );
      return () => {
        live = false;
      };
    }, [key, version]);
    const shown = state ?? trees.get(key);
    if (!shown) return null;
    if (shown.error) throw shown.error;
    return toElement(shown.tree, refs);
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}
`;
}
