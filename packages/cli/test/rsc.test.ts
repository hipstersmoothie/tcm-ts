import { test } from "node:test";
import assert from "node:assert/strict";
import { renderServerComponent } from "../src/rsc.ts";

// elements as React's jsx() makes them, so no React is needed here
const el = (type: unknown, props: Record<string, unknown> = {}, key: string | null = null) => ({ $$typeof: Symbol.for("react.transitional.element"), type, key, props });
const hashed = <F extends (...a: never[]) => unknown>(f: F, hash: string) => Object.defineProperty(f, Symbol.for("ucm.hash"), { value: hash });
const ctx = (refs: string[]) => ({ isClientRef: (h: string) => refs.includes(h), name: (h: string) => `#${h}` });

test("server components render to plain data; browser components become references by hash", async () => {
  const Counter = hashed((_: { start: number }) => "never called on the server", "counter");
  const Item = ({ text }: { text: string }) => el("li", { children: text });
  const List = async ({ items }: { items: string[] }) => {
    await new Promise((r) => setTimeout(r, 1));
    return el(Symbol.for("react.fragment"), {
      children: [el("ul", { className: "list", children: items.map((t, i) => el(Item, { text: t }, String(i))) }), el(Counter, { start: items.length, children: el("b", { children: "♥" }) })],
    });
  };
  const tree = await renderServerComponent(List as never, { items: ["a", "b"] }, ctx(["counter"]));
  assert.deepEqual(tree, [
    { $ucm: "e", type: "ul", key: null, props: { className: "list", children: [{ $ucm: "e", type: "li", key: null, props: { children: "a" } }, { $ucm: "e", type: "li", key: null, props: { children: "b" } }] } },
    // the server renders the elements it passes as props; the browser renders the component itself
    { $ucm: "c", ref: "counter", key: null, props: { start: 2, children: { $ucm: "e", type: "b", key: null, props: { children: "♥" } } } },
  ]);
});

test("what can't cross to the browser is refused with where it is", async () => {
  const Button = hashed((_: { onPick: () => void }) => null, "button");
  const Bad = () => el("div", { children: el(Button, { onPick: () => {} }) });
  await assert.rejects(renderServerComponent(Bad as never, {}, ctx(["button"])), /Bad > #button: prop `onPick` is a function, which can't be sent from the server to the browser/);
  const Handler = () => el("button", { onClick: () => {} });
  await assert.rejects(renderServerComponent(Handler as never, {}, ctx([])), /Handler: `onClick` on <button> is a function/);
});
