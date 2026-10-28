// The docs site while writing docs: serves dist/site, rebuilds it when docs/ or examples/ change, and reloads open
// pages after each rebuild.
//
//   node scripts/docs-dev.ts [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const site = path.join(repo, "dist", "site");
const port = Number(process.argv[2] ?? 4321);
const clients = new Set<http.ServerResponse>();

function build(): boolean {
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "docs-site.ts"), site], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.status === 0;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
// pages reload themselves when the site is rebuilt
const RELOAD = `<script>new EventSource("/__reload").onmessage = () => location.reload();</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/__reload") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  const file = path.join(site, path.normalize(url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  const body = fs.readFileSync(file);
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(type.startsWith("text/html") ? body.toString().replace("</body>", `${RELOAD}</body>`) : body);
});

build();
let timer: NodeJS.Timeout | undefined;
for (const dir of ["docs", "examples", "scripts"]) {
  fs.watch(path.join(repo, dir), { recursive: true }, (_e, name) => {
    if (dir === "scripts" && name !== "docs-site.ts") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (build()) for (const c of clients) c.write("data: reload\n\n");
    }, 100);
  });
}
// the next free port if this one is taken (4321 is a popular default)
let tries = 0;
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE" || ++tries > 20) throw e;
  server.listen(port + tries, "127.0.0.1");
});
server.on("listening", () => {
  const a = server.address() as { port: number };
  console.log(`docs dev server: http://127.0.0.1:${a.port}/  (rebuilds on changes to docs/ and examples/)`);
});
server.listen(port, "127.0.0.1");
