#!/usr/bin/env node
// prepare.mjs — turn a local copy of the gated datacurve/deep-swe dataset into a bench task suite.
//   node deepswe/prepare.mjs [--src .cache/deepswe] [--out tasks/generated/deepswe] [--pull] [--only a,b]
// Download the dataset first (needs an HF token with access; never commit it):
//   HF_TOKEN=... uvx --from huggingface_hub hf download datacurve/deep-swe --repo-type dataset --local-dir .cache/deepswe
// Writes <out>/tasks.json plus one dir per task holding prompt.txt (the same wrapper SWE uses
// around the dataset's own instruction.md). Tasks run in the dataset's prebuilt image at /app.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const src = path.resolve(root, opt("--src", ".cache/deepswe"));
const out = path.resolve(root, opt("--out", "tasks/generated/deepswe"));
const only = opt("--only", "")?.split(",").filter(Boolean);

const WRAPPER = (workdir, instruction) => `You are working in a git checkout of the repository at ${workdir}. Implement the following change by editing the source code in place.

Do not modify or add test files unless the task requires it. When you are done, stop; your changes are collected from the working tree.

<task>
${instruction.trim()}
</task>
`;

const field = (toml, key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

const tasks = [];
for (const id of fs.readdirSync(path.join(src, "tasks")).sort()) {
  const tdir = path.join(src, "tasks", id);
  const tomlFile = path.join(tdir, "task.toml");
  if (!fs.existsSync(tomlFile)) continue;
  if (only.length && !only.includes(id)) continue;
  const toml = fs.readFileSync(tomlFile, "utf8");
  const image = field(toml, "docker_image");
  if (!image) throw new Error(`${id}: no docker_image in task.toml`);
  const d = path.join(out, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "prompt.txt"), WRAPPER("/app", fs.readFileSync(path.join(tdir, "instruction.md"), "utf8")));
  tasks.push({ id, image, workdir: "/app", dir: d, language: field(toml, "language") });
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "tasks.json"), JSON.stringify(tasks, null, 2));
console.log(`prepared ${tasks.length} tasks -> ${out}`);

if (args.includes("--pull")) {
  for (const t of tasks) {
    console.log("pull", t.image);
    const r = spawnSync("docker", ["pull", "-q", t.image], { stdio: "inherit" });
    if (r.status !== 0) console.error(`pull failed for ${t.id}`);
  }
}
