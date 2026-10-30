// Tiny static server for probe media. Usage: node server.mjs [port]
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8329);
const types = { ".html": "text/html", ".wav": "audio/wav", ".png": "image/png" };

http
  .createServer((req, res) => {
    const p = path.join(dir, req.url === "/" ? "page.html" : req.url.split("?")[0].replace(/^\/+/, ""));
    try {
      const data = readFileSync(p);
      res.writeHead(200, {
        "content-type": types[path.extname(p)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404).end("no");
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`probe media server on http://127.0.0.1:${port}/`));
