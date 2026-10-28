// The VS Code side of `ucm lsp`: starts the language server and adds the bits that need VS Code's UI (saving a
// file before it's added, asking for a new name). Everything else (lenses, watch values, hovers) is the server's.
const fs = require("node:fs");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;

/**
 * `ucm.path` is the ucm executable, or a path to ucm's `bin/ucm.js` (run with Node), or a command line whose
 * words are separated by spaces, with "quotes" around a word that contains spaces.
 */
function serverCommand() {
  const setting = vscode.workspace.getConfiguration("ucm").get("path", "ucm").trim();
  // a file: ucm itself, or its bin/ucm.js (spaces in the path and all)
  if (fs.existsSync(setting)) return /\.(c|m)?js$/.test(setting) ? { command: "node", args: [setting, "lsp"] } : { command: setting, args: ["lsp"] };
  const words = [...setting.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  return { command: words[0], args: [...words.slice(1), "lsp"] };
}

async function activate(context) {
  const { command, args } = serverCommand();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  client = new LanguageClient(
    "ucm",
    "ucm-ts",
    { command, args, options: { cwd: folder } },
    {
      documentSelector: [{ scheme: "file", language: "typescript" }],
      middleware: {
        // ucm add/update save what's on disk: save the file first, and default to the active editor's file
        executeCommand: async (cmd, cmdArgs, next) => {
          if (cmd === "ucm.add" || cmd === "ucm.update") {
            const uri = cmdArgs[0] ?? vscode.window.activeTextEditor?.document.uri.toString();
            if (!uri) return;
            await vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri)?.save();
            return next(cmd, [uri]);
          }
          return next(cmd, cmdArgs);
        },
      },
    },
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ucm.rename", async (from) => {
      from ??= await vscode.window.showInputBox({ prompt: "Rename which definition?", placeHolder: "lib.square" });
      if (!from) return;
      const to = await vscode.window.showInputBox({ prompt: `Rename ${from} to`, value: from });
      if (!to || to === from) return;
      await client.sendRequest("workspace/executeCommand", { command: "ucm.mv", arguments: [from, to] });
    }),
  );
  await client.start();
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
