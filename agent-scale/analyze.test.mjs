#!/usr/bin/env node --test
/**
 * Tests for the agent-scale leak analyzer.
 *
 * The analyzer is the component whose failure mode is silence: if the math is
 * wrong it reports "pass" on a leaking run and nobody notices, which is worse
 * than not having the check at all. So the cases below drive it with synthetic
 * series whose correct verdict is known by construction — a steady leak, a
 * plateau, a flat line, thread and FD growth, and CPU drift.
 *
 * Run: node --test scripts/bench/analyze.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANALYZE = path.join(HERE, 'analyze.mjs');

const INTERVAL_MS = 250;

/**
 * Build a sample series.
 *
 * @param {object} opts
 * @param {number} opts.count      number of samples
 * @param {(i: number, n: number) => number} opts.rssKib
 * @param {(i: number, n: number) => number} [opts.threads]
 * @param {(i: number, n: number) => number} [opts.openFds]
 * @param {(i: number, n: number) => number} [opts.cpuMs] cumulative total CPU
 */
function buildSamples({ count, rssKib, threads, openFds, cpuMs }) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const tMs = i * INTERVAL_MS;
    const total = cpuMs ? cpuMs(i, count) : i * 50;
    lines.push(
      JSON.stringify({
        tMs,
        epochMs: 1_700_000_000_000 + tMs,
        rssKib: Math.round(rssKib(i, count)),
        vmHwmKib: Math.round(rssKib(i, count)),
        pssKib: null,
        privateKib: null,
        // Split the cumulative total across user/system; the analyzer sums them.
        cpuUserMs: total * 0.8,
        cpuSystemMs: total * 0.2,
        threads: threads ? Math.round(threads(i, count)) : 24,
        openFds: openFds ? Math.round(openFds(i, count)) : 40,
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function runAnalyzer(samplesText, driverSummary, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-analyze-'));
  try {
    const samplesPath = path.join(dir, 'samples.jsonl');
    const driverPath = path.join(dir, 'driver.json');
    fs.writeFileSync(samplesPath, samplesText);
    fs.writeFileSync(driverPath, JSON.stringify(driverSummary));

    const args = [ANALYZE, '--samples', samplesPath, '--driver', driverPath, ...extraArgs];
    let stdout;
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      // A failing verdict is a non-zero exit, which execFileSync throws on.
      // That is an expected outcome here, not an error.
      exitCode = err.status ?? 1;
      stdout = err.stdout ?? '';
    }
    return { report: JSON.parse(stdout), exitCode };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const driver = (overrides = {}) => ({
  config: { concurrency: 8, turns: 400, threadMode: 'fresh', warmupTurns: 10 },
  turnsOk: 400,
  turnsFailed: 0,
  throughputTurnsPerSec: 10,
  latencyMs: { p50: 80, p99: 200 },
  errors: {},
  ...overrides,
});

test('steady unbounded RSS growth is reported as a leak', () => {
  // 200 samples at 250ms = 50s, growing 400 KiB/sample = a relentless climb.
  const samples = buildSamples({ count: 200, rssKib: (i) => 120_000 + i * 400 });
  const { report, exitCode } = runAnalyzer(samples, driver());

  const rss = report.memory.find((m) => m.field === 'rssKib');
  assert.equal(rss.verdict, 'fail', rss.reason);
  assert.ok(rss.kibPerTurn > 0, 'should attribute growth per turn');
  assert.equal(report.overall, 'fail');
  assert.equal(exitCode, 1, 'a failing verdict must exit non-zero');
});

test('growth that levels off is reported as a plateau, not a leak', () => {
  // Rises steeply, then flattens — the shape of a cache reaching its working
  // set. The warm-up head is dropped, so the analyzed window is mostly flat.
  const samples = buildSamples({
    count: 200,
    rssKib: (i) => 120_000 + 40_000 * (1 - Math.exp(-i / 12)),
  });
  const { report, exitCode } = runAnalyzer(samples, driver());

  const rss = report.memory.find((m) => m.field === 'rssKib');
  assert.ok(
    rss.verdict === 'plateau' || rss.verdict === 'pass',
    `expected plateau/pass, got ${rss.verdict}: ${rss.reason}`,
  );
  assert.equal(report.overall, 'pass');
  assert.equal(exitCode, 0);
});

test('a flat RSS series passes', () => {
  // Small oscillation around a fixed level, no trend.
  const samples = buildSamples({
    count: 200,
    rssKib: (i) => 120_000 + Math.sin(i / 5) * 500,
  });
  const { report } = runAnalyzer(samples, driver());

  const rss = report.memory.find((m) => m.field === 'rssKib');
  assert.equal(rss.verdict, 'pass', rss.reason);
  assert.equal(report.overall, 'pass');
});

test('accumulating thread modes are not assessed for leaks', () => {
  // Same leaking series as the first test, but in a mode where growth is
  // expected. The analyzer must decline to call it rather than raise a false
  // alarm on conversation history.
  const samples = buildSamples({ count: 200, rssKib: (i) => 120_000 + i * 400 });
  const { report, exitCode } = runAnalyzer(
    samples,
    driver({ config: { threadMode: 'per-worker' } }),
  );

  const rss = report.memory.find((m) => m.field === 'rssKib');
  assert.equal(rss.verdict, 'not-assessed');
  assert.match(rss.reason, /--thread-mode fresh/);
  assert.equal(exitCode, 0, 'declining to assess is not a failure');
});

test('thread growth fails independently of memory', () => {
  const samples = buildSamples({
    count: 200,
    rssKib: () => 120_000, // memory perfectly flat
    threads: (i) => 24 + i * 0.5, // but threads climb
  });
  const { report, exitCode } = runAnalyzer(samples, driver());

  assert.equal(report.memory.find((m) => m.field === 'rssKib').verdict, 'pass');
  assert.equal(report.threads.verdict, 'fail', report.threads.reason);
  assert.equal(report.overall, 'fail');
  assert.equal(exitCode, 1);
});

test('file-descriptor growth fails independently of memory', () => {
  const samples = buildSamples({
    count: 200,
    rssKib: () => 120_000,
    openFds: (i) => 40 + i * 2,
  });
  const { report } = runAnalyzer(samples, driver());

  assert.equal(report.fds.verdict, 'fail', report.fds.reason);
  assert.equal(report.overall, 'fail');
});

test('stable threads and fds pass', () => {
  const samples = buildSamples({
    count: 200,
    rssKib: () => 120_000,
    threads: () => 24,
    openFds: (i) => 40 + (i % 3), // churn, but no trend
  });
  const { report } = runAnalyzer(samples, driver());

  assert.equal(report.threads.verdict, 'pass');
  assert.equal(report.fds.verdict, 'pass');
  assert.equal(report.overall, 'pass');
});

test('rising CPU cost per unit time is reported as drift', () => {
  // Quadratic cumulative CPU means a linearly rising rate: the same offered
  // load costing steadily more, which is the CPU analogue of a leak.
  const samples = buildSamples({
    count: 200,
    rssKib: () => 120_000,
    cpuMs: (i) => 0.02 * i * i,
  });
  const { report, exitCode } = runAnalyzer(samples, driver());

  assert.equal(report.cpu.verdict, 'fail', report.cpu.reason);
  assert.ok(report.cpu.drift > 0.25);
  assert.equal(exitCode, 1);
});

test('constant CPU rate passes and reports per-turn cost', () => {
  const samples = buildSamples({
    count: 200,
    rssKib: () => 120_000,
    cpuMs: (i) => i * 100, // steady 100ms CPU per 250ms wall
  });
  const { report } = runAnalyzer(samples, driver());

  assert.equal(report.cpu.verdict, 'pass', report.cpu.reason);
  assert.ok(report.cpu.cpuMsPerTurn > 0);
  assert.ok(report.cpu.meanUtilizationCores > 0);
});

test('warm-up samples are excluded from the analyzed window', () => {
  const samples = buildSamples({ count: 200, rssKib: () => 120_000 });
  const { report } = runAnalyzer(samples, driver(), ['--warmup-frac', '0.5']);

  assert.equal(report.window.totalSamples, 200);
  assert.equal(report.window.warmupSamplesDropped, 100);
  assert.equal(report.window.analyzedSamples, 100);
});

test('a looser per-turn budget can accept growth a tight one rejects', () => {
  const samples = buildSamples({ count: 200, rssKib: (i) => 120_000 + i * 400 });

  const tight = runAnalyzer(samples, driver(), ['--rss-kib-per-turn', '1']);
  assert.equal(tight.report.memory.find((m) => m.field === 'rssKib').verdict, 'fail');

  const loose = runAnalyzer(samples, driver(), ['--rss-kib-per-turn', '100000']);
  assert.equal(loose.report.memory.find((m) => m.field === 'rssKib').verdict, 'pass');
});

test('a series too short to analyze exits non-zero rather than guessing', () => {
  const samples = buildSamples({ count: 4, rssKib: () => 120_000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-analyze-'));
  try {
    const samplesPath = path.join(dir, 'samples.jsonl');
    fs.writeFileSync(samplesPath, samples);
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [ANALYZE, '--samples', samplesPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      exitCode = err.status ?? 1;
    }
    assert.notEqual(exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
