import assert from "node:assert/strict";
import { highlight } from "../src/pages.ts";

/** Classes as `[x:text]`, for readable expectations. */
const classes = (src: string) => highlight(src, [], new Set()).replace(/<span class="(\w)">/g, "[$1:").replace(/<\/span>/g, "]").replace(/&quot;/g, '"');

/** Source highlighting: template literals resume after substitutions; regex vs division; control keywords. */
export const testHighlightingTemplatesRegexesKeywords = () => {
  assert.equal(classes("f(`a:${g().x}`, { n: 5 });"), "[f:f]([s:`a:${][f:g]().x[s:}`], { n: [n:5] });");
  assert.equal(classes("`${a}-${ {x: 1}.x }`"), "[s:`${]a[s:}-${] {x: [n:1]}.x [s:}`]");
  assert.equal(classes("const r = /a+b/g.test(q) ? 1 / 2 : 0;"), "[k:const] r = [s:/a+b/g].[f:test](q) ? [n:1] / [n:2] : [n:0];");
  assert.equal(classes("if (x) return y; // done"), "[x:if] (x) [x:return] y; [c:// done]");
};

/**
 * Source highlighting: references are links, coloured as the names they are (a call, a type).
 */
export const testHighlightedReferencesAreLinks = () => {
  assert.equal(highlight("square(2)", [{ start: 0, end: 6, hash: "h1" }], new Set()), '<a class="ref f" data-hash="h1">square</a>(<span class="n">2</span>)');
  assert.equal(highlight("n + x", [{ start: 4, end: 5, hash: "h3" }], new Set()), 'n + <a class="ref" data-hash="h3">x</a>');
  assert.equal(highlight('import "#codebase/geo";', [{ start: 7, end: 22, namespace: "geo" }], new Set()), '<span class="x">import</span> <a class="ref s" data-namespace="geo">&quot;#codebase/geo&quot;</a>;');
  assert.equal(highlight("let p: Point", [{ start: 7, end: 12, hash: "h2" }], new Set(["h2"])), '<span class="k">let</span> p: <a class="ref t" data-hash="h2">Point</a>');
}
