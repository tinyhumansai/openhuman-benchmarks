import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMeta } from "./run-meta.mjs";

test("runMeta reads the OpenHuman bundle stamp, lock versions and set knobs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
  fs.mkdirSync(path.join(root, ".cache/harness/openhuman/openhuman"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cache/harness/openhuman/openhuman/GIT_SHA"), "abc1234\n");
  fs.writeFileSync(path.join(root, "harnesses.lock"), "# x\nCLAUDE_CODE_VERSION=2.1.0\n");
  const env = { OPENHUMAN_COMPACTION_TRIGGER_TOKENS: "64000", OPENHUMAN_X: "", TASK_TIMEOUT_S: "3600", HOME: "/h" };
  assert.deepEqual(runMeta(root, "openhuman", env), {
    harness_version: "abc1234",
    knobs: { OPENHUMAN_COMPACTION_TRIGGER_TOKENS: "64000", TASK_TIMEOUT_S: "3600" },
  });
  assert.equal(runMeta(root, "claude-code", {}).harness_version, "2.1.0");
  assert.equal(runMeta(root, "hermes", {}).harness_version, null);
});
