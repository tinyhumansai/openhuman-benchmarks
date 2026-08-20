#!/usr/bin/env node
/**
 * Leak / drift analysis for the agent-scale benchmark tier.
 *
 * Consumes the sampler's JSONL series plus the driver's summary and turn log,
 * and produces a verdict per resource. Kept separate from the load run so a
 * recorded run can be re-analyzed with different thresholds without paying for
 * the load again.
 *
 * WHAT A VERDICT HERE DOES AND DOES NOT MEAN
 *
 * A rising RSS line is not proof of a leak, and a flat one is not proof of its
 * absence. Allocators return memory to the OS lazily, arenas grow to a working
 * set and stop, and caches are supposed to fill. So the RSS check does not rest
 * on slope alone — it requires BOTH a positive slope AND a final window that
 * sits meaningfully above the earlier one, i.e. growth that never plateaued.
 * A run that grows and then levels off reports `plateau`, which is the healthy
 * shape for a process with caches.
 *
 * Thread and file-descriptor counts are held to a much stricter standard,
 * because unlike memory they have no legitimate reason to climb without bound
 * under steady load. A monotonic rise in either is a leak with far less room
 * for interpretation, which is why they are checked independently rather than
 * folded into a single score.
 *
 * In `per-worker` and `shared` thread modes conversation history genuinely
 * accumulates, so RSS growth is EXPECTED. The analyzer will not call a leak in
 * those modes; it reports the growth rate and says the mode cannot distinguish
 * a leak from intended retention. Use `fresh` for a leak verdict.
 *
 * Usage:
 *   node scripts/bench/analyze.mjs --samples samples.jsonl --driver summary.json \
 *     [--out report.json] [--rss-kib-per-turn 8] [--warmup-frac 0.25]
 */

import fs from 'node:fs';

function parseArgs(argv) {
  const opts = {
    samples: null,
    driver: null,
    out: null,
    // Growth budget per turn before RSS growth is called a leak. Default is
    // deliberately loose; tighten it per scenario once a baseline exists.
    rssKibPerTurn: 8,
    // Fraction of the series treated as warm-up and excluded. First-touch
    // initialization dominates early samples and would fake a steep slope.
    warmupFrac: 0.25,
    // Final-vs-early window growth, as a fraction, that counts as "never
    // plateaued" when the slope is also positive.
    plateauTolerance: 0.05,
    // Threads/FDs may drift a little with pool churn; require real growth.
    maxThreadGrowth: 8,
    maxFdGrowth: 32,
  };
  const spec = {
    '--samples': ['samples', String],
    '--driver': ['driver', String],
    '--out': ['out', String],
    '--rss-kib-per-turn': ['rssKibPerTurn', Number],
    '--warmup-frac': ['warmupFrac', Number],
    '--plateau-tolerance': ['plateauTolerance', Number],
    '--max-thread-growth': ['maxThreadGrowth', Number],
    '--max-fd-growth': ['maxFdGrowth', Number],
  };
  for (let i = 2; i < argv.length; i += 1) {
    const entry = spec[argv[i]];
    if (!entry) throw new Error(`unknown argument: ${argv[i]}`);
    const [key, cast] = entry;
    const raw = argv[++i];
    const value = cast(raw);
    if (cast === Number && !Number.isFinite(value)) {
      throw new Error(`${argv[i - 1]} expects a number, got: ${raw}`);
    }
    opts[key] = value;
  }
  if (!opts.samples) throw new Error('--samples <file.jsonl> is required');
  if (opts.warmupFrac < 0 || opts.warmupFrac >= 1) {
    throw new Error('--warmup-frac must be in [0, 1)');
  }
  return opts;
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Ordinary least squares. Returns slope in units of y per unit of x. */
function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: null, intercept: null, r2: null };
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  if (sxx === 0) return { slope: null, intercept: null, r2: null };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? null : 1 - ssRes / ssTot };
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function windowMeans(values) {
  if (values.length < 4) return { early: null, late: null };
  const q = Math.max(1, Math.floor(values.length / 4));
  return { early: mean(values.slice(0, q)), late: mean(values.slice(-q)) };
}

const opts = parseArgs(process.argv);
const allSamples = readJsonl(opts.samples);
if (allSamples.length === 0) {
  process.stderr.write('[analyze] sample series is empty\n');
  process.exit(1);
}
const driver = opts.driver ? JSON.parse(fs.readFileSync(opts.driver, 'utf8')) : null;

// Drop the warm-up head of the series.
const skip = Math.floor(allSamples.length * opts.warmupFrac);
const samples = allSamples.slice(skip);
if (samples.length < 4) {
  process.stderr.write(
    `[analyze] only ${samples.length} samples after dropping ${skip} warm-up ` +
      `samples — run longer or lower --warmup-frac\n`,
  );
  process.exit(1);
}

const durationMs = samples[samples.length - 1].tMs - samples[0].tMs;
const durationMin = durationMs / 60_000;

