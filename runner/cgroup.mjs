// cgroup.mjs — container-wide CPU and memory sampling from the cgroup v2 files
// every container sees for itself. Per-container (not per-pid) on purpose: a
// harness is a tree of processes (node + children + shells + test runs) and the
// comparison has to charge the whole tree, the same way for every harness.

import fs from "node:fs";

const ROOT = process.env.BENCH_CGROUP_ROOT || "/sys/fs/cgroup";

function readNumber(file) {
  try {
    const text = fs.readFileSync(`${ROOT}/${file}`, "utf8").trim();
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readCpuUsec() {
  try {
    const text = fs.readFileSync(`${ROOT}/cpu.stat`, "utf8");
    const m = text.match(/^usage_usec\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** One reading of the container's cumulative CPU and current/peak memory. */
export function readSample(now = Date.now()) {
  return {
    epoch_ms: now,
    cpu_usec: readCpuUsec(),
    mem_bytes: readNumber("memory.current"),
    mem_peak_bytes: readNumber("memory.peak"),
  };
}

export function startSampler(intervalMs = 500) {
  const samples = [readSample()];
  const timer = setInterval(() => samples.push(readSample()), intervalMs);
  timer.unref?.();
  return {
    samples,
    stop() {
      clearInterval(timer);
      samples.push(readSample());
      return samples;
    },
  };
}

/**
 * Reduce a window of samples. `cpu_seconds` is the CPU the container consumed
 * between the first and last sample (so idle time between turns is free, busy
 * time is charged); `peak_mem_bytes` prefers the kernel's own high-water mark
 * over what a 2 Hz poll happened to catch. Memory includes page cache the
 * container touched, which is what a cgroup limit actually charges.
 */
export function summarize(samples) {
  const usable = samples.filter((s) => s.cpu_usec !== null);
  if (usable.length < 2) {
    return { cpu_seconds: null, peak_mem_bytes: null, avg_mem_bytes: null, samples: samples.length };
  }
  const first = usable[0];
  const last = usable[usable.length - 1];
  const mems = samples.map((s) => s.mem_bytes).filter((v) => v !== null);
  const kernelPeak = Math.max(
    0,
    ...samples.map((s) => s.mem_peak_bytes).filter((v) => v !== null),
  );
  const polledPeak = mems.length ? Math.max(...mems) : 0;
  const wallSeconds = (last.epoch_ms - first.epoch_ms) / 1000;
  const cpuSeconds = (last.cpu_usec - first.cpu_usec) / 1e6;
  return {
    cpu_seconds: cpuSeconds,
    // 1.0 == one fully busy vCPU for the whole window
    avg_cpu_cores: wallSeconds > 0 ? cpuSeconds / wallSeconds : null,
    peak_mem_bytes: Math.max(kernelPeak, polledPeak) || null,
    avg_mem_bytes: mems.length ? mems.reduce((a, b) => a + b, 0) / mems.length : null,
    wall_seconds: wallSeconds,
    samples: samples.length,
  };
}
