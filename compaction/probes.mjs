// probes.mjs — probe questions for a checkpoint and their deterministic scorers.
//
// A probe is asked after the (compacted) context as a new user turn. Every question is answerable
// from a faithful compaction of the prefix. Scorers:
//   set_f1       F1 between the expected set and the paths/items listed in the answer
//   contains_all fraction of expected items that appear in the answer (recall)
//   exact_line   1 when the expected line appears in the answer, else partial token recall
//   tool_match   cheap next-action baseline: tool family + primary-argument similarity
// Next-action agreement proper is a judge task; tool_match is only its floor.

import path from "node:path";

const posix = path.posix;

/**
 * Probes for one checkpoint's truth (see truth.mjs groundTruth).
 * @returns {{id: string, kind: string, question: string, scorer: string, expected: any}[]}
 */
export function probesFor(truth, checkpointId = "") {
  const p = [];
  const add = (kind, question, scorer, expected, extra = {}) => p.push({ id: `${checkpointId}#${kind}`, kind, question, scorer, expected, ...extra });
  if (truth.files_modified?.length) {
    add("files_modified", "List every file you have modified or created in the repository so far, one path per line (relative to the repository root). List nothing else.", "set_f1", truth.files_modified, { workdir: truth.workdir });
  }
  if (truth.files_read?.length) {
    add("files_read", "List every repository file whose contents you have read so far, one path per line (relative to the repository root). List nothing else.", "contains_all", truth.files_read, { mode: "paths", workdir: truth.workdir });
  }
  if (truth.test_command) {
    add("test_command", "What exact command were you using to run the tests? Reply with the command only.", "contains_all", commandTokens(truth.test_command.core), { mode: "tokens" });
  }
  if (truth.last_failing_command) {
    add("last_failing_command", "What was the most recent command you ran that failed? Reply with the exact command only.", "contains_all", commandTokens(truth.last_failing_command.command), { mode: "tokens" });
    if (truth.last_failing_command.error_signature) {
      add("error_signature", "What was the last error you saw? Quote the key error line exactly.", "exact_line", truth.last_failing_command.error_signature);
    }
  }
  if (truth.task_identifiers?.length) {
    add("task_identifiers", "List the exact identifiers the task requires (function, method, field, option and flag names, and literal values or messages), one per line, spelled exactly as in the task.", "contains_all", truth.task_identifiers, { mode: "exact" });
  }
  if (truth.next_action?.tool) {
    add("next_action", "What is the very next action you will take? Reply with the tool you will call and its main argument (the command, file path or query), nothing else.", "tool_match", { tool: truth.next_action.tool, primary_arg: truth.next_action.primary_arg }, { workdir: truth.workdir });
  }
  return p;
}

// ---------------------------------------------------------------- normalization

