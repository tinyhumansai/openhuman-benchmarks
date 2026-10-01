#!/usr/bin/env node
// orchestrate.mjs — host-side driver. For one harness and one task suite it
// runs each task in a fresh, resource-limited container through the compose
// `task` service, tagging the metering proxy first so every inference call is
// attributed to (run, harness, task).
//
//   node orchestrate.mjs --harness openhuman --suite micro [--run-id ID]
//        [--only m3-edit] [--repeat 3] [--tasks-dir DIR]
//
// Tasks come from <tasks-dir>/tasks.json: [{id,image,workdir,dir}], where `dir`
// holds prompt.txt (+ optional setup.sh / check.sh). `micro` is generated on
// demand; `swe` is produced by swebench/select.py + swebench/prepare.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeMicroSuite } from "./tasks/micro.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { repeat: 1 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} expects a value`);
      return v;
    };
    if (a === "--harness") o.harness = val();
    else if (a === "--suite") o.suite = val();
    else if (a === "--run-id") o.runId = val();
    else if (a === "--only") o.only = val();
    else if (a === "--repeat") o.repeat = Number(val());
    else if (a === "--tasks-dir") o.tasksDir = path.resolve(val());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.harness || !o.suite) throw new Error("--harness and --suite are required");
  o.runId ??= `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return o;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: here, encoding: "utf8", ...opts });
}

async function tagProxy(port, tag) {
  const res = await fetch(`http://127.0.0.1:${port}/__bench/run`, {
    method: "POST",
    body: JSON.stringify(tag),
  });
  if (!res.ok) throw new Error(`tagging proxy failed: HTTP ${res.status}`);
}

async function main() {
  const o = parseArgs(process.argv);
  const bundle = path.join(here, ".cache", "harness", o.harness);
  if (!fs.existsSync(path.join(bundle, "adapter.sh"))) {
    throw new Error(`no bundle for ${o.harness}: run ./bundles/build.sh ${o.harness}`);
  }

  let tasksDir = o.tasksDir;
  if (!tasksDir) {
    tasksDir = path.join(here, "tasks", "generated", o.suite);
    if (o.suite === "micro") writeMicroSuite(tasksDir);
  }
  const tasksFile = path.join(tasksDir, "tasks.json");
  if (!fs.existsSync(tasksFile)) throw new Error(`missing ${tasksFile}`);
  let tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
  if (o.only) tasks = tasks.filter((t) => t.id === o.only);
  if (!tasks.length) throw new Error("no tasks selected");

  if (o.suite === "micro") {
    const b = sh("docker", ["compose", "--profile", "build", "build", "micro-image"], { stdio: "inherit" });
    if (b.status !== 0) throw new Error("building bench-micro failed");
  }

  const up = sh("docker", ["compose", "up", "-d", "--build", "--wait", "meter-proxy"], { stdio: "inherit" });
  if (up.status !== 0) throw new Error("meter-proxy failed to start");
  const port = process.env.METER_HOST_PORT || "18080";

  const runDir = path.join(here, "results", o.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const index = path.join(runDir, "runs.jsonl");

  for (const task of tasks) {
    for (let rep = 1; rep <= o.repeat; rep += 1) {
      const taskKey = o.repeat > 1 ? `${task.id}#r${rep}` : task.id;
      const resultDir = path.join(runDir, o.harness, taskKey);
      fs.mkdirSync(resultDir, { recursive: true });
      await tagProxy(port, { run_id: o.runId, harness: o.harness, task: taskKey });

      process.stdout.write(`[bench] ${o.harness} ${taskKey} ...\n`);
      const startedAt = Date.now();
      const r = sh(
        "docker",
        ["compose", "--profile", "task", "run", "--rm", "--no-deps", "task"],
        {
          stdio: ["ignore", "inherit", "inherit"],
          env: {
            ...process.env,
            TASK_IMAGE: task.image,
            HARNESS: o.harness,
            TASK_ID: taskKey,
            WORKDIR: task.workdir,
            TASK_DIR: task.dir,
            RUN_ID: o.runId,
          },
        },
      );
      const row = {
        run_id: o.runId,
        harness: o.harness,
        suite: o.suite,
        task: task.id,
        task_key: taskKey,
        compose_exit: r.status,
        started_epoch_ms: startedAt,
        ended_epoch_ms: Date.now(),
      };
      fs.appendFileSync(index, `${JSON.stringify(row)}\n`);
      process.stdout.write(`[bench] ${taskKey} compose_exit=${r.status}\n`);
    }
  }
  process.stdout.write(`[bench] done: ${runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`[bench] ${error.message}\n`);
  process.exit(1);
});
