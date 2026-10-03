// truth.mjs — deterministic ground truth for one checkpoint, computed from the prefix only.
//
// Everything here reads normalized OpenAI-chat messages (see normalize.mjs). Tool vocabularies
// differ per harness, so recognition goes by argument shape as much as by tool name.

import path from "node:path";

const posix = path.posix;

// ---------------------------------------------------------------- paths

/** The repository root the task ran in, from the task prompt (DeepSWE: /app, SWE-bench: /testbed). */
export function detectWorkdir(messages) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const hit = m.content.match(/repository at (\/[\w./-]+?)[.\s]/);
    if (hit) return hit[1].replace(/\/$/, "");
  }
  return "/app";
}

/**
 * A path relative to the repository root, or null when it is outside it (scratch files in /tmp,
 * /dev/null, home directories) or not a path at all.
 */
export function normPath(p, workdir = "/app", cwd = workdir) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^["'`]+|["'`,;:)]+$/g, "");
  if (!s || /[\s*?$<>|{}]/.test(s) || s.startsWith("-") || /^[a-z]+:\/\//i.test(s)) return null;
  if (s.startsWith("~")) return null;
  if (!s.startsWith("/")) s = posix.join(cwd, s);
  s = posix.normalize(s);
  const root = workdir.replace(/\/$/, "");
  if (s === root) return null;
  if (!s.startsWith(`${root}/`)) return null;
  const rel = s.slice(root.length + 1);
  if (!rel || rel.startsWith(".git/") || p.trim().replace(/["'`]+$/, "").endsWith("/")) return null;
  return rel;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target_file", "notebook_path", "absolute_path"];

/** Every string under a path-like key, at any depth (edits arrays, nested tool_call wrappers). */
function pathArgs(v, out = []) {
  if (Array.isArray(v)) for (const x of v) pathArgs(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (PATH_KEYS.includes(k) && typeof x === "string") out.push(x);
      else if (typeof x === "object") pathArgs(x, out);
    }
  }
  return out;
}

/** Files named in patch text: apply_patch envelopes and unified diffs. */
export function patchFiles(text) {
  const out = [];
  if (typeof text !== "string") return out;
  for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+?)\s*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/gm)) if (m[1] !== "/dev/null") out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------- tool calls

export const parseArgs = (s) => {
  if (s && typeof s === "object") return s;
  try {
    const v = JSON.parse(s);
    // Some harnesses double-encode (a JSON string holding the JSON object).
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return { _raw: v };
      }
    }
    return v ?? {};
  } catch {
    return { _raw: String(s ?? "") };
  }
};

/** Unwrap generic dispatchers (openclaw `tool_call {id, args}`, hermes `tool_call {calls}`). */
function unwrap(name, args) {
  if (name === "tool_call" && args && typeof args === "object") {
    if (typeof args.id === "string" && args.args) return [[args.id, args.args]];
    if (Array.isArray(args.calls)) return args.calls.map((c) => [c.name ?? "", c.arguments ?? c.args ?? {}]);
    if (typeof args.name === "string") return [[args.name, args.arguments ?? args.args ?? {}]];
  }
  return [[name, args]];
}

const SHELL_TOOLS = /^(bash|shell|exec|terminal|run_command|run_shell_command|execute_command|run_terminal_cmd|command|sh|local_shell|container\.exec)$/i;
const EDIT_TOOLS = /(edit|patch|write|replace|create_file|insert|notebookedit)/i;
const NOT_EDIT = /(todo|memory|goal|plan|note)/i;
const READ_TOOLS = /^(read|read_file|file_read|view|view_file|open_file|cat|readfile|read_many_files)$/i;

export const isShellTool = (name) => SHELL_TOOLS.test(name);
export const shellCommand = (args) => {
  const c = args?.command ?? args?.cmd ?? args?.script ?? args?._raw;
  if (Array.isArray(c)) return c.join(" ");
  return typeof c === "string" ? c : null;
};

/**
 * The tool calls of a prefix in order, each paired with its result text.
 * @returns {{index: number, name: string, args: object, result: string|null}[]}
 */
