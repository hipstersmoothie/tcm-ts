// tcm's npm package, tcm-ts: what it exports and its commands. tcm's own codebase (`pnpm tcm`, `pnpm build`)
// reads this to pack and release it; versions come from `tcm release`, its records from tcm-releases.json.

/** Unison's content-addressed codebase model for plain TypeScript. */
export const manifest = {
  name: "tcm-ts",
  exports: { "./core": ["core.analyze.analyzeFile", "core.analyze.analyzeProject", "core.hash.IR_VERSION"] },
  bin: { tcm: "cli.main.runCli", "tcm-ts": "cli.main.runCli" },
  with: ["@types/node@^24"],
  files: ["../README.md", "docs"],
  // the end-to-end tests, run against the codebase's own tcm by `tcm test`
  suites: { tcm: ["cli.test.e2e"] },
}
