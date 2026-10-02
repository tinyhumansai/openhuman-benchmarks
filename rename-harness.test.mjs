import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renameInJsonl } from "./rename-harness.mjs";

test("renameInJsonl rewrites only the matching run and harness", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rn-")), "m.jsonl");
  const rows = [
    { run_id: "r1", harness: "a", x: 1 },
    { run_id: "r1", harness: "b", x: 2 },
    { run_id: "r2", harness: "a", x: 3 },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(renameInJsonl(file, "r1", "a", "z"), 1);
  const got = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(got.map((r) => r.harness), ["z", "b", "a"]);
  assert.equal(got[0].x, 1);
});