export function toolRounds(messages) {
  const results = new Map();
  for (const m of messages) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content);
  const out = [];
  messages.forEach((m, index) => {
    if (m.role !== "assistant" || !m.tool_calls) return;
    for (const tc of m.tool_calls) {
      const result = tc.id && results.has(tc.id) ? results.get(tc.id) : null;
      for (const [name, args] of unwrap(tc.function.name, parseArgs(tc.function.arguments))) {
        out.push({ index, name, args: args && typeof args === "object" ? args : { _raw: String(args) }, result });
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------- shell parsing

/** Remove heredoc bodies, returning the command without them plus the bodies. */
export function splitHeredocs(cmd) {
  const bodies = [];
  const lines = cmd.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    kept.push(line);
    const marks = [...line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)].map((m) => m[2]);
    for (const mark of marks) {
      const body = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== mark) body.push(lines[(i += 1) - 1]);
      bodies.push(body.join("\n"));
    }
  }
  return { command: kept.join("\n"), bodies };
}

/** Split a command line into simple segments (&&, ||, ;, |, newlines), tokenized shell-ishly. */
export function segments(cmd) {
  const segs = [];
  let cur = [];
  let tok = "";
  let quote = null;
  let hadTok = false;
  let start = 0;
  let i = 0;
  const push = () => {
    if (hadTok) cur.push(tok);
    tok = "";
    hadTok = false;
  };
  const end = (sep) => {
    push();
    if (cur.length) segs.push({ tokens: cur, sep, raw: cmd.slice(start, i).trim() });
    cur = [];
    start = i + sep.length;
  };
  for (; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) tok += cmd[(i += 1)];
      else tok += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hadTok = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      tok += cmd[(i += 1)];
      hadTok = true;
    } else if (ch === "\n" || ch === ";") end(ch);
    else if (ch === "&" && cmd[i + 1] === "&") {
      end("&&");
      i += 1;
    } else if (ch === "|" && cmd[i + 1] === "|") {
      end("||");
      i += 1;
    } else if (ch === "|") end("|");
    else if (ch === ">" || ch === "<") {
      push();
      let op = ch;
      while (cmd[i + 1] === ">" || cmd[i + 1] === "&" || (cmd[i + 1] === "<" && ch === "<")) op += cmd[(i += 1)];
      cur.push(op);
    } else if (/\s/.test(ch)) push();
    else {
      tok += ch;
      hadTok = true;
    }
  }
  end("");
  return segs;
}

const looksLikePath = (t) => /[/.]/.test(t) && !/^\d+(,\d+)?p?$/.test(t) && !/^-/.test(t);