/** Collapse whitespace, drop markdown emphasis and code fences. */
export function normText(s) {
  return String(s ?? "")
    .replace(/```[\w-]*\n?/g, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A path as compared by the scorers: repo-relative, no ./, no a/ b/ diff prefixes. */
export function normProbePath(p, workdir = "/app") {
  let s = String(p ?? "").trim();
  s = s.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
  s = s.replace(/^["'`(\[]+|["'`)\],;:.]+$/g, "");
  s = s.split(/\s+(?:[-—–(:]|\()/)[0].trim(); // "path — note"
  if (!s || /\s/.test(s)) return null;
  for (const root of [workdir, "/app", "/testbed", "/workspace", "/repo"]) {
    if (root && s.startsWith(`${root.replace(/\/$/, "")}/`)) s = s.slice(root.replace(/\/$/, "").length + 1);
  }
  s = s.replace(/^\.\//, "").replace(/^[ab]\/(?=\S+\/)/, "");
  if (!/[\w]/.test(s)) return null;
  return posix.normalize(s);
}

/** Path-looking items in an answer (one per line, or comma separated). */
export function answerPaths(answer, workdir, bare = []) {
  const items = String(answer ?? "")
    .replace(/`/g, "")
    .split(/[\n,]+/)
    .map((l) => normProbePath(l, workdir))
    .filter((x) => x && (/[/.]/.test(x) || bare.includes(x)));
  return [...new Set(items)];
}

/** Expected paths without a directory or extension (Makefile, ChangeLog) that answers may list bare. */
const bareNames = (expected) => expected.filter((p) => typeof p === "string" && !/[/.]/.test(p));

/** A path from the answer matches an expected one exactly, or as a path suffix with a directory. */
const pathMatch = (got, want) => got === want || (got.includes("/") && want.endsWith(`/${got}`)) || (want.includes("/") && got.endsWith(`/${want}`));

/** Meaningful tokens of a shell command (no cd prefix, pipes to tail/head, redirections). */
export function commandTokens(cmd) {
  const s = String(cmd ?? "")
    .split("\n")[0]
    .replace(/^\s*(cd\s+\S+\s*(&&|;)\s*)+/, "")
    .replace(/\s*\|\s*(tail|head|grep|tee)\b.*$/, "")
    .replace(/\d?>&\d|2>\/dev\/null/g, "");
  const toks = s.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => t && !["&&", "||", ";", "|"].includes(t));
  return [...new Set(toks)].slice(0, 12);
}

const tokens = (s) =>
  normText(s)
    .toLowerCase()
    .split(/[^\w./-]+/)
    .map((t) => t.replace(/^[./-]+(?=\w)|[./-]+$/g, ""))
    .filter((t) => t.length > 1);

// ---------------------------------------------------------------- scorers

function setF1(expected, answer, workdir) {
  const want = expected.map((p) => normProbePath(p, workdir)).filter(Boolean);
  const got = answerPaths(answer, workdir, bareNames(want));
  if (!want.length) return { score: got.length ? 0 : 1, detail: { expected: 0, got: got.length } };
  const hit = want.filter((w) => got.some((g) => pathMatch(g, w)));
  const correct = got.filter((g) => want.some((w) => pathMatch(g, w)));
  const recall = hit.length / want.length;
  const precision = got.length ? correct.length / got.length : 0;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return { score: f1, detail: { recall, precision, missing: want.filter((w) => !hit.includes(w)), extra: got.filter((g) => !correct.includes(g)) } };
}

function containsAll(expected, answer, mode, workdir) {
  const items = Array.isArray(expected) ? expected : [expected];
  if (!items.length) return { score: 1, detail: {} };
  let found;
  if (mode === "paths") {
    const got = answerPaths(answer, workdir, bareNames(items));
    found = items.filter((w) => got.some((g) => pathMatch(g, normProbePath(w, workdir) ?? w)));
  } else if (mode === "tokens") {
    const hay = normText(answer).toLowerCase();
    found = items.filter((t) => hay.includes(normText(t).toLowerCase()));
  } else {
    // exact identifiers: case-sensitive, whole-token where the item is a word
    const hay = normText(answer);
    found = items.filter((t) => {
      const n = normText(t);
      if (/^[\w$.:-]+$/.test(n)) return new RegExp(`(^|[^\\w$])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w$])`).test(hay);
      return hay.includes(n);
    });
  }
  return { score: found.length / items.length, detail: { found: found.length, of: items.length, missing: items.filter((x) => !found.includes(x)) } };
}

function exactLine(expected, answer) {
  const want = normText(expected).replace(/^["']|["']$/g, "");
  const hay = normText(answer);
  if (!want) return { score: 1, detail: {} };
  if (hay.includes(want)) return { score: 1, detail: { match: "exact" } };
  if (hay.toLowerCase().includes(want.toLowerCase())) return { score: 0.95, detail: { match: "case" } };
  const wt = tokens(want);
  const ht = new Set(tokens(hay));
  const recall = wt.length ? wt.filter((t) => ht.has(t)).length / wt.length : 0;
  return { score: Math.round(0.9 * recall * 1000) / 1000, detail: { match: "tokens", recall } };
}

// Tool vocabularies collapse to families so harnesses with different tool names compare.
const FAMILIES = [
  ["shell", /^(bash|shell|exec|terminal|run_command|run_shell_command|execute_command|command|sh|local_shell)$/i],
  ["edit", /(edit|patch|replace|str_replace|multiedit)/i],
  ["write", /(write|create_file)/i],
  ["read", /^(read|read_file|file_read|view|view_file|open_file|cat)$/i],
  ["search", /(grep|glob|search_files|find|rg|search$|list_files|ls)/i],
  ["web", /(web|fetch|browse|http)/i],
  ["todo", /(todo|plan|goal)/i],
  ["agent", /(agent|task|delegate|subagent)/i],
];
export const toolFamily = (name) => FAMILIES.find(([, re]) => re.test(name ?? ""))?.[0] ?? String(name ?? "").toLowerCase();

const FAMILY_WORDS = {
  shell: /\b(bash|shell|run|execute|exec|terminal|command)\b/i,
  edit: /\b(edit|patch|replace|modify|change|update)\b/i,
  write: /\b(write|create)\b/i,
  read: /\b(read|view|open|look at|inspect|cat)\b/i,
  search: /\b(grep|search|glob|find|look for|list)\b/i,
  web: /\b(fetch|web|search the web|browse)\b/i,
  todo: /\b(todo|plan)\b/i,
  agent: /\b(agent|delegate|sub-?agent)\b/i,
};

function toolMatch(expected, answer, workdir) {
  const fam = toolFamily(expected.tool);
  const text = String(answer ?? "");
  const named = new RegExp(`\\b${String(expected.tool).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  const famHit = named || FAMILY_WORDS[fam]?.test(text) || false;
  const arg = String(expected.primary_arg ?? "");
  let argScore = 0;
  const asPath = normProbePath(arg, workdir);
  if (asPath && /[/.]/.test(arg) && !/\s/.test(arg.trim())) {
    argScore = answerPaths(text.replace(/\s+/g, "\n"), workdir).some((g) => pathMatch(g, asPath)) ? 1 : 0;
  } else if (arg) {
    const want = new Set(tokens(commandTokens(arg).join(" ")));
    const got = new Set(tokens(text));
    const inter = [...want].filter((t) => got.has(t)).length;
    argScore = want.size ? inter / want.size : 0;
  } else argScore = famHit ? 1 : 0;
  const score = 0.4 * (famHit ? 1 : 0) + 0.6 * argScore;
  return { score: Math.round(score * 1000) / 1000, detail: { family: fam, tool_hit: famHit, arg_score: argScore } };
}

/** Score one answer against its probe. */
export function score(probe, answerText) {
  switch (probe.scorer) {
    case "set_f1":
      return setF1(probe.expected, answerText, probe.workdir);
    case "contains_all":
      return containsAll(probe.expected, answerText, probe.mode ?? "exact", probe.workdir);
    case "exact_line":
      return exactLine(probe.expected, answerText);
    case "tool_match":
      return toolMatch(probe.expected, answerText, probe.workdir);
    default:
      throw new Error(`unknown scorer ${probe.scorer}`);
  }
}
