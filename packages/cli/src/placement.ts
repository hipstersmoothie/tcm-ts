// Where code runs, inferred from what it uses: nothing is annotated.
//
// - A definition needs the server if it uses Node itself (`node:*`, `process`, `Buffer`, a server-only npm
//   package), or uses something that needs the server and can't be called remotely.
// - It needs the browser if it uses the DOM (`document`, `window`, `localStorage`, ...).
// - Otherwise it runs anywhere.
//
// An async function that needs the server is a cut point: browser code calling it gets a stub that calls it by
// hash, and the code around the call stays in the browser. So the boundary sits as deep as it can, and a
// synchronous server function used from the browser is an error (a network call can't be synchronous).
import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import type { IR } from "@ucm/core";
import { npmAlias } from "@ucm/loader";
import type { Codebase } from "./codebase.ts";

const NODE_GLOBALS = new Set(["process", "Buffer", "require", "__dirname", "__filename", "global", "setImmediate", "clearImmediate"]);
const DOM_GLOBALS = new Set([
  "document", "window", "navigator", "localStorage", "sessionStorage", "location", "history", "alert", "confirm", "prompt",
  "requestAnimationFrame", "cancelAnimationFrame", "customElements", "getComputedStyle", "matchMedia", "indexedDB",
  "DOMParser", "MutationObserver", "IntersectionObserver", "ResizeObserver", "Element", "Node", "Document", "Window",
]);
const isDomGlobal = (name: string) => DOM_GLOBALS.has(name) || /^(HTML|SVG)\w*Element$/.test(name);

export type Place = "server" | "browser" | "anywhere";

function globalsIn(ir: IR, out = new Set<string>()): Set<string> {
  if (typeof ir === "string") return out;
  if (ir[0] === "G" && typeof ir[1] === "string") out.add(ir[1]);
  else for (const c of ir) globalsIn(c, out);
  return out;
}

/**
 * Whether a definition is module-level mutable state: a `const` holding a fresh mutable object (`new Map()`,
 * `[]`, `{}`), as opposed to a function, a primitive, an `as const` value or anything frozen or computed.
 */
function isMutableState(ir: IR): boolean {
  if (!Array.isArray(ir) || ir[1] !== "Const") return false;
  const decl = ir.find((x) => Array.isArray(x) && x[0] === "VariableDeclaration") as IR[] | undefined;
  let init = (decl?.find((x) => Array.isArray(x) && x[0] === "initializer") as IR[] | undefined)?.[1] as IR[] | undefined;
  while (init && (init[0] === "AsExpression" || init[0] === "SatisfiesExpression" || init[0] === "NonNullExpression")) {
    const type = init.find((x) => Array.isArray(x) && x[0] === "type") as IR[] | undefined;
    if (init[0] === "AsExpression" && JSON.stringify(type) === JSON.stringify(["type", ["TypeReference", ["typeName", ["G", "const"]]]])) return false;
    init = (init.find((x) => Array.isArray(x) && x[0] === "expression") as IR[] | undefined)?.[1] as IR[] | undefined;
  }
  return !!init && ["NewExpression", "ArrayLiteralExpression", "ObjectLiteralExpression"].includes(init[0] as string);
}

export interface AppState {
  /** module-level mutable values used only by server code: one copy, shared by every client */
  server: string[];
  /** used only by browser code: each tab has its own copy */
  browser: string[];
  /** used by both: the server and every tab silently get separate copies */
  both: string[];
}

export interface AppPlan {
  /** definitions shipped to the browser */
  browser: Set<string>;
  /** server functions the browser calls by hash: exactly the endpoints the app exposes */
  endpoints: Set<string>;
  /** components the browser receives as stubs instead of code */
  stubbed: Set<string>;
  errors: string[];
  state: AppState;
}

export class Placement {
  private cb: Codebase;
  private serverWhy = new Map<string, string | undefined>();
  private browserWhy = new Map<string, string | undefined>();
  private npmServerOnly = new Map<string, boolean>();

  constructor(cb: Codebase) {
    this.cb = cb;
  }

  private name(h: string): string {
    return this.cb.displayRef(`#${h}`);
  }

