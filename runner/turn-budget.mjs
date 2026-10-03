// turn-budget.mjs — the time OpenHuman's own turn ceiling should allow: the task's budget minus a
// safety margin, so the turn ends itself (and the run records a stop reason) before the task's
// wall-clock kill. OpenHuman's default ceiling is 60 min, which cuts long tasks short; 0 turns it off.

/**
 * @param env process env: OPENHUMAN_AGENT_TURN_TIMEOUT_SECS (explicit, wins, "0" = none),
 *            BENCH_TURN_BUDGET_S (the task's agent budget, else TASK_TIMEOUT_S), BENCH_TURN_MARGIN_S (default 120)
 * @returns {string|null} seconds as a string, or null to leave OpenHuman's default alone
 */
export function turnTimeoutSecs(env = process.env) {
  const explicit = env.OPENHUMAN_AGENT_TURN_TIMEOUT_SECS;
  if (explicit !== undefined && explicit !== "") return explicit;
  const budget = Number(env.BENCH_TURN_BUDGET_S || env.TASK_TIMEOUT_S);
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const margin = env.BENCH_TURN_MARGIN_S === undefined || env.BENCH_TURN_MARGIN_S === "" ? 120 : Number(env.BENCH_TURN_MARGIN_S);
  // A budget barely over the margin keeps at least half of itself.
  return String(Math.floor(Math.max(budget - margin, budget / 2)));
}
