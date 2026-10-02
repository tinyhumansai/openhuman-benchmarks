// format.mjs — one place for how benchmark numbers are shown, used by the Markdown
// report and the web viewer (served to the browser as /format.mjs). Raw numbers stay
// raw in summary.json; this is display only.
//
//   count(248845)  -> "248.8k"     count(9876) -> "9,876"     count(2_400_000) -> "2.40M"
//   mem(351)       -> "351 MB"     mem(1536)   -> "1.50 GB"   mem(0.4) -> "410 KB"   (input in MB)
//   ms(696)        -> "696 ms"     ms(1240)    -> "1.24 s"    ms(95000) -> "1m 35s"
//   secs(4.7)      -> "4.7 s"      usd(0.00184) -> "$0.0018"  pct(97.31) -> "97.3%"

const NONE = "–";
const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const grouped = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Token / call / item counts: commas below 10,000, then k, M, B with 3 significant digits. */
export function count(v) {
  if (!has(v)) return NONE;
  const n = Number(v);
  const a = Math.abs(n);
  if (a < 10_000) return grouped(Math.round(n));
  if (a < 1_000_000) return `${grouped(n / 1e3, 1)}k`;
  if (a < 1e9) return `${grouped(n / 1e6, 2)}M`;
  return `${grouped(n / 1e9, 2)}B`;
}

/** Memory, given in MB (binary: 1 GB = 1024 MB). */
export function mem(mb) {
  if (!has(mb)) return NONE;
  const n = Number(mb);
  if (n >= 1024) return `${grouped(n / 1024, 2)} GB`;
  if (n >= 1) return `${grouped(n, n < 10 ? 1 : 0)} MB`;
  return `${grouped(n * 1024, 0)} KB`;
}

/** Durations given in milliseconds. */
export function ms(v) {
  if (!has(v)) return NONE;
  const n = Number(v);
  if (n < 1000) return `${grouped(Math.round(n))} ms`;
  if (n < 60_000) return `${grouped(n / 1000, n < 10_000 ? 2 : 1)} s`;
  const s = Math.round(n / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Durations given in seconds. */
export const secs = (v) => (has(v) ? ms(Number(v) * 1000) : NONE);

export function usd(v) {
  if (!has(v)) return NONE;
  const n = Number(v);
  return `$${n < 0.01 ? n.toFixed(4) : n < 100 ? n.toFixed(2) : grouped(n, 0)}`;
}

export const pct = (v, d = 1) => (has(v) ? `${grouped(Number(v), d)}%` : NONE);