const threadMode = driver?.config?.threadMode ?? 'unknown';
// Turn count inside the analyzed window, used to express growth per turn. The
// driver's total covers the whole measured run; scaling it by the analyzed
// fraction is an approximation, and is labeled as such in the report.
const turnsTotal = driver?.turnsOk ?? null;
const analyzedFrac = allSamples.length > 0 ? samples.length / allSamples.length : 1;
const turnsInWindow = turnsTotal !== null ? turnsTotal * analyzedFrac : null;

function seriesFor(field) {
  const xs = [];
  const ys = [];
  for (const s of samples) {
    if (typeof s[field] === 'number' && Number.isFinite(s[field])) {
      xs.push(s.tMs);
      ys.push(s[field]);
    }
  }
  return { xs, ys };
}

function analyzeMemory(field, label) {
  const { xs, ys } = seriesFor(field);
  if (ys.length < 4) return { field, label, available: false };

  const fit = linearFit(xs, ys);
  const kibPerMin = fit.slope === null ? null : fit.slope * 60_000;
  const kibPerTurn =
    kibPerMin !== null && turnsInWindow && turnsInWindow > 0 && durationMin > 0
      ? (kibPerMin * durationMin) / turnsInWindow
      : null;

  const { early, late } = windowMeans(ys);
  const relativeGrowth = early && early > 0 ? (late - early) / early : null;
  const plateaued =
    relativeGrowth !== null && relativeGrowth <= opts.plateauTolerance;

  let verdict;
  let reason;
  if (threadMode === 'per-worker' || threadMode === 'shared') {
    verdict = 'not-assessed';
    reason =
      `thread-mode=${threadMode} accumulates conversation history by design, so ` +
      `growth here cannot be distinguished from a leak. Re-run with ` +
      `--thread-mode fresh for a verdict.`;
  } else if (fit.slope === null || fit.slope <= 0) {
    verdict = 'pass';
    reason = 'no positive growth trend in the steady-state window.';
  } else if (plateaued) {
    verdict = 'plateau';
    reason =
      `grew then leveled off (final window ${(relativeGrowth * 100).toFixed(2)}% ` +
      `above the early window, within the ${(opts.plateauTolerance * 100).toFixed(0)}% ` +
      `plateau tolerance). Consistent with caches reaching a working set.`;
  } else if (kibPerTurn !== null && kibPerTurn > opts.rssKibPerTurn) {
    verdict = 'fail';
    reason =
      `grew ${kibPerTurn.toFixed(2)} KiB/turn without plateauing, over the ` +
      `${opts.rssKibPerTurn} KiB/turn budget.`;
  } else {
    verdict = 'pass';
    reason =
      kibPerTurn !== null
        ? `growth ${kibPerTurn.toFixed(2)} KiB/turn is within the ` +
          `${opts.rssKibPerTurn} KiB/turn budget.`
        : 'positive slope but no turn count available to normalize against.';
  }

  return {
    field,
    label,
    available: true,
    verdict,
    reason,
    firstKib: ys[0],
    lastKib: ys[ys.length - 1],
    minKib: Math.min(...ys),
    maxKib: Math.max(...ys),
    earlyWindowMeanKib: early,
    lateWindowMeanKib: late,
    relativeGrowth,
    kibPerMin,
    kibPerTurn,
    r2: fit.r2,
  };
}

function analyzeCounter(field, label, maxGrowth) {
  const { ys } = seriesFor(field);
  if (ys.length < 4) return { field, label, available: false };
  const first = ys[0];
  const last = ys[ys.length - 1];
  const max = Math.max(...ys);
  const { early, late } = windowMeans(ys);
  const growth = late - early;
  // Threads and FDs have no legitimate reason to climb without bound under
  // steady load, so this is a straight threshold rather than a trend test.
  const verdict = growth > maxGrowth ? 'fail' : 'pass';
  return {
    field,
    label,
    available: true,
    verdict,
    reason:
      verdict === 'fail'
        ? `grew by ${growth.toFixed(1)} between the early and final windows, ` +
          `over the budget of ${maxGrowth}.`
        : `stable (growth ${growth.toFixed(1)}, budget ${maxGrowth}).`,
    first,
    last,
    max,
    earlyWindowMean: early,
    lateWindowMean: late,
    growth,
  };
}

/**
 * CPU drift: does a turn cost more CPU at the end of the run than at the start?
 *
 * CPU counters are cumulative, so the meaningful quantity is the DERIVATIVE —
 * CPU ms consumed per wall ms — compared between the early and final windows.
 * A rising figure under constant offered load means per-turn work is growing,
 * which is the CPU analogue of a memory leak (an unbounded list being rescanned
 * every turn, say).
 */
