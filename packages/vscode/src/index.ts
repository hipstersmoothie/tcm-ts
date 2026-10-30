// tcm's VS Code extension, packed as one: `tcm pack tcm-ts-vscode`, then `vsce package` in what it writes. Its
// code is the definitions here; the extension's own manifest (views, commands, settings) and what it ships beside
// the code (its icon, README, the TypeScript server plugin) are files of the codebase, in `files`.

/** The tcm-ts codebase in VS Code. */
export const manifest = {
  name: "tcm-ts-vscode",
  exports: { ".": ["extension.activate", "extension.deactivate"] },
  // the package.json VS Code reads, which the packed one starts from
  packageJson: "files.package",
  files: ["files.README", "files.media", "files.plugin", "../LICENSE"],
};
