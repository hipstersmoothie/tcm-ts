import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { okIn, tempDir, tcmIn } from "./harness.ts";

/**
 * A mirror keeps its Markdown and images as files of the codebase, written back as they change.
 */
export const testFilesInAMirror = () => {
  const root = tempDir("files mirror");
  const proj = path.join(root, "proj");
  const cbDir = path.join(root, "cb");
  for (const d of ["src", "docs", "media", "ext"]) fs.mkdirSync(path.join(proj, d), { recursive: true });
  fs.mkdirSync(cbDir);
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(proj, "src", "math.ts"), "export const square = (x: number): number => x * x;\n");
  fs.writeFileSync(path.join(proj, "docs", "guide.md"), "# Guide\n\nSee {@link math.square} and [the FAQ](faq.md#why).\n");
  fs.writeFileSync(path.join(proj, "docs", "faq.md"), "# FAQ\n\n## Why\n\nBack to [the guide](guide.md).\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
  fs.writeFileSync(path.join(proj, "media", "logo.png"), png);
  // everything in a marked directory is a file, code included
  fs.writeFileSync(path.join(proj, "ext", ".tcm-files"), "");
  fs.writeFileSync(path.join(proj, "ext", "main.js"), "module.exports = 1;\n");
  assert.equal(spawnSync("git", ["-C", proj, "init", "-q"]).status, 0);
  const ok = (...args: string[]) => okIn(cbDir, ...args);
  const read = (f: string) => fs.readFileSync(path.join(proj, f), "utf8");
  ok("init");
  fs.rmSync(path.join(cbDir, "scratch.ts"));
  ok("import", proj, "--into", "app", "--mirror");
  assert.match(ok("ls", "app"), /app\.docs\.faq +#\w+ +: md[\s\S]*app\.docs\.guide +#\w+ +: md[\s\S]*app\.ext\.main +#\w+ +: js[\s\S]*app\.media\.logo +#\w+ +: png/);
  assert.match(ok("mirror", "--check"), /the files hash to what the codebase holds/);

  // a rename of the code reaches the page that names it, written as short as it reads
  ok("mv", "app.math.square", "app.math.sq");
  assert.equal(read("docs/guide.md"), "# Guide\n\nSee {@link math.sq} and [the FAQ](faq.md#why).\n");
  // a page moved is a file moved, and the pages linking to it follow
  ok("mv", "app.docs.faq", "app.docs.questions");
  assert.ok(!fs.existsSync(path.join(proj, "docs", "faq.md")));
  assert.equal(read("docs/questions.md"), "# FAQ\n\n## Why\n\nBack to [the guide](guide.md).\n");
  assert.match(read("docs/guide.md"), /\[the FAQ\]\(questions\.md#why\)/);
  // an edit by hand is followed
  fs.appendFileSync(path.join(proj, "docs", "questions.md"), "\nMore.\n");
  assert.match(ok("view", "app.docs.questions"), /More\./);
  // bytes are kept as bytes
  ok("export", "app.media", path.join(root, "out"));
  assert.ok(fs.readFileSync(path.join(root, "out", "logo.png")).equals(png));
  // one file is written by its name
  ok("export", "app.docs.guide", path.join(root, "one"));
  assert.deepEqual(fs.readdirSync(path.join(root, "one")), ["guide.md"]);
  // a marked directory removed, its mark with it: its files go too
  fs.rmSync(path.join(proj, "ext"), { recursive: true });
  assert.match(ok("ls", "app"), /- removed +app\.ext\.main \(gone from the files\)/);
  assert.doesNotMatch(ok("ls", "app"), /app\.ext/);
  assert.match(ok("mirror", "--check"), /the files hash to what the codebase holds/);
}

/**
 * Pages are definitions: links to code follow renames, links to pages follow moves, and they're edited as files.
 */
export const testPagesAreDefinitions = () => {
  const dir = tempDir("files");
  const ok = (...args: string[]) => okIn(dir, ...args);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  ok("init");
  write("scratch.ts", `// tcm: namespace lib\nexport const square = (x: number) => x * x;\n`);
  ok("add");
  write("pages/guide.md", "<!-- tcm: namespace docs -->\n# Guide\n\nUse {@link lib.square}. See [the FAQ](faq.md#why), not `[this](code.md)`.\n\n```md\n[nor this](fence.md)\n```\n");
  write("pages/faq.md", "<!-- tcm: namespace docs -->\n# FAQ\n\n## Why\n\nBack to [the guide](guide.md).\n");
  // a link to a page that isn't there yet is a warning; a {@link} to no code is a problem
  assert.match(ok("check", "pages/guide.md"), /warning: docs\.guide links to faq\.md#why, and there's no docs\.faq[\s\S]*\+ new +docs\.guide : md[\s\S]*tcm add pages\/guide\.md/);
  write("pages/bad.md", "<!-- tcm: namespace docs -->\nSee {@link lib.nothing}.\n");
  assert.match(tcmIn(dir, "add", "pages/bad.md").out, /\{@link lib\.nothing\}: there's no lib\.nothing in the codebase/);
  ok("add", "pages/faq.md");
  ok("add", "pages/guide.md");
  assert.match(ok("ls", "docs"), /docs\.faq +#\w+ +: md\ndocs\.guide +#\w+ +: md/);

  // renaming the code changes no page's text: the page names it as it's called now
  ok("mv", "lib.square", "lib.sq");
  assert.match(ok("view", "docs.guide"), /Use \{@link lib\.sq\}\./);
  // moving a page follows it in the pages that link to it, and refuses to leave a link with nowhere to go
  assert.match(ok("mv", "docs.faq", "docs.questions"), /links to it changed in docs\.guide/);
  assert.match(ok("view", "docs.guide"), /\[the FAQ\]\(questions\.md#why\)/);
  assert.match(tcmIn(dir, "rm", "docs.questions").out, /'docs\.questions' is used by docs\.guide/);

  // edited as the file it is, and saved back to where it came from
  ok("edit", "docs.guide");
  const edited = path.join(dir, "guide.md");
  assert.match(fs.readFileSync(edited, "utf8"), /^<!-- tcm: path docs\.guide -->\n# Guide/);
  fs.writeFileSync(edited, fs.readFileSync(edited, "utf8").replace("# Guide", "# The guide"));
  assert.match(ok("update", "guide.md"), /~ update +docs\.guide : md/);

  // written out as files, links as they are now; and re-hashed by verify
  ok("export", "docs", "site");
  assert.match(fs.readFileSync(path.join(dir, "site", "guide.md"), "utf8"), /^# The guide\n\nUse \{@link lib\.sq\}\. See \[the FAQ\]\(questions\.md#why\)/);
  assert.ok(fs.existsSync(path.join(dir, "site", "questions.md")));
  assert.match(ok("verify"), /verified 3 definitions/);
}