/** Files a shell command writes and reads (best effort), relative to the repo root. */
export function shellFiles(cmd, workdir) {
  const written = [];
  const read = [];
  const { command, bodies } = splitHeredocs(cmd);
  for (const b of bodies) {
    written.push(...patchFiles(b));
    for (const m of b.matchAll(/open\(\s*(?:r?['"])([^'"]+)['"]\s*,\s*['"][wa]/g)) written.push(m[1]);
    for (const m of b.matchAll(/Path\(\s*['"]([^'"]+)['"]\s*\)\.write_text/g)) written.push(m[1]);
  }
  // python -c "...open('x','w')..." one-liners
  for (const m of command.matchAll(/open\(\s*(?:r?['"])([^'"]+)['"]\s*,\s*['"][wa]/g)) written.push(m[1]);
  let cwd = workdir;
  const resolve = (p) => normPath(p, workdir, cwd);
  for (const { tokens } of segments(command)) {
    let t = tokens;
    // leading env assignments / wrappers
    while (t.length && (/^\w+=/.test(t[0]) || ["sudo", "time", "timeout", "env", "nohup"].includes(t[0]))) {
      t = t.slice(t[0] === "timeout" && t[1] && /^\d/.test(t[1]) ? 2 : 1);
    }
    if (!t.length) continue;
    const [cmd0, ...rest] = t;
    // redirections: > file, >> file (not 2>&1, not /dev/null)
    for (let i = 0; i < t.length - 1; i += 1) {
      if (/^\d?>>?$/.test(t[i]) && !t[i].startsWith("2")) written.push({ p: t[i + 1], cwd });
    }
    const args = rest.filter((x) => !/^[<>]/.test(x) && !/^\d?>/.test(x));
    // drop redirect targets from args
    const plain = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (/^\d?[<>]/.test(rest[i])) {
        i += 1;
        continue;
      }
      plain.push(rest[i]);
    }
    if (cmd0 === "cd" && args[0]) {
      cwd = args[0].startsWith("/") ? posix.normalize(args[0]) : posix.join(cwd, args[0]);
      continue;
    }
    if (cmd0 === "tee") for (const a of plain) if (!a.startsWith("-")) written.push({ p: a, cwd });
    if (cmd0 === "sed" || cmd0 === "perl") {
      const inPlace = plain.some((a) => /^-[^-]*i/.test(a) || a.startsWith("--in-place"));
      const files = plain.filter((a, i) => looksLikePath(a) && i > 0 && !/^s[/|#,]/.test(a) && !/^-/.test(a));
      // the script itself is the first non-flag arg for sed; keep only trailing path-like args
      const tail = files.filter((a) => !/[;{}]/.test(a));
      if (inPlace) for (const a of tail) written.push({ p: a, cwd });
      else if (cmd0 === "sed") for (const a of tail) read.push({ p: a, cwd });
    }
    if (["cat", "head", "tail", "nl", "less", "more", "bat", "batcat"].includes(cmd0)) {
      for (const a of plain) if (looksLikePath(a)) read.push({ p: a, cwd });
    }
    if ((cmd0 === "cp" || cmd0 === "mv" || cmd0 === "install") && plain.length >= 2) {
      const dst = plain.filter((a) => !a.startsWith("-")).pop();
      if (dst) written.push({ p: dst, cwd });
    }
    if (cmd0 === "touch") for (const a of plain) if (!a.startsWith("-")) written.push({ p: a, cwd });
  }
  const norm = (list) =>
    list
      .map((x) => (typeof x === "string" ? resolve(x) : normPath(x.p, workdir, x.cwd)))
      .filter(Boolean);
  return { written: norm(written), read: norm(read) };
}

// ---------------------------------------------------------------- files

/**
 * A JSON object at the start of a tool result (hermes wraps shell output as {"output", "exit_code"}
 * and may append a plain-text warning after it). Null when the result is not one.
 */
export function leadingJson(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  let end = text.length;
  for (let tries = 0; tries < 8 && end > 0; tries += 1) {
    const at = text.lastIndexOf("}", end - 1);
    if (at < 0) return null;
    try {
      return JSON.parse(text.slice(0, at + 1));
    } catch {
      end = at;
    }
  }
  return null;
}

const uniq = (xs) => [...new Set(xs)];

/** Files modified so far, from edit-type tools of every harness plus obvious shell writes. */
export function filesModified(rounds, workdir) {
  const out = [];
  for (const r of rounds) {
    const { name, args } = r;
    if (isShellTool(name)) {
      const cmd = shellCommand(args);
      if (cmd) out.push(...shellFiles(cmd, workdir).written);
      // A patch applied from a file names its files only in the output (patch, git apply -v,
      // or a git status the same command printed).
      if (cmd && /\b(git\s+apply|patch\s+-p|git\s+am)\b/.test(cmd)) out.push(...appliedFiles(r.result, workdir));
      continue;
    }
    if (!EDIT_TOOLS.test(name) || NOT_EDIT.test(name)) continue;
    // str_replace_editor style: command=view is a read
    if (args.command === "view") continue;
    const paths = pathArgs(args);
    for (const v of Object.values(args)) if (typeof v === "string") paths.push(...patchFiles(v));
    if (typeof args._raw === "string") paths.push(...patchFiles(args._raw));
    out.push(...paths.map((p) => normPath(p, workdir)).filter(Boolean));
  }
  return uniq(out);
}

/** Files named in the output of an applied patch. */
export function appliedFiles(result, workdir) {
  if (typeof result !== "string") return [];
  const j = leadingJson(result);
  const text = typeof j?.output === "string" ? j.output : result;
  const out = [];
  for (const m of text.matchAll(/^patching file [`'"]?([^\s`'"]+)/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^Applied patch (?:to )?[`'"]?([^\s`'"]+?)[`'"]? cleanly/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^ ?(?:M|A|AM|MM|\?\?) +(\S+)$/gm)) out.push(m[1]);
  return out.map((p) => normPath(p, workdir)).filter(Boolean);
}

/** Files read so far, from read-type tools and cat/sed -n/head/tail in a shell. */
export function filesRead(rounds, workdir) {
  const out = [];
  for (const r of rounds) {
    const { name, args } = r;
    if (isShellTool(name)) {
      const cmd = shellCommand(args);
      if (cmd) out.push(...shellFiles(cmd, workdir).read);
      continue;
    }
    if (READ_TOOLS.test(name) || (EDIT_TOOLS.test(name) && args.command === "view")) {
      out.push(...pathArgs(args).map((p) => normPath(p, workdir)).filter(Boolean));
    }
  }
  return uniq(out);
}

// ---------------------------------------------------------------- commands and failures

const WRAPPERS = new Set(["sudo", "time", "env", "nohup", "command", "exec", "xvfb-run", "stdbuf"]);

/** A segment's tokens without leading env assignments and wrappers (timeout N, sudo, ...). */
function bare(tokens) {
  let t = tokens;
  for (;;) {
    if (!t.length) return t;
    if (/^\w+=/.test(t[0]) || WRAPPERS.has(t[0]) || ["do", "then", "else", "elif", "!", "{", "("].includes(t[0])) t = t.slice(1);
    else if (t[0] === "timeout") t = t.slice(t[1] && /^\d/.test(t[1]) ? 2 : 1);
    else if (["uv", "poetry", "pipenv", "hatch", "rye", "pdm"].includes(t[0]) && t[1] === "run") t = t.slice(2);
    else return t;
  }
}

// Commands whose failure says nothing about the task: lookups, probes and network checks.
const INERT = new Set(["for", "while", "until", "if", "done", "fi", "}", ")", "grep", "rg", "ag", "find", "ls", "cat", "head", "tail", "nl", "wc", "echo", "printf", "pwd", "which", "whoami", "id", "tree", "file", "stat", "less", "awk", "diff", "cmp", "test", "[", "true", "false", "curl", "wget", "ping", "type", "command", "kill", "pkill", "sleep", "cd", "export", "source", ".", "sed"]);
const INERT_GIT = /^(log|diff|show|status|grep|blame|ls-remote|ls-files|ls-tree|remote|branch|fetch|rev-parse|stash|config|tag|describe|cat-file)$/;

const segInert = ({ tokens }) => {
  const t = bare(tokens);
  if (!t.length) return true;
  const c = t[0].split("/").pop();
  if (c === "git") return INERT_GIT.test(t.find((x, i) => i > 0 && !x.startsWith("-")) ?? "");
  if (c === "sed") return !t.some((a) => /^-[^-]*i/.test(a));
  return INERT.has(c);
};

/** True when the command's final segment (what sets the exit code) is a lookup. */
function lastSegmentInert(cmd) {
  const segs = segments(splitHeredocs(cmd).command).filter((s) => bare(s.tokens).length && !["done", "fi"].includes(bare(s.tokens)[0]));
  return segs.length ? segInert(segs[segs.length - 1]) : true;
}

/** True when no segment of the command does real work (only lookups and probes). */
function inertCommand(cmd) {
  const { command } = splitHeredocs(cmd);
  return segments(command).every(segInert);
}

// "exit code N" in the many spellings harnesses use.
const EXIT_RE = /(?:exit(?:ed with)?\s*(?:code|status)[:\s]*|Exit code\s+|returncode[=:\s]+|\[exit code:\s*)(-?\d+)/i;
const EXIT_LINE = /^\W*(Command failed \(exit code -?\d+\)|\(?Command exited with code -?\d+\)?|Process exited with code -?\d+\.?|Exit (code|status) -?\d+|\[exit code: -?\d+\])\W*$/i;

/** Does a tool result say the command failed? Returns the text to mine for the signature. */
export function failureOf(result) {
  if (typeof result !== "string" || !result) return null;
  let text = result;
  // hermes: {"output": ..., "exit_code": N, "error": ...}
  const j = leadingJson(result);
  if (j && typeof j === "object" && ("exit_code" in j || "output" in j)) {
    text = [j.output, j.error].filter((x) => typeof x === "string").join("\n");
    if (typeof j.exit_code === "number") return j.exit_code !== 0 && j.exit_code !== 141 ? text || result : null;
  }
  const exit = text.match(EXIT_RE);
  // 141 is SIGPIPE from `| head`: the command worked, the reader stopped early.
  if (exit) return Number(exit[1]) !== 0 && Number(exit[1]) !== 141 ? text : null;
  if (
    /Traceback \(most recent call last\)/.test(text) ||
    /^panic: /m.test(text) ||
    /^(FAILED|FAIL)\b/m.test(text) ||
    /^--- FAIL/m.test(text) ||
    /^=+ .*\b\d+ (failed|errors?)\b.* =+$/m.test(text) ||
    /\b\d+ (failed|failing)\b/.test(text) ||
    /error\[E\d+\]/.test(text) ||
    /\berror TS\d+/.test(text) ||
    /npm ERR!|ELIFECYCLE/.test(text) ||
    /^(\w+\.)*\w*(Error|Exception): /m.test(text) ||
    /^\S+:\d+:\d+: (error|expected|undefined|syntax error)/m.test(text) ||
    /^(error|fatal|Error):/m.test(text) ||
    /^Command failed/m.test(text)
  ) {
    return text;
  }
  return null;
}

/** The most informative single line of a failure's output (null when there is only an exit code). */
export function errorSignature(text) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const rank = (l) => {
    const s = l.trim();
    if (!s || s.length > 400 || EXIT_LINE.test(s)) return 0;
    if (/^(\w+\.)*\w*(Error|Exception)(: |$)/.test(s) && !/^\s/.test(l)) return 9; // python final exception
    if (/^panic: /.test(s)) return 9;
    if (/error\[E\d+\]/.test(s) || /\berror TS\d+/.test(s)) return 8;
    if (/^E\s{2,}\S/.test(s)) return 8; // pytest assertion detail
    if (/^\S+:\d+(:\d+)?: \S/.test(s)) return 7; // compiler / go test file:line: msg
    if (/^FAILED \S+/.test(s)) return 6;
    if (/^--- FAIL/.test(s)) return 5;
    if (/AssertionError|assert /.test(s)) return 5;
    if (/^(error|fatal|Error):/.test(s)) return 4;
    if (/\b\d+ (failed|failing)\b/.test(s)) return 3;
    if (/Error|FAIL|failed/.test(s)) return 2;
    return 0;
  };
  let best = null;
  let bestRank = 0;
  for (const l of lines) {
    const r = rank(l);
    if (r > bestRank) {
      best = l.trim();
      bestRank = r;
    }
  }
  return best;
}

/** The most recent shell command (not a mere lookup) whose result indicates failure. */
export function lastFailingCommand(rounds) {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const r = rounds[i];
    if (!isShellTool(r.name)) continue;
    const cmd = shellCommand(r.args);
    if (!cmd || inertCommand(cmd)) continue;
    const fail = failureOf(r.result);
    if (!fail) continue;
    const signature = errorSignature(fail);
    // `... | grep x` exiting 1 only means no match: without an error line it is not a failure.
    if (!signature && lastSegmentInert(cmd)) continue;
    return { command: cmd.trim(), error_signature: signature, message_index: r.index };
  }
  return null;
}

const RUNNERS = new Set(["pytest", "py.test", "tox", "nox", "vitest", "jest", "mocha", "rspec", "phpunit", "ctest", "nosetests", "trial", "ava", "tap", "karma", "playwright"]);

/** Does this segment's command run a test runner? */
export function isTestInvocation(tokens) {
  const t = bare(tokens);
  if (!t.length) return false;
  const c = t[0].split("/").pop();
  const a = t.slice(1).filter((x) => !x.startsWith("-") || x === "--test");
  if (RUNNERS.has(c)) return true;
  if (/^python[\d.]*$/.test(c) || c === "pypy3") {
    const m = t.indexOf("-m");
    if (m > 0 && ["pytest", "unittest", "nose", "nose2", "tox", "trial"].includes(t[m + 1])) return true;
    const script = t.slice(1).find((x) => !x.startsWith("-"));
    if (script && /(^|\/)(runtests\.py|bin\/test|manage\.py)$/.test(script)) return script.endsWith("manage.py") ? t.includes("test") : true;
    return false;
  }
  if (/runtests(\.py)?$/.test(c) || t[0].endsWith("bin/test")) return true;
  if (c === "go" || c === "deno" || c === "dotnet" || c === "bun") return a[0] === "test";
  if (c === "cargo") return a[0] === "test" || a[0] === "nextest";
  if (c === "make") return a.some((x) => /^(test|check|tests)\b/.test(x));
  if (["npm", "pnpm", "yarn"].includes(c)) {
    if (a[0] === "test" || a[0] === "t") return true;
    if ((a[0] === "run" || a[0] === "exec") && a[1] && (/test/.test(a[1]) || RUNNERS.has(a[1]))) return true;
    return RUNNERS.has(a[0]);
  }
  if (["npx", "pnpx", "bunx"].includes(c)) return RUNNERS.has(a[0]);
  if (c === "node") return t.includes("--test");
  if (/^gradlew?$/.test(c) || c === "mvn") return a.includes("test");
  return false;
}

/** The test-running segment of a command (no cd prefix, output plumbing or heredoc bodies). */
export function testCore(cmd) {
  const { command } = splitHeredocs(cmd);
  const seg = segments(command).find((s) => isTestInvocation(s.tokens));
  if (!seg) return null;
  // Drop the wrapper tokens (env assignments, timeout N, uv run...) from the raw text.
  let raw = seg.raw;
  const skipped = seg.tokens.length - bare(seg.tokens).length;
  let cursor = 0;
  for (const tok of seg.tokens.slice(0, skipped)) {
    const at = raw.indexOf(tok, cursor);
    if (at < 0) break;
    cursor = at + tok.length;
  }
  raw = raw.slice(cursor).trim();
  return raw.replace(/\s*\d?>&\d/g, "").replace(/\s*2>\s*\/dev\/null/g, "").replace(/^\s*timeout\s+\d+[smh]?\s+/, "").trim();
}

/** The most recent shell command that runs a test runner. */
export function testCommand(rounds) {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const r = rounds[i];
    if (!isShellTool(r.name)) continue;
    const cmd = shellCommand(r.args);
    const core = cmd ? testCore(cmd) : null;
    if (core) return { command: cmd.trim(), core, message_index: r.index };
  }
  return null;
}

// ---------------------------------------------------------------- task identifiers

// Some adapters send the prompt as a JSON-quoted string, so its quotes arrive as \".
const unescapeQuoted = (t) => (/\\"/.test(t) ? t.replace(/\\"/g, '"') : t);

const balanced = (s) => {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (const ch of s) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return false;
    }
  }
  return stack.length === 0;
};

/** The task statement: the <task>/<issue> block of the first user message that has one. */
export function taskText(messages) {
  const users = messages.filter((m) => m.role === "user");
  for (const m of users) {
    const hit = m.content.match(/<(task|issue)>([\s\S]*?)<\/\1>/);
    if (hit) return unescapeQuoted(hit[2]);
  }
  return unescapeQuoted(users[0]?.content ?? "");
}

const STOP = new Set(["True", "False", "None", "null", "true", "false", "undefined", "self", "this", "e.g", "i.e", "etc", "and", "or", "not", "the", "a", "an", "to", "of", "in", "is"]);
const IDENT = /^[A-Za-z_$][\w$]*(?:[.:]{1,2}[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const isSpecific = (t) => /[_.$:]/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t) || /\(\)$/.test(t);

/**
 * Identifier-like tokens the task requires: backtick spans, identifiers next to field/option/flag
 * words, CLI flags and quoted literals. Fenced code blocks are skipped (reproduction scripts).
 */
export function taskIdentifiers(task, cap = 40) {
  const text = task.replace(/```[\s\S]*?```/g, " ");
  const out = [];
  const add = (t) => {
    const s = t.trim().replace(/\(\)$/, "");
    if (s.length < 2 || s.length > 80 || STOP.has(s)) return;
    if (!/[A-Za-z]/.test(s) || !balanced(s)) return; // operators and fragments like `, COUNT(`
    if (!out.includes(s)) out.push(s);
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    if (IDENT.test(span)) {
      add(span);
      continue;
    }
    // quoted literal inside backticks: `'linear'`, `"Quantile must be ..."`
    const lit = span.match(/^(['"])(.+)\1$/);
    if (lit) {
      add(lit[2]);
      continue;
    }
    // flags inside spans
    for (const f of span.matchAll(/(?<![\w-])--?[A-Za-z][\w-]*/g)) if (f[0].startsWith("--")) add(f[0]);
    // a call signature or expression: its callable name, keyword-argument names and literals
    const head = span.match(/^([A-Za-z_$][\w$.]*)\s*\(/);
    if (head) add(head[1]);
    for (const k of span.matchAll(/([A-Za-z_$][\w$]*)\s*[=:](?!=)/g)) if (isSpecific(k[1]) || head) add(k[1]);
    for (const q of span.matchAll(/(['"])([^'"]{1,60})\1/g)) add(q[2]);
    for (const w of span.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) if (isSpecific(w[0])) add(w[0]);
    if (!head && span.length <= 40) add(span);
  }
  const prose = text.replace(/`[^`\n]+`/g, " ");
  for (const m of prose.matchAll(/(?<![\w-])--[A-Za-z][\w-]+/g)) add(m[0]);
  for (const m of prose.matchAll(/\b(?:field|option|flag|key|parameter|param|argument|setting|config|property|attribute|column|variable)s?\s+["']?([A-Za-z_][\w.-]*)/gi)) {
    const w = m[1].replace(/[.-]+$/, "");
    if (isSpecific(w)) add(w);
  }
  for (const m of prose.matchAll(/\b([A-Za-z_][\w.]*)\s+(?:field|option|flag|key|parameter|argument|setting|property|attribute|column)\b/gi)) {
    const w = m[1].replace(/[.-]+$/, "");
    if (isSpecific(w)) add(w);
  }
  for (const m of prose.matchAll(/"([^"\n]{3,60})"/g)) add(m[1]);
  return out.slice(0, cap);
}

// ---------------------------------------------------------------- next action and stats

const PRIMARY_KEYS = ["command", "cmd", "pattern", "query", "queries", "url", "urls", "file_path", "filePath", "path", "code", "input", "patch", "content", "prompt"];

/** The primary argument of a tool call: the command, the path, the query... */
export function primaryArg(args) {
  if (!args || typeof args !== "object") return String(args ?? "");
  for (const k of PRIMARY_KEYS) {
    const v = args[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  const nested = pathArgs(args)[0];
  if (nested) return nested;
  const first = Object.values(args).find((v) => typeof v === "string");
  return first ?? "";
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
const compactArgs = (args) =>
  Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, typeof v === "string" ? clip(v, 300) : clip(JSON.stringify(v), 300)]));

/** The next assistant action after the cut: its first tool call, or its text. */
export function nextAction(msg) {
  if (!msg) return null;
  if (msg.tool_calls?.length) {
    const tc = msg.tool_calls[0];
    const [[name, args]] = unwrap(tc.function.name, parseArgs(tc.function.arguments));
    return {
      tool: name,
      args: compactArgs(args),
      primary_arg: clip(primaryArg(args), 500),
      parallel: msg.tool_calls.length,
      text: clip(msg.content, 300) || null,
    };
  }
  return { tool: null, text: clip(msg.content, 300) };
}

const msgChars = (m) => (m.content?.length ?? 0) + (m.tool_calls ?? []).reduce((a, tc) => a + tc.function.name.length + tc.function.arguments.length, 0);

export function stats(messages, tools = []) {
  const chars = messages.reduce((a, m) => a + msgChars(m), 0);
  const toolChars = JSON.stringify(tools).length;
  return {
    messages: messages.length,
    chars,
    est_tokens: Math.round(chars / 4),
    tool_schema_chars: toolChars,
    tool_rounds: messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length,
  };
}

/** All ground truth of one checkpoint prefix plus the message after it. */
export function groundTruth(prefix, next, tools = []) {
  const workdir = detectWorkdir(prefix);
  const rounds = toolRounds(prefix);
  return {
    workdir,
    task_identifiers: taskIdentifiers(taskText(prefix)),
    files_modified: filesModified(rounds, workdir),
    files_read: filesRead(rounds, workdir),
    last_failing_command: lastFailingCommand(rounds),
    test_command: testCommand(rounds),
    next_action: nextAction(next),
    stats: stats(prefix, tools),
  };
}
