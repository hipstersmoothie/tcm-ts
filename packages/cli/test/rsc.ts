import assert from "node:assert/strict";
import { renderServerComponent } from "../src/rsc.ts";

// elements as React's jsx() makes them, so no React is needed here
const el = (type: unknown, props: Record<string, unknown> = {}, key: string | null = null) => ({ $$typeof: Symbol.for("react.transitional.element"), type, key, props });
const hashed = <F extends (...a: never[]) => unknown>(f: F, hash: string) => Object.defineProperty(f, Symbol.for("tcm.hash"), { value: hash });
const ctx = (refs: string[]) => ({ isClientRef: (h: string) => refs.includes(h), name: (h: string) => `#${h}`, describe: (e: unknown) => ({ name: "Error", message: (e as Error).message }) });

/** Server components render to plain data; browser components become references by hash. */
export const testServerComponentsRenderToPlainData = async () => {
  const Counter = hashed((_: { start: number }) => "never called on the server", "counter");
  const Item = ({ text }: { text: string }) => el("li", { children: text });
  const List = async ({ items }: { items: string[] }) => {
    await new Promise((r) => setTimeout(r, 1));
    return el(Symbol.for("react.fragment"), {
      children: [el("ul", { className: "list", children: items.map((t, i) => el(Item, { text: t }, String(i))) }), el(Counter, { start: items.length, children: el("b", { children: "♥" }) })],
    });
  };
  const { root: tree } = await renderServerComponent(List as never, { items: ["a", "b"] }, ctx(["counter"]));
  assert.deepEqual(tree, [
    { $tcm: "e", type: "ul", key: null, props: { className: "list", children: [{ $tcm: "e", type: "li", key: null, props: { children: "a" } }, { $tcm: "e", type: "li", key: null, props: { children: "b" } }] } },
    // the server renders the elements it passes as props; the browser renders the component itself
    { $tcm: "c", ref: "counter", key: null, props: { start: 2, children: { $tcm: "e", type: "b", key: null, props: { children: "♥" } } } },
  ]);
};

/** What can't cross to the browser is refused with where it is. */
export const testWhatCantCrossToTheBrowserIsRefused = async () => {
  const Button = hashed((_: { onPick: () => void }) => null, "button");
  const Bad = () => el("div", { children: el(Button, { onPick: () => {} }) });
  await assert.rejects(renderServerComponent(Bad as never, {}, ctx(["button"])), /Bad > #button: prop `onPick` is a function, which can't be sent from the server to the browser/);
  const Handler = () => el("button", { onClick: () => {} });
  await assert.rejects(renderServerComponent(Handler as never, {}, ctx([])), /Handler: `onClick` on <button> is a function/);
};

/** <Suspense> streams: the fallback goes with the tree, the contents follow as they finish. */
export const testSuspenseStreams = async () => {
  const slow = (ms: number, text: string) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return el("p", { children: text });
  };
  const Failing = async () => {
    throw new Error("no data");
  };
  const Page = () =>
    el("main", {
      children: [
        el(Symbol.for("react.suspense"), { fallback: el("i", { children: "loading slow" }), children: el(slow(30, "slow")) }),
        el(Symbol.for("react.suspense"), { fallback: "loading fast", children: el(slow(1, "fast")) }),
        el(Symbol.for("react.suspense"), { fallback: null, children: el(Failing) }),
      ],
    });
  const { root, chunks } = await renderServerComponent(Page as never, {}, ctx([]));
  assert.deepEqual(root, {
    $tcm: "e",
    type: "main",
    key: null,
    props: {
      children: [
        { $tcm: "s", id: 0, key: null, fallback: { $tcm: "e", type: "i", key: null, props: { children: "loading slow" } } },
        { $tcm: "s", id: 1, key: null, fallback: "loading fast" },
        { $tcm: "s", id: 2, key: null, fallback: null },
      ],
    },
  });
  const got = [];
  for await (const c of chunks) got.push(c);
  assert.deepEqual(got.map((c) => c.id), [2, 1, 0], "in the order they finish");
  assert.deepEqual(got[2], { id: 0, tree: { $tcm: "e", type: "p", key: null, props: { children: "slow" } } });
  assert.deepEqual(got[0], { id: 2, error: { name: "Error", message: "no data" } }, "an error stays in its boundary");
};

/** A context provided on the server is sent by its hash, with its value. */
export const testServerContextIsSentByHash = async () => {
  const Theme = Object.defineProperty({ $$typeof: Symbol.for("react.context") }, Symbol.for("tcm.hash"), { value: "theme" });
  const Page = () => el(Theme, { value: { dark: true }, children: el("p", { children: "hi" }) });
  const { root } = await renderServerComponent(Page as never, {}, ctx([]));
  assert.deepEqual(root, { $tcm: "x", ref: "theme", key: null, value: { dark: true }, children: { $tcm: "e", type: "p", key: null, props: { children: "hi" } } });
  const Anonymous = () => el({ $$typeof: Symbol.for("react.context") }, { value: 1, children: null });
  await assert.rejects(renderServerComponent(Anonymous as never, {}, ctx([])), /must be a top-level definition/);
};

/** A consumer on the server reads the provider above it in the tree, else the default; lazy goes to the browser. */
export const testServerConsumerReadsTheProviderAbove = async () => {
  const Theme = Object.defineProperty({ $$typeof: Symbol.for("react.context"), _currentValue: "light" }, Symbol.for("tcm.hash"), { value: "theme" });
  const Consumer = { $$typeof: Symbol.for("react.consumer"), _context: Theme };
  const read = el(Consumer, { children: (t: string) => el("i", { children: t }) });
  const Page = () => [el(Theme, { value: "dark", children: read }), read];
  const { root } = await renderServerComponent(Page as never, {}, ctx([]));
  assert.deepEqual(root, [
    { $tcm: "x", ref: "theme", key: null, value: "dark", children: { $tcm: "e", type: "i", key: null, props: { children: "dark" } } },
    { $tcm: "e", type: "i", key: null, props: { children: "light" } },
  ]);
  const Chart = Object.defineProperty({ $$typeof: Symbol.for("react.lazy") }, Symbol.for("tcm.hash"), { value: "chart" });
  const WithChart = () => el(Chart, { points: [1, 2] });
  assert.deepEqual((await renderServerComponent(WithChart as never, {}, ctx([]))).root, { $tcm: "c", ref: "chart", key: null, props: { points: [1, 2] } });
};
