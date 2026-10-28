// A TypeScript server plugin, loaded into VS Code's TypeScript server by the tcm-ts extension.
//
// Codebase definitions reach scratch files through generated modules (.tcm/codebase re-exports .tcm/cache/<hash>.ts),
// so TypeScript's Go to Definition lands in generated code. The tcm language server answers the same request
// with the definition's source (a tcm: document); this drops TypeScript's answers that point into generated
// modules, so Cmd+click goes straight to the source instead of offering both.
const GENERATED = /[\\/]\.tcm[\\/](cache|codebase)[\\/]/;

function init() {
  return {
    create(info) {
      const ls = info.languageService;
      const proxy = Object.create(null);
      for (const k of Object.keys(ls)) proxy[k] = (...args) => ls[k](...args);
      // inside generated code (if someone opens it), leave navigation alone
      const keep = (file, defs) => (!defs || GENERATED.test(file) ? defs : defs.filter((d) => !GENERATED.test(d.fileName)));
      proxy.getDefinitionAtPosition = (file, pos) => keep(file, ls.getDefinitionAtPosition(file, pos));
      proxy.getDefinitionAndBoundSpan = (file, pos) => {
        const r = ls.getDefinitionAndBoundSpan(file, pos);
        return r && r.definitions ? { ...r, definitions: keep(file, r.definitions) } : r;
      };
      return proxy;
    },
  };
}

module.exports = init;
