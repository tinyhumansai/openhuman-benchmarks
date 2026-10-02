#!/usr/bin/env node
// charts.mjs — render a benchmark run as small-multiple column charts: one panel
// per KPI, one column per harness, OpenHuman highlighted. Zero dependencies; the
// SVG is the product, PNG is optional.
//
//   node charts.mjs --run swe-1 [--theme light|dark] [--png] [--out DIR]
//                   [--only resolved,cost_task,...] [--title "..."]
//
// Reads results/<run>/summary.json (written by report.mjs). Writes charts.svg
// (and charts.png with --png, which installs @resvg/resvg-js into .cache on first use).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- what to draw ---------------------------------------------------------

/** Fixed order and identity: a harness keeps its position and colour in every panel. */
export const HARNESSES = [
  { id: "openhuman", label: ["Open", "Human"], hero: "coral" },
  { id: "claude-code", label: ["Claude", "Code"] },
  { id: "codex", label: ["Codex"] },
  { id: "opencode", label: ["Open", "Code"] },
  { id: "openclaw", label: ["Open", "Claw"] },
  { id: "hermes", label: ["Hermes"] },
  { id: "deepseek-harness", label: ["DeepSeek", "Harness"] },
  { id: "deepseek-harness-minimal", label: ["DS Harn.", "minimal"] },
];

// Cents keep cost labels short enough to sit inside a column ($0.0032 -> 0.32¢).
const fmtMoney = (v) => (v >= 0.1 ? `$${v.toFixed(2)}` : v >= 0.1 / 10 ? `${(v * 100).toFixed(1)}¢` : `${(v * 100).toFixed(2)}¢`);
const fmtSecs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);
const fmtTokens = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

/** `better`: which direction is good, used for the hint line and the best-in-panel star. */
export const METRICS = [
  {
    id: "resolved",
    title: "Tasks resolved",
    better: "higher",
    value: (s) =>
      s.swe_graded ? (100 * s.swe_resolved) / s.swe_graded : s.tasks ? (100 * s.check_passed) / s.tasks : null,
    format: (v) => `${v.toFixed(0)}%`,
  },
  { id: "cost_task", title: "Cost per task (cents)", better: "lower", value: (s) => s.cost_per_task_usd, format: fmtMoney },
  { id: "cost_resolved", title: "Cost per resolved task (cents)", better: "lower", value: (s) => s.cost_per_resolved_usd, format: fmtMoney },
  { id: "static_prompt", title: "System prompt + tools (tokens)", better: "lower", value: (s) => s.static_prompt_tokens, format: fmtTokens },
  { id: "cache", title: "Prompt cache hit", better: "higher", value: (s) => s.cache_pct, format: (v) => `${v.toFixed(0)}%` },
  { id: "ttft", title: "Time to first token (p50)", better: "lower", value: (s) => s.ttft_ms_p50, format: fmtSecs },
  { id: "wall", title: "Wall time per task (p50)", better: "lower", value: (s) => s.task_wall_s_p50, format: (v) => `${v.toFixed(0)}s` },
  { id: "cold", title: "Cold start to first call", better: "lower", value: (s) => s.cold_start_ms_p50, format: fmtSecs },
  { id: "cpu", title: "CPU-seconds per task", better: "lower", value: (s) => s.cpu_seconds_mean, format: (v) => v.toFixed(1) },
  { id: "ram", title: "Peak RAM (process, MB)", better: "lower", value: (s) => s.peak_anon_mb_max, format: (v) => `${Math.round(v)}` },
];

// ---- look -----------------------------------------------------------------

const THEMES = {
  light: {
    bg: "#ffffff", ink: "#14172b", sub: "#5b6177", muted: "#8a90a6", base: "#c9cddb",
    mutedTop: "#98a1bd", mutedBottom: "#eef0fa", mutedText: "#1b2038", star: "#d99a00", gold: "#f2a900", goldGlow: "#f2a900",
  },
  dark: {
    bg: "#0e1120", ink: "#eef0fa", sub: "#a4aac2", muted: "#7f86a1", base: "#343a55",
    mutedTop: "#7d86a8", mutedBottom: "#262c46", mutedText: "#f3f5ff", star: "#ffc83d", gold: "#ffc83d", goldGlow: "#ffc83d",
  },
};
const HERO = {
  coral: { top: "#ff2f5f", bottom: "#ff9161", text: "#ffffff" },
  violet: { top: "#8b3dff", bottom: "#ff7ab8", text: "#ffffff" },
};
const FONT = `Inter, "Helvetica Neue", Helvetica, Arial, "DejaVu Sans", sans-serif`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Column with a rounded data end (top) and a flat baseline end. */
function columnPath(x, yTop, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  const yb = yTop + h;
  return `M${x},${yb} V${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} H${x + w - rr} Q${x + w},${yTop} ${x + w},${yTop + rr} V${yb} Z`;
}

