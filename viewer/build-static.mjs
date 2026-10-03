#!/usr/bin/env node
// build-static.mjs — render the viewer as a static site for GitHub Pages.
//
//   node viewer/build-static.mjs [--results ./results] [--out ./site]
//
// Writes index.html (flagged data-static so the client fetches `<path>.json`), format.mjs and
// one JSON file per API path the static pages need: the run list, each run's meter aggregate
// and summary, and each run's per-task outcomes. Raw request captures are never committed, so
// the per-call routes are not rendered; on the bench host the live server (server.mjs) has them.

import fs from "node:fs";
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
const OUT = path.resolve(flag("--out", path.join(here, "..", "site")));

setResults(RESULTS);
fs.rmSync(OUT, { recursive: true, force: true });

const write = (rel, body) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
};
// Same encoding the client applies (encodeURIComponent per segment), so fetch() finds the file.
const emit = async (apiPath) => {
  const value = await handle(apiPath);
  write(`${apiPath.split("/").map(encodeURIComponent).join("/")}.json`, value);
  return value;
};

const html = fs.readFileSync(path.join(here, "index.html"), "utf8").replace("<html lang=\"en\">", "<html lang=\"en\" data-static=\"1\">");
if (!html.includes("data-static=\"1\"")) throw new Error("index.html: could not set data-static");
write("index.html", html);
write("format.mjs", fs.readFileSync(path.join(here, "..", "format.mjs"), "utf8"));
write(".nojekyll", "");

const runs = await emit("/api/runs");
for (const { run } of runs) {
  await emit(`/api/runs/${run}`);
  await emit(`/api/runs/${run}/outcomes`);
}
process.stdout.write(`[build-static] ${runs.length} runs -> ${OUT}\n`);