function analyzeCpu() {
  const usable = samples.filter(
    (s) => typeof s.cpuUserMs === 'number' && typeof s.cpuSystemMs === 'number',
  );
  if (usable.length < 8) return { available: false };

  const totals = usable.map((s) => s.cpuUserMs + s.cpuSystemMs);
  const times = usable.map((s) => s.tMs);

  const rates = [];
  for (let i = 1; i < usable.length; i += 1) {
    const dt = times[i] - times[i - 1];
    if (dt <= 0) continue;
    rates.push({ tMs: times[i], rate: (totals[i] - totals[i - 1]) / dt });
  }
  if (rates.length < 4) return { available: false };

  const rateValues = rates.map((r) => r.rate);
  const { early, late } = windowMeans(rateValues);
  const drift = early && early > 0 ? (late - early) / early : null;

  const totalCpuMs = totals[totals.length - 1] - totals[0];
  const cpuMsPerTurn =
    turnsInWindow && turnsInWindow > 0 ? totalCpuMs / turnsInWindow : null;

  // 25% more CPU per unit time for the same offered load is a real drift, not
  // scheduling noise.
  const verdict = drift !== null && drift > 0.25 ? 'fail' : 'pass';
  return {
    available: true,
    verdict,
    reason:
      verdict === 'fail'
        ? `CPU rate rose ${(drift * 100).toFixed(1)}% from the early to the final ` +
          `window under constant offered load — per-turn work is growing.`
        : drift === null
          ? 'no early-window baseline to compare against.'
          : `CPU rate change ${(drift * 100).toFixed(1)}% is within noise.`,
    totalCpuMs,
    cpuMsPerTurn,
    earlyRateCpuMsPerMs: early,
    lateRateCpuMsPerMs: late,
    drift,
    meanUtilizationCores: durationMs > 0 ? totalCpuMs / durationMs : null,
  };
}

const memory = [
  analyzeMemory('rssKib', 'RSS'),
  analyzeMemory('pssKib', 'PSS'),
  analyzeMemory('privateKib', 'Private (clean+dirty)'),
];
if (samples.some((s) => typeof s.treeRssKib === 'number')) {
  memory.push(analyzeMemory('treeRssKib', 'RSS incl. descendants'));
}

const threads = analyzeCounter('threads', 'Threads', opts.maxThreadGrowth);
const fds = analyzeCounter('openFds', 'Open FDs', opts.maxFdGrowth);
const cpu = analyzeCpu();

const checks = [...memory.filter((m) => m.available), threads, fds, cpu].filter(
  (c) => c.available !== false,
);
const failed = checks.filter((c) => c.verdict === 'fail');
// PSS and Private track RSS closely; the headline verdict keys off RSS, with
// the others reported for corroboration.
const overall = failed.length > 0 ? 'fail' : 'pass';

const report = {
  overall,
  threadMode,
  window: {
    totalSamples: allSamples.length,
    warmupSamplesDropped: skip,
    analyzedSamples: samples.length,
    durationMs,
    turnsTotal,
    turnsInWindowApprox: turnsInWindow,
  },
  driverSummary: driver
    ? {
        turnsOk: driver.turnsOk,
        turnsFailed: driver.turnsFailed,
        throughputTurnsPerSec: driver.throughputTurnsPerSec,
        latencyMs: driver.latencyMs,
        errors: driver.errors,
      }
    : null,
  memory,
  threads,
  fds,
  cpu,
  failedChecks: failed.map((c) => `${c.label ?? 'CPU'}: ${c.reason}`),
};

const rendered = JSON.stringify(report, null, 2);
if (opts.out) fs.writeFileSync(opts.out, rendered);

// Human summary to stderr so stdout stays machine-readable.
const lines = [];
lines.push('');
lines.push(`  agent-scale benchmark — ${overall.toUpperCase()}`);
lines.push(`  thread-mode=${threadMode}  samples=${samples.length}/${allSamples.length}` +
  `  window=${(durationMs / 1000).toFixed(1)}s`);
if (driver) {
  lines.push(
    `  turns: ${driver.turnsOk} ok / ${driver.turnsFailed} failed` +
      `  throughput=${driver.throughputTurnsPerSec?.toFixed(2)}/s` +
      `  p50=${driver.latencyMs?.p50?.toFixed(0)}ms p99=${driver.latencyMs?.p99?.toFixed(0)}ms`,
  );
}
lines.push('');
for (const m of memory) {
  if (!m.available) continue;
  lines.push(
    `  ${m.verdict.padEnd(12)} ${m.label.padEnd(24)} ` +
      `${(m.firstKib / 1024).toFixed(1)} → ${(m.lastKib / 1024).toFixed(1)} MiB` +
      (m.kibPerTurn !== null ? `  (${m.kibPerTurn.toFixed(2)} KiB/turn)` : ''),
  );
  lines.push(`               ${m.reason}`);
}
for (const c of [threads, fds]) {
  if (!c.available) continue;
  lines.push(`  ${c.verdict.padEnd(12)} ${c.label.padEnd(24)} ${c.first} → ${c.last} (max ${c.max})`);
  lines.push(`               ${c.reason}`);
}
if (cpu.available) {
  lines.push(
    `  ${cpu.verdict.padEnd(12)} ${'CPU'.padEnd(24)} ` +
      `${cpu.meanUtilizationCores?.toFixed(2)} cores mean` +
      (cpu.cpuMsPerTurn !== null ? `, ${cpu.cpuMsPerTurn.toFixed(1)} ms/turn` : ''),
  );
  lines.push(`               ${cpu.reason}`);
}
lines.push('');
process.stderr.write(`${lines.join('\n')}\n`);
process.stdout.write(`${rendered}\n`);

process.exit(overall === 'fail' ? 1 : 0);
