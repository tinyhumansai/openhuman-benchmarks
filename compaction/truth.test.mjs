import assert from "node:assert/strict";
import test from "node:test";
import {
  detectWorkdir,
  errorSignature,
  failureOf,
  filesModified,
  filesRead,
  groundTruth,
  lastFailingCommand,
  normPath,
  shellFiles,
  taskIdentifiers,
  testCommand,
  toolRounds,
} from "./truth.mjs";

let n = 0;
/** One assistant tool call plus its result, as normalized chat messages. */
const round = (name, args, result = "ok") => {
  const id = `c${(n += 1)}`;
  return [
    { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];
};
const rounds = (...rs) => toolRounds(rs.flat());

test("paths normalize relative to the repo root; outside paths and dirs drop", () => {
  assert.equal(normPath("/app/src/a.py", "/app"), "src/a.py");
  assert.equal(normPath("./src/a.py", "/app"), "src/a.py");
  assert.equal(normPath("/testbed/x/../y.py", "/testbed"), "y.py");
  assert.equal(normPath("/tmp/scratch.py", "/app"), null);
  assert.equal(normPath("/app/.git/config", "/app"), null);
  assert.equal(normPath("/app/tmp/ref/", "/app"), null);
  assert.equal(detectWorkdir([{ role: "user", content: "a git checkout of the repository at /testbed. Resolve" }]), "/testbed");
});

test("files_modified: apply_patch envelope (openclaw/codex style)", () => {
  const patch = "*** Begin Patch\n*** Update File: /app/lib/a.js\n@@\n-x\n+y\n*** Add File: lib/b.js\n+new\n*** End Patch";
  assert.deepEqual(filesModified(rounds(round("apply_patch", { input: patch })), "/app"), ["lib/a.js", "lib/b.js"]);
});

test("files_modified: Claude Code Edit/Write/MultiEdit, opencode filePath, openhuman edits[]", () => {
  const r = rounds(
    round("Edit", { file_path: "/app/a.go", old_string: "x", new_string: "y" }),
    round("Write", { file_path: "/app/b.go", content: "package b" }),
    round("edit", { filePath: "/app/c.ts", oldString: "a", newString: "b" }),
    round("apply_patch", { edits: [{ path: "/app/d.go", old_string: "a", new_string: "b" }, { path: "/app/a.go", old_string: "c", new_string: "d" }] }),
    round("Read", { file_path: "/app/e.go" }),
    round("TodoWrite", { todos: [{ content: "edit /app/f.go" }] }),
  );
  assert.deepEqual(filesModified(r, "/app"), ["a.go", "b.go", "c.ts", "d.go"]);
  assert.deepEqual(filesRead(r, "/app"), ["e.go"]);
});

test("files_modified: hermes patch and write_file, and a double-encoded argument string", () => {
  const r = rounds(
    round("patch", { path: "/app/parser/ast.go", old_string: "a", new_string: "b", mode: "replace" }),
    round("write_file", { path: "/app/parser/pattern.go", content: "package parser" }),
    round("apply_patch", JSON.stringify(JSON.stringify({ edits: [{ path: "/app/x.go" }] }))),
  );
  assert.deepEqual(filesModified(r, "/app"), ["parser/ast.go", "parser/pattern.go", "x.go"]);
});

test("files_modified: shell writes (sed -i, heredoc redirect, tee, python open, git apply output)", () => {
  const r = rounds(
    round("bash", { command: "cd /app && sed -i 's/a/b/' src/x.py src/y.py" }),
    round("exec", { command: "cat > /app/src/new.py <<'EOF'\nprint(1) > ignored.txt\nEOF" }),
    round("shell", { command: "echo hi | tee -a /app/notes.md >/dev/null" }),
    round("terminal", { command: "python3 - <<'PY'\nopen('/app/cfg.toml','w').write('x')\nPY" }),
    round("bash", { command: "cd /app && git apply /tmp/fix.patch && git status --short" }, " M src/applied.py\n?? src/added.py"),
    round("bash", { command: "cd /app && ls > /tmp/out.txt 2>&1" }),
  );
  assert.deepEqual(filesModified(r, "/app"), ["src/x.py", "src/y.py", "src/new.py", "notes.md", "cfg.toml", "src/applied.py", "src/added.py"]);
});

test("files_read: read tools and cat/sed -n/head in a shell", () => {
  const r = rounds(
    round("read_file", { path: "/app/a.py", offset: 1 }),
    round("bash", { command: "cd /app/pkg && sed -n '1,40p' mod.py && head -n 5 ../README.md | cat" }),
  );
  assert.deepEqual(filesRead(r, "/app"), ["a.py", "pkg/mod.py", "README.md"]);
  assert.deepEqual(shellFiles("cat /app/a b.txt", "/app").read, ["a", "b.txt"]);
});

test("failure detection: exit-code markers of each harness, SIGPIPE is not a failure", () => {
  assert.ok(failureOf("boom\nCommand failed (exit code 2)"));
  assert.ok(failureOf("x\n\n(Command exited with code 1)"));
  assert.ok(failureOf("Exit code 1\nparser.go:1:1: expected 'package'"));
  assert.equal(failureOf("out\nCommand failed (exit code 141)"), null);
  assert.equal(failureOf("Exit code 0"), null);
  assert.ok(failureOf('{"output": "Traceback (most recent call last):\\nValueError: bad", "exit_code": 1, "error": null}\n\n[Tool loop warning]'));
  assert.equal(failureOf('{"output": "FAILED? no, all good", "exit_code": 0, "error": null}'), null);
  assert.ok(failureOf("tests/test_a.py F\nFAILED tests/test_a.py::test_x - AssertionError: 1 != 2\n=== 1 failed in 0.1s ==="));
  assert.equal(failureOf("all 12 tests passed"), null);
});

test("error signature prefers the exception / assertion line over the exit marker", () => {
  const out = "Traceback (most recent call last):\n  File \"x.py\", line 3, in <module>\n    f()\nTypeError: f() missing 1 required positional argument: 'a'\nCommand failed (exit code 1)";
  assert.equal(errorSignature(out), "TypeError: f() missing 1 required positional argument: 'a'");
  assert.equal(errorSignature("--- FAIL: TestX (0.00s)\n    x_test.go:12: expected 3, got 4\nFAIL"), "x_test.go:12: expected 3, got 4");
  assert.equal(errorSignature("Command failed (exit code 1)"), null);
});

test("last failing command skips lookups and no-match greps, keeps real failures", () => {
  const r = rounds(
    round("bash", { command: "cd /app && go test ./..." }, "--- FAIL: TestA\n    a_test.go:9: want 1 got 2\nFAIL\nExit code 1"),
    round("bash", { command: "cd /app && python run.py | grep foo" }, "Command failed (exit code 1)"),
    round("bash", { command: "cd /app && grep -rn nothing ." }, "Command failed (exit code 1)"),
    round("read", { path: "/app/a.go" }, "Error: something in file contents"),
  );
  const f = lastFailingCommand(r);
  assert.equal(f.command, "cd /app && go test ./...");
  assert.equal(f.error_signature, "a_test.go:9: want 1 got 2");
});

test("test command: runners anywhere in a pipeline, not paths or arguments that mention one", () => {
  const t = testCommand(rounds(round("bash", { command: "cd /app && CI=true timeout 300 pnpm test sequencers.test.ts 2>&1 | tail -20" })));
  assert.equal(t.core, "pnpm test sequencers.test.ts");
  assert.equal(testCommand(rounds(round("bash", { command: "sed -n 1,20p packages/vitest/src/cli.ts" }))), null);
  assert.equal(testCommand(rounds(round("bash", { command: "which python3 pytest" }))), null);
  assert.equal(testCommand(rounds(round("terminal", { command: "cd /testbed && python -m pytest tests/test_x.py -q" }))).core, "python -m pytest tests/test_x.py -q");
  assert.equal(testCommand(rounds(round("exec", { command: "cd /testbed && ./tests/runtests.py queries" }))).core, "./tests/runtests.py queries");
  assert.equal(testCommand(rounds(round("bash", { command: "go test ./parser/... -run TestX" }))).core, "go test ./parser/... -run TestX");
});

test("task identifiers: backtick spans, signatures, flags, quoted literals; no fenced code or operators", () => {
  const task = [
    "Add `rolling_quantile(window_size, *, quantile, interpolation='linear')` to `Expr`.",
    "Raise `ValueError` with message starting with `\"Quantile must be between 0.0 and 1.0\"`.",
    "Support the `--shard-strategy` flag and the durationHistoryTTL option. Use `==` and `, COUNT(` never.",
    "```python\nshould_not_appear_identifier = 1\n```",
  ].join("\n");
  const ids = taskIdentifiers(task);
  for (const want of ["rolling_quantile", "window_size", "interpolation", "linear", "Expr", "ValueError", "Quantile must be between 0.0 and 1.0", "--shard-strategy", "durationHistoryTTL"]) {
    assert.ok(ids.includes(want), `missing ${want}: ${ids.join(" | ")}`);
  }
  for (const no of ["==", ", COUNT(", "should_not_appear_identifier"]) assert.ok(!ids.includes(no), `unexpected ${no}`);
  assert.ok(taskIdentifiers("x ".repeat(10) + "`a_b` ".repeat(1)).length <= 40);
});

test("groundTruth over a prefix: next action, stats and task identifiers from the prompt", () => {
  const prefix = [
    { role: "system", content: "sys" },
    { role: "user", content: "You are working in a git checkout of the repository at /app. Do it.\n\n<task>\nAdd `foo_bar`.\n</task>" },
    ...round("bash", { command: "cd /app && cat src/a.py" }, "x = 1"),
    ...round("str_replace_based_edit_tool", { command: "str_replace", path: "/app/src/a.py", old_str: "1", new_str: "2" }),
  ];
  const next = { role: "assistant", content: "", tool_calls: [{ id: "z", type: "function", function: { name: "bash", arguments: '{"command":"cd /app && pytest -q"}' } }] };
  const t = groundTruth(prefix, next);
  assert.equal(t.workdir, "/app");
  assert.deepEqual(t.task_identifiers, ["foo_bar"]);
  assert.deepEqual(t.files_modified, ["src/a.py"]);
  assert.deepEqual(t.files_read, ["src/a.py"]);
  assert.equal(t.next_action.tool, "bash");
  assert.equal(t.next_action.primary_arg, "cd /app && pytest -q");
  assert.equal(t.stats.tool_rounds, 2);
  assert.equal(t.stats.est_tokens, Math.round(t.stats.chars / 4));
});