  private valueDeps(h: string): string[] {
    return (this.cb.store.getDef(h)?.deps ?? []).filter((d) => d.pos === "value" && d.ref.startsWith("#")).map((d) => d.ref.slice(1));
  }

  /**
   * An npm package needs the server if it doesn't declare a browser build and its entry imports Node builtins.
   * A heuristic: packages are installed into .ucm/cache/node_modules under their pinned versions.
   */
  private isServerPackage(module: string): boolean {
    if (this.npmServerOnly.has(module)) return this.npmServerOnly.get(module)!;
    let result = false;
    const dir = path.join(this.cb.lay.cacheDir, "node_modules", npmAlias(module));
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
      const exportsText = JSON.stringify(pkg.exports ?? "");
      if (!pkg.browser && !exportsText.includes('"browser"')) {
        const exp = pkg.exports as Record<string, unknown> | string | undefined;
        const dot = typeof exp === "string" ? exp : (exp?.["."] ?? exp);
        const pick = (e: unknown): string | undefined =>
          typeof e === "string" ? e : e && typeof e === "object" ? pick((e as Record<string, unknown>).import ?? (e as Record<string, unknown>).default ?? (e as Record<string, unknown>).node ?? (e as Record<string, unknown>).require) : undefined;
        const entry = pick(dot) ?? (pkg.module as string | undefined) ?? (pkg.main as string | undefined) ?? "index.js";
        const text = fs.readFileSync(path.join(dir, entry), "utf8");
        const specs = [...text.matchAll(/(?:require\(|from\s+|import\s*\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);
        result = specs.some((s) => isBuiltin(s));
      }
    } catch {
      result = false;
    }
    this.npmServerOnly.set(module, result);
    return result;
  }

  private directServer(h: string): string | undefined {
    const rec = this.cb.store.getDef(h);
    if (!rec || rec.kind === "type") return undefined;
    for (const s of rec.spans) {
      if (!s.ext || s.pos !== "value") continue;
      if (s.ext.module.startsWith("node:")) return `uses ${s.ext.module}`;
      if (s.ext.module === "ucm:server") return `uses #ucm/server (${s.ext.export})`;
      if (s.ext.module.startsWith("npm:") && this.isServerPackage(s.ext.module)) return `uses ${s.ext.module.slice(4)}, a server-side package`;
    }
    for (const g of globalsIn(JSON.parse(rec.ir) as IR)) if (NODE_GLOBALS.has(g)) return `uses ${g}`;
    return undefined;
  }

  private directBrowser(h: string): string | undefined {
    const rec = this.cb.store.getDef(h);
    if (!rec || rec.kind === "type") return undefined;
    for (const g of globalsIn(JSON.parse(rec.ir) as IR)) if (isDomGlobal(g)) return `uses ${g}`;
    return undefined;
  }

  /** An async function: callable across the network, since its callers already expect a promise. */
  crossable(h: string): boolean {
    const rec = this.cb.store.getDef(h);
    return !!rec && rec.kind === "term" && /^(<[^>]*>)?\(.*\) => Promise<.*>$/s.test(rec.signature);
  }

  private closure(h: string): string[] {
    const seen = new Set<string>();
    const stack = [h];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...this.valueDeps(x));
    }
    return [...seen];
  }

  /** Fixpoint over `h`'s closure, so cycles get the right answer. */
  private solve(h: string, memo: Map<string, string | undefined>, direct: (x: string) => string | undefined, propagates: (dep: string) => boolean) {
    if (memo.has(h)) return;
    const nodes = this.closure(h).filter((x) => !memo.has(x));
    for (const x of nodes) memo.set(x, direct(x));
    for (let changed = true; changed; ) {
      changed = false;
      for (const x of nodes) {
        if (memo.get(x)) continue;
        const dep = this.valueDeps(x).find((d) => memo.get(d) && propagates(d));
        if (dep) {
          memo.set(x, `uses ${this.name(dep)}, which ${memo.get(dep)!}`);
          changed = true;
        }
      }
    }
  }

  /** Why `h` must run on the server, if it must. Calls to async server functions don't count: they cross. */
  needsServer(h: string): string | undefined {
    this.solve(h, this.serverWhy, (x) => this.directServer(x), (d) => !this.crossable(d));
    return this.serverWhy.get(h);
  }

