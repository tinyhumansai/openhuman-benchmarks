import assert from "node:assert/strict";
import test from "node:test";
import { answerPaths, commandTokens, probesFor, score, toolFamily } from "./probes.mjs";

const truth = {
  workdir: "/app",
  task_identifiers: ["rolling_min", "min_samples", "Quantile must be between 0.0 and 1.0"],
  files_modified: ["narwhals/expr.py", "narwhals/series.py"],
  files_read: ["narwhals/expr.py", "narwhals/_utils.py"],
  last_failing_command: { command: "cd /app && python -m pytest tests/rolling_test.py -q", error_signature: "E   AssertionError: assert [1, 2] == [1, 3]" },
  test_command: { command: "cd /app && python -m pytest tests/rolling_test.py -q 2>&1 | tail -5", core: "python -m pytest tests/rolling_test.py -q" },
  next_action: { tool: "bash", primary_arg: "cd /app && sed -n '1,80p' narwhals/series.py" },
};

test("every non-empty truth field yields a probe with a scorer", () => {
  const probes = probesFor(truth, "cp1");
  assert.deepEqual(probes.map((p) => p.kind), ["files_modified", "files_read", "test_command", "last_failing_command", "error_signature", "task_identifiers", "next_action"]);
  for (const p of probes) {
    assert.ok(p.question.length > 20);
    assert.ok(["set_f1", "contains_all", "exact_line", "tool_match"].includes(p.scorer));
    assert.equal(p.id, `cp1#${p.kind}`);
  }
  assert.deepEqual(probesFor({ files_modified: [], files_read: [], task_identifiers: [], next_action: { tool: null, text: "done" } }), []);
});

const probe = (kind) => probesFor(truth, "cp").find((p) => p.kind === kind);

test("set_f1 normalizes absolute paths, bullets and backticks", () => {
  const p = probe("files_modified");
  assert.equal(score(p, "- `/app/narwhals/expr.py`\n- ./narwhals/series.py").score, 1);
  const half = score(p, "narwhals/expr.py\nnarwhals/dataframe.py");
  assert.equal(half.score, 0.5);
  assert.deepEqual(half.detail.missing, ["narwhals/series.py"]);
  assert.equal(score(p, "I have not modified anything.").score, 0);
  assert.deepEqual(answerPaths("1. /testbed/a/b.py — the model\n2. c.py", "/testbed"), ["a/b.py", "c.py"]);
});

test("contains_all: exact identifiers are case-sensitive and whole-token; command tokens are not", () => {
  const ids = probe("task_identifiers");
  assert.equal(score(ids, "rolling_min\nmin_samples\n\"Quantile must be between 0.0 and 1.0\"").score, 1);
  assert.ok(Math.abs(score(ids, "Rolling_Min, min_samples_x").score - 0) < 1e-9);
  const cmd = probe("test_command");
  assert.equal(score(cmd, "```bash\ncd /app && python -m pytest tests/rolling_test.py -q\n```").score, 1);
  assert.ok(score(cmd, "pytest").score < 0.5);
  assert.deepEqual(commandTokens("cd /app && go test ./... 2>&1 | tail -30"), ["go", "test", "./..."]);
});

test("exact_line: full credit for the quoted line, partial for overlapping tokens", () => {
  const p = probe("error_signature");
  assert.equal(score(p, "The last error was:\n`E   AssertionError: assert [1, 2] == [1, 3]`").score, 1);
  const partial = score(p, "an AssertionError comparing [1, 2] to something");
  assert.ok(partial.score > 0 && partial.score < 0.9);
  assert.equal(score(p, "no errors").score, 0);
});

test("tool_match: tool family plus primary argument", () => {
  const p = probe("next_action");
  assert.equal(toolFamily("terminal"), "shell");
  assert.equal(toolFamily("str_replace_editor"), "edit");
  assert.equal(score(p, "bash: sed -n '1,80p' narwhals/series.py").score, 1);
  const wrongArg = score(p, "I will run a shell command: ls");
  assert.ok(wrongArg.score >= 0.4 && wrongArg.score < 0.7);
  const pathProbe = { ...p, expected: { tool: "Read", primary_arg: "/app/narwhals/series.py" } };
  assert.equal(score(pathProbe, "Read narwhals/series.py").score, 1);
  assert.ok(score(pathProbe, "Edit /app/narwhals/expr.py").score < 0.5);
});