function star(cx, cy, r, fill) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
}

export function renderSvg({ meta, summary }, opts = {}) {
  const t = THEMES[opts.theme ?? "light"];
  const harnesses = HARNESSES.filter((h) => summary[h.id]);
  const metrics = (opts.only ? METRICS.filter((m) => opts.only.includes(m.id)) : METRICS).filter((m) =>
    harnesses.some((h) => m.value(summary[h.id]) != null),
  );

  const cols = Math.min(5, metrics.length);
  const rows = Math.ceil(metrics.length / cols);
  const panelW = 396;
  const panelH = 344;
  const headerH = 112;
  const footerH = 52;
  const W = cols * panelW + 80;
  const H = headerH + rows * panelH + footerH;
  const barW = 38;
  const slot = Math.min(52, (panelW - 48) / harnesses.length);
  const plotH = 188;
  const baseY = 268; // baseline within a panel

  const defs = [];
  const gid = (name) => `g-${name}`;
  for (const [name, c] of Object.entries(HERO)) {
    defs.push(`<linearGradient id="${gid(name)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.top}"/><stop offset="1" stop-color="${c.bottom}"/></linearGradient>`);
  }
  defs.push(`<filter id="winner-glow" x="-60%" y="-30%" width="220%" height="160%"><feDropShadow dx="0" dy="0" stdDeviation="4.5" flood-color="${t.goldGlow}" flood-opacity="0.65"/></filter>`);
  defs.push(`<linearGradient id="${gid("muted")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.mutedTop}"/><stop offset="1" stop-color="${t.mutedBottom}"/></linearGradient>`);

  const parts = [];
  const title = opts.title ?? `Harness benchmark · ${meta.suite === "swe" ? "SWE-bench Verified" : meta.suite} · ${meta.run_id}`;
  const nTasks = Math.max(...harnesses.map((h) => summary[h.id].tasks));
  parts.push(`<text x="40" y="48" font-size="26" font-weight="700" fill="${t.ink}">${esc(title)}</text>`);
  parts.push(
    `<text x="40" y="76" font-size="14" fill="${t.sub}">${esc(meta.model)} · reasoning ${esc(meta.reasoning)} · ${esc(meta.cpus)} vCPU / ${esc(meta.mem)} per task · same key, same model, same container limits</text>`,
  );
  parts.push(`<text x="40" y="96" font-size="12" fill="${t.muted}">Each panel has its own scale from zero. Gold outline + ★ marks the best column in a panel.</text>`);

  metrics.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ox = 40 + col * panelW;
    const oy = headerH + row * panelH;
    const g = [];
    const vals = harnesses.map((h) => m.value(summary[h.id]));
    const present = vals.filter((v) => v != null && Number.isFinite(v));
    const max = present.length ? Math.max(...present) : 0;
    const best = present.length ? (m.better === "higher" ? Math.max(...present) : Math.min(...present)) : null;
    const left = (panelW - 24 - slot * harnesses.length) / 2 + 12;

    harnesses.forEach((h, k) => {
      const v = vals[k];
      const cx = left + slot * k + slot / 2;
      const x = cx - barW / 2;
      const hero = h.hero ? HERO[h.hero] : null;
      const fill = hero ? `url(#${gid(h.hero)})` : `url(#${gid("muted")})`;
      const valText = hero ? hero.text : t.mutedText;
      const nameFill = hero ? (h.hero === "coral" ? "#ff2f5f" : "#8b3dff") : t.sub;
      let nameBottom = baseY;
      if (v == null || !Number.isFinite(v)) {
        g.push(`<text x="${cx}" y="${baseY - 8}" text-anchor="middle" font-size="11" fill="${t.muted}">n/a</text>`);
        nameBottom = baseY - 22;
      } else {
        const hgt = max > 0 ? Math.max(3, (v / max) * plotH) : 3;
        const yTop = baseY - hgt;
        const label = esc(m.format(v));
        const tip = `${h.label.join("")} (${h.id}): ${m.format(v)}`;
        const isBest = best != null && v === best;
        // The winning column(s): bold gold outline plus a soft glow, so the best
        // harness reads at a glance and not only through a small marker.
        g.push(
          isBest
            ? `<g><title>${esc(tip)} (best)</title><path d="${columnPath(x, yTop, barW, hgt, 6)}" fill="${fill}" stroke="${t.gold}" stroke-width="3" stroke-linejoin="round" filter="url(#winner-glow)"/>`
            : `<g><title>${esc(tip)}</title><path d="${columnPath(x, yTop, barW, hgt, 6)}" fill="${fill}"/>`,
        );
        if (hgt >= 26) {
          g.push(`<text x="${cx}" y="${yTop + 18}" text-anchor="middle" font-size="12.5" font-weight="${isBest ? 800 : 700}" fill="${valText}">${label}</text>`);
          nameBottom = yTop - 8;
        } else {
          g.push(`<text x="${cx}" y="${yTop - 7}" text-anchor="middle" font-size="12.5" font-weight="700" fill="${t.ink}">${label}</text>`);
          nameBottom = yTop - 26;
        }
        g.push("</g>");
        if (isBest) g.push(star(cx, nameBottom - h.label.length * 12 - 12, 6.5, t.gold));
      }
      h.label.forEach((line, li) => {
        const y = nameBottom - (h.label.length - 1 - li) * 12 - 2;
        g.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-size="10.5" font-weight="${hero ? 700 : 500}" fill="${nameFill}">${esc(line)}</text>`);
      });
    });

    g.push(`<line x1="12" y1="${baseY}" x2="${panelW - 12}" y2="${baseY}" stroke="${t.base}" stroke-width="1.5"/>`);
    g.push(`<text x="${panelW / 2}" y="${baseY + 32}" text-anchor="middle" font-size="16" font-weight="600" fill="${t.ink}">${esc(m.title)}</text>`);
    g.push(
      `<text x="${panelW / 2}" y="${baseY + 51}" text-anchor="middle" font-size="11" fill="${t.muted}">${m.better === "higher" ? "↑ higher is better" : "↓ lower is better"}</text>`,
    );
    parts.push(`<g transform="translate(${ox},${oy})">${g.join("")}</g>`);
  });

  parts.push(
    `<text x="40" y="${H - 20}" font-size="12" fill="${t.muted}">${nTasks} tasks, 1 attempt each: a smoke test, not a ranking. CPU/RAM are cgroup-wide per container. Cost from OpenRouter-reported usage. Source: bench/harnesses/results/${esc(meta.run_id)}/summary.json</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family='${FONT}' role="img" aria-label="${esc(title)}">
<defs>${defs.join("")}</defs>
<rect width="${W}" height="${H}" fill="${t.bg}"/>
${parts.join("\n")}
</svg>
`;
}

// ---- PNG (optional) -------------------------------------------------------

function renderPng(svg, outFile) {
  const dir = path.join(here, ".cache", "charts-deps");
  if (!fs.existsSync(path.join(dir, "node_modules", "@resvg", "resvg-js"))) {
    fs.mkdirSync(dir, { recursive: true });
    process.stderr.write("[charts] installing @resvg/resvg-js into .cache/charts-deps ...\n");
    execFileSync("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", "@resvg/resvg-js"], { stdio: "inherit" });
  }
  const script = `
    const { Resvg } = require("@resvg/resvg-js");
    const fs = require("fs");
    const svg = fs.readFileSync(0, "utf8");
    const png = new Resvg(svg, { fitTo: { mode: "zoom", value: 2 }, font: { loadSystemFonts: true } }).render().asPng();
    fs.writeFileSync(process.argv[1], png);
  `;
  execFileSync("node", ["-e", script, outFile], { input: svg, cwd: dir, stdio: ["pipe", "inherit", "inherit"] });
}

// ---- CLI ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const run = opt("--run");
  if (!run) throw new Error("usage: charts.mjs --run <run-id> [--theme light|dark] [--png] [--out DIR] [--only a,b]");
  const summaryPath = path.join(here, "results", run, "summary.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`missing ${summaryPath}; run: node report.mjs --run-id ${run}`);
  const data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const theme = opt("--theme") ?? "light";
  if (!THEMES[theme]) throw new Error(`unknown theme ${theme}`);
  const outDir = path.resolve(opt("--out") ?? path.join(here, "results", run));
  fs.mkdirSync(outDir, { recursive: true });
  const stem = theme === "light" ? "charts" : `charts-${theme}`;
  const svg = renderSvg(data, { theme, only: opt("--only")?.split(","), title: opt("--title") });
  fs.writeFileSync(path.join(outDir, `${stem}.svg`), svg);
  process.stdout.write(`wrote ${path.join(outDir, `${stem}.svg`)}\n`);
  if (args.includes("--png")) {
    renderPng(svg, path.join(outDir, `${stem}.png`));
    process.stdout.write(`wrote ${path.join(outDir, `${stem}.png`)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