  /** Why `h` must run in the browser, if it must. */
  needsBrowser(h: string): string | undefined {
    this.solve(h, this.browserWhy, (x) => this.directBrowser(x), () => true);
    return this.browserWhy.get(h);
  }

  placeOf(h: string): { place: Place; why?: string; conflict?: string } {
    const server = this.needsServer(h);
    const browser = this.needsBrowser(h);
    if (server && browser) return { place: "server", why: server, conflict: `it also ${browser}` };
    if (server) return { place: "server", why: server };
    if (browser) return { place: "browser", why: browser };
    return { place: "anywhere" };
  }

  /** The sync server dependencies that pull `h` onto the server: `[dep, its dep, ..., the one using Node]`. */
  private culprit(h: string): string[] {
    if (this.directServer(h)) return [];
    const d = this.valueDeps(h).find((x) => this.needsServer(x) && !this.crossable(x));
    return d ? [d, ...this.culprit(d)] : [];
  }

  /** Explain why browser code `h` got pulled onto the server, naming the function to make async. */
  private explainPull(h: string, via: string): string {
    const chain = this.culprit(h);
    if (!chain.length) return `${via}: ${this.name(h)} uses Node (it ${this.directServer(h)}) and the DOM (it ${this.needsBrowser(h)}); split it into a server part and a browser part.`;
    const sync = chain[0]!;
    const path = chain.map((x) => this.name(x)).join(" → ");
    return (
      `${via}: ${this.name(h)} needs the browser (it ${this.needsBrowser(h)}) but calls ${this.name(sync)}, which runs on the server ` +
      `(${path} ${this.directServer(chain.at(-1)!)}) and isn't async, so it can't be called across the network. Make ${this.name(sync)} async.`
    );
  }

  /** What a browser app rooted at `entry` ships, which server functions it calls, and what's wrong with it. */
  planApp(entry: string): AppPlan {
    const plan: AppPlan = { browser: new Set(), endpoints: new Set(), stubbed: new Set(), errors: [], state: { server: [], browser: [], both: [] } };
    const visit = (h: string, chain: string[]) => {
      if (plan.browser.has(h) || plan.endpoints.has(h)) return;
      const via = [...chain, this.name(h)].join(" → ");
      const server = this.needsServer(h);
      if (server) {
        if (!this.crossable(h)) {
          plan.errors.push(
            this.needsBrowser(h)
              ? this.explainPull(h, via)
              : `${via}: ${this.name(h)} runs on the server (it ${server}) but isn't async, so the browser can't call it across the network. Make it async.`,
          );
          return;
        }
        if (this.needsBrowser(h)) {
          plan.errors.push(this.explainPull(h, via));
          return;
        }
        plan.endpoints.add(h);
        plan.stubbed.add(this.cb.store.getDef(h)!.componentHash);
        return;
      }
      plan.browser.add(h);
      for (const d of this.valueDeps(h)) visit(d, [...chain, this.name(h)]);
    };
    if (this.needsServer(entry) && !this.crossable(entry)) {
      plan.errors.push(`${this.name(entry)} runs on the server (it ${this.needsServer(entry)}), so it can't be the browser app's entry point.`);
      return plan;
    }
    visit(entry, []);
    // where module-level state lives follows from which side's code uses it
    const serverSide = new Set([...plan.endpoints].flatMap((h) => this.closure(h)));
    for (const h of new Set([...plan.browser, ...serverSide])) {
      const rec = this.cb.store.getDef(h);
      if (!rec || rec.kind !== "term" || !isMutableState(JSON.parse(rec.ir) as IR)) continue;
      const [b, s] = [plan.browser.has(h), serverSide.has(h)];
      (b && s ? plan.state.both : b ? plan.state.browser : plan.state.server).push(h);
    }
    // members of one component ship together, so a component can't be half browser, half stub
    for (const c of plan.stubbed) {
      const local = this.cb.store.componentMembers(c).filter((m) => plan.browser.has(m.hash));
      if (local.length) plan.errors.push(`${local.map((m) => this.name(m.hash)).join(", ")} are mutually recursive with server code, so they can't run in the browser.`);
    }
    return plan;
  }
}
