#!/usr/bin/env node
// server.mjs — a small read-only web UI over results/: runs, per-harness
// aggregates, the system prompt each harness actually sent (captured by the
// meter proxy), tool schemas, per-call cache diagnostics, and responses.
//
//   node viewer/server.mjs [--port 8787] [--results ./results]
//
// No dependencies, binds to loopback, reads files on demand (nothing is held
// in memory beyond the request being served) so it stays out of the way of a
// running benchmark.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle, setResults } from "./api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const RESULTS = path.resolve(flag("--results", path.join(here, "..", "results")));
const PORT = Number(flag("--port", process.env.VIEWER_PORT ?? 8787));
const HOST = flag("--host", process.env.VIEWER_HOST ?? "127.0.0.1");

setResults(RESULTS);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    if (req.method !== "GET") return send(405, { error: "read-only" });
    if (url.pathname === "/format.mjs") {
      return send(200, fs.readFileSync(path.join(here, "..", "format.mjs"), "utf8"), "text/javascript; charset=utf-8");
    }
    if (url.pathname === "/favicon.ico") return send(204, "", "image/x-icon");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(200, fs.readFileSync(path.join(here, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/api/")) {
      const out = await handle(url.pathname);
      // ?format=md serves the transcript as a plain Markdown document (curl / download).
      if (url.searchParams.get("format") === "md" && out.markdown) return send(200, out.markdown, "text/markdown; charset=utf-8");
      return send(200, out);
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(e.code === 400 ? 400 : e.code === "ENOENT" ? 404 : 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[viewer] http://${HOST}:${PORT}  results=${RESULTS}\n`);
});
