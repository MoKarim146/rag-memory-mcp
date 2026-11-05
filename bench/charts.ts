// Draws the README charts from the saved benchmark results, so every chart can be regenerated from data:
//
//   npx tsx bench/charts.ts
//
// Writes docs/charts/<name>-light.svg and <name>-dark.svg. The README shows the right one for the reader's
// GitHub theme with a <picture> element. Colours are the validated reference palette (first three
// categorical slots, checked for colour-blind separation in both modes); the light-mode aqua is below 3:1
// contrast, so every line and bar is also labelled directly and the numbers are in tables in the docs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(BENCH, "..", "docs", "charts");

interface Theme {
  name: "light" | "dark";
  surface: string;
  primary: string;
  secondary: string;
  muted: string;
  grid: string;
  axis: string;
  series: [string, string, string]; // this server, old server, paste everything
}

const THEMES: Theme[] = [
  {
    name: "light",
    surface: "#fcfcfb",
    primary: "#0b0b0b",
    secondary: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    series: ["#2a78d6", "#eb6834", "#1baf7a"],
  },
  {
    name: "dark",
    surface: "#1a1a19",
    primary: "#f0efec",
    secondary: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    series: ["#3987e5", "#d95926", "#199e70"],
  },
];

const FONT = `system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");
const compact = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : String(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function frame(t: Theme, width: number, height: number, title: string, subtitle: string, body: string, alt: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(alt)}</desc>
<rect width="${width}" height="${height}" rx="12" fill="${t.surface}"/>
<g font-family='${FONT}'>
<text x="24" y="34" font-size="17" font-weight="600" fill="${t.primary}">${esc(title)}</text>
<text x="24" y="56" font-size="13" fill="${t.secondary}">${esc(subtitle)}</text>
${body}
</g>
</svg>
`;
}

// A legend row: a short line or square key beside each name, in text colour.
function legend(t: Theme, x: number, y: number, names: string[], kind: "line" | "bar"): string {
  let out = "";
  let cx = x;
  names.forEach((name, i) => {
    const key =
      kind === "line"
        ? `<line x1="${cx}" y1="${y - 4}" x2="${cx + 16}" y2="${y - 4}" stroke="${t.series[i]}" stroke-width="2" stroke-linecap="round"/>`
        : `<rect x="${cx}" y="${y - 10}" width="12" height="12" rx="3" fill="${t.series[i]}"/>`;
    out += `${key}<text x="${cx + 22}" y="${y}" font-size="13" fill="${t.secondary}">${esc(name)}</text>`;
    cx += 22 + name.length * 7.2 + 24;
  });
  return out;
}

// Horizontal bar growing from the baseline at x0: square at the baseline, 4px round at the data end.
function hbar(x0: number, y: number, w: number, h: number, fill: string, tip: string): string {
  const r = Math.min(4, w / 2, h / 2);
  const d = `M${x0},${y} H${x0 + w - r} Q${x0 + w},${y} ${x0 + w},${y + r} V${y + h - r} Q${x0 + w},${y + h} ${x0 + w - r},${y + h} H${x0} Z`;
  return `<path d="${d}" fill="${fill}"><title>${esc(tip)}</title></path>`;
}

// ---------------------------------------------------------------------------------------------------------
// 1. Short chat cost as the vault grows

interface ScaleRow {
  notes: number;
  quickChatPasteEverything: number;
  quickChatOldServer: number;
  quickChatThisServer: number;
}

function growthChart(t: Theme, rows: ScaleRow[]): string {
  const W = 760, H = 400;
  const left = 70, right = 600, top = 96, bottom = 336;
  const xs = rows.map((r) => r.notes);
  const lx = (n: number) => left + ((Math.log10(n) - Math.log10(xs[0])) / (Math.log10(xs.at(-1)!) - Math.log10(xs[0]))) * (right - left);
  const yMin = 1e3, yMax = 1e6;
  const ly = (v: number) => bottom - ((Math.log10(v) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * (bottom - top);

  let body = legend(t, 24, 82, ["This server", "Old server", "Paste every note"], "line");
  for (const tick of [1e3, 1e4, 1e5, 1e6]) {
    body += `<line x1="${left}" y1="${ly(tick)}" x2="${right}" y2="${ly(tick)}" stroke="${t.grid}" stroke-width="1"/>`;
    body += `<text x="${left - 10}" y="${ly(tick) + 4}" font-size="12" fill="${t.muted}" text-anchor="end" style="font-variant-numeric: tabular-nums">${compact(tick)}</text>`;
  }
  body += `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${t.axis}" stroke-width="1"/>`;
  for (const n of xs) {
    body += `<text x="${lx(n)}" y="${bottom + 20}" font-size="12" fill="${t.muted}" text-anchor="middle" style="font-variant-numeric: tabular-nums">${fmt(n)}</text>`;
  }
  body += `<text x="${(left + right) / 2}" y="${bottom + 42}" font-size="12" fill="${t.muted}" text-anchor="middle">Notes in the vault (both axes on a log scale)</text>`;

  const series: [keyof ScaleRow, string][] = [
    ["quickChatThisServer", "This server"],
    ["quickChatOldServer", "Old server"],
    ["quickChatPasteEverything", "Paste every note"],
  ];
  series.forEach(([key, name], i) => {
    const points = rows.map((r) => [lx(r.notes), ly(r[key] as number)] as const);
    body += `<polyline points="${points.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${t.series[i]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    rows.forEach((r, k) => {
      const [x, y] = points[k];
      body += `<circle cx="${x}" cy="${y}" r="4.5" fill="${t.series[i]}" stroke="${t.surface}" stroke-width="2"><title>${esc(`${name}, ${fmt(r.notes)} notes: ${fmt(r[key] as number)} tokens`)}</title></circle>`;
    });
    const last = rows.at(-1)!;
    const [x, y] = points.at(-1)!;
    body += `<text x="${x + 12}" y="${y - 2}" font-size="13" font-weight="600" fill="${t.primary}">${fmt(last[key] as number)}</text>`;
    body += `<text x="${x + 12}" y="${y + 14}" font-size="12" fill="${t.secondary}">${esc(name.toLowerCase())}</text>`;
  });

  const alt = rows
    .map((r) => `${fmt(r.notes)} notes: this server ${fmt(r.quickChatThisServer)}, old server ${fmt(r.quickChatOldServer)}, paste every note ${fmt(r.quickChatPasteEverything)} tokens`)
    .join("; ");
  return frame(t, W, H, "A short chat stays small as your notes pile up", "Tokens for one short chat: tool descriptions, start summary and 3 searches", body, alt);
}

// ---------------------------------------------------------------------------------------------------------
// 2. Three test sets, two kinds of chat

interface SetResult {
  label: string;
  questions: number;
  long: [number, number, number]; // this, old, paste
  quick: [number, number, number];
  answered: [number, number, number];
}

function setsChart(t: Theme, sets: SetResult[]): string {
  const W = 760;
  const names = ["This server", "Old server", "Paste every note"];
  const panelTop = 136;
  const bar = 14, gap = 2, groupGap = 22;
  const groupHeight = 3 * bar + 2 * gap;
  const labelW = 150;

  const panel = (title: string, key: "long" | "quick", x0: number, width: number, max: number) => {
    let out = `<text x="${x0}" y="${panelTop - 14}" font-size="13" font-weight="600" fill="${t.primary}">${esc(title)}</text>`;
    const scale = (v: number) => (v / max) * (width - 92);
    sets.forEach((set, s) => {
      const gy = panelTop + s * (groupHeight + groupGap);
      set[key].forEach((value, i) => {
        const y = gy + i * (bar + gap);
        const w = Math.max(2, scale(value));
        out += hbar(x0, y, w, bar, t.series[i], `${set.label}, ${names[i]}: ${fmt(value)} tokens, ${set.answered[i]} of ${set.questions} answered`);
        out += `<text x="${x0 + w + 6}" y="${y + bar - 3}" font-size="12" fill="${t.secondary}" style="font-variant-numeric: tabular-nums">${fmt(value)}</text>`;
      });
    });
    out += `<line x1="${x0}" y1="${panelTop - 4}" x2="${x0}" y2="${panelTop + sets.length * (groupHeight + groupGap) - groupGap + 4}" stroke="${t.axis}" stroke-width="1"/>`;
    return out;
  };

  let body = legend(t, 24, 82, names, "bar");
  sets.forEach((set, s) => {
    const gy = panelTop + s * (groupHeight + groupGap);
    body += `<text x="24" y="${gy + 18}" font-size="13" font-weight="600" fill="${t.primary}">${esc(set.label)}</text>`;
    body += `<text x="24" y="${gy + 36}" font-size="12" fill="${t.secondary}">answered ${set.answered.map((a) => `${a}`).join(" / ")}</text>`;
    body += `<text x="24" y="${gy + 52}" font-size="12" fill="${t.muted}">of ${set.questions} questions</text>`;
  });
  const maxLong = Math.max(...sets.flatMap((s) => s.long));
  const maxQuick = Math.max(...sets.flatMap((s) => s.quick));
  body += panel("All questions in one chat", "long", labelW + 24, 300, maxLong);
  body += panel("A short chat: 3 questions", "quick", labelW + 24 + 316, 260, maxQuick);
  const noteY = panelTop + sets.length * (groupHeight + groupGap) + 18;
  const H = noteY + 18 + 22;
  body += `<text x="24" y="${noteY}" font-size="12" fill="${t.secondary}">On these small vaults, pasting every note is cheapest for a long chat. For a short chat, this server is cheapest.</text>`;
  body += `<text x="24" y="${noteY + 18}" font-size="12" fill="${t.muted}">"Answered" lists this server / old server / paste every note. Sets 1 and 2 were used for tuning; set 3 was not.</text>`;

  const alt = sets
    .map((s) => `${s.label}: all questions ${s.long.map(fmt).join(", ")} tokens; short chat ${s.quick.map(fmt).join(", ")} tokens (this server, old server, paste every note); answered ${s.answered.join(", ")} of ${s.questions}`)
    .join(". ");
  return frame(t, W, H, "Tokens on the three test sets", "Lower is better. Keyword searches, counted with the o200k_base tokenizer", body, alt);
}

// ---------------------------------------------------------------------------------------------------------
// 3. Security rounds

interface Round {
  label: string;
  before: number;
  beforeTotal: number;
  after: number;
  total: number;
}

function securityChart(t: Theme, rounds: Round[]): string {
  const W = 760, H = 250;
  const x0 = 230, width = 400, bar = 18, gap = 2;
  let body = legend(t, 24, 82, ["After the fixes", "Before the fixes"], "bar");
  rounds.forEach((round, r) => {
    const gy = 106 + r * 56;
    body += `<text x="24" y="${gy + 16}" font-size="13" font-weight="600" fill="${t.primary}">${esc(round.label)}</text>`;
    body += `<text x="24" y="${gy + 34}" font-size="12" fill="${t.muted}">${round.total} tests</text>`;
    [
      [round.after, round.total, 0, "after"],
      [round.before, round.beforeTotal, 1, "before"],
    ].forEach(([value, total, i, when]) => {
      const y = gy + (i as number) * (bar + gap);
      const w = Math.max(2, ((value as number) / (total as number)) * width);
      body += hbar(x0, y, w, bar, t.series[i as number], `${round.label}, ${when} the fixes: ${value} of ${total} passed`);
      body += `<text x="${x0 + w + 6}" y="${y + bar - 4}" font-size="12" fill="${t.secondary}" style="font-variant-numeric: tabular-nums">${value} of ${total}</text>`;
    });
  });
  body += `<line x1="${x0}" y1="102" x2="${x0}" y2="${106 + rounds.length * 56 - 14}" stroke="${t.axis}" stroke-width="1"/>`;
  const alt = rounds.map((r) => `${r.label}: ${r.before} of ${r.beforeTotal} passed before the fixes, ${r.after} of ${r.total} after`).join("; ");
  return frame(t, W, H, "Attack tests, before and after the fixes", "Tests were written first and run on the old code, then the code was fixed. Fuzz tests found 5 more bugs, all fixed.", body, alt);
}

// ---------------------------------------------------------------------------------------------------------

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(BENCH, "results", file), "utf8")) as T;
}

interface Run {
  variant: string;
  style: string;
  summary: { readingTokens: number; quickChatTokens: number; answered: number; answerableLookups: number };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const scale = await json<{ rows: ScaleRow[] }>("scale.json");
  const pick = (runs: Run[], variant: string) => runs.find((r) => r.variant === variant && r.style === "keyword")!;
  const sets: SetResult[] = [];
  for (const [label, file] of [["Set 1", "dev-after-r3.json"], ["Set 2", "holdout-after-r3.json"], ["Set 3", "test3-after.json"]] as const) {
    const runs = await json<Run[]>(file);
    const [a, b, c] = [pick(runs, "current"), pick(runs, "baseline"), pick(runs, "fullcontext")];
    sets.push({
      label,
      questions: a.summary.answerableLookups,
      long: [a.summary.readingTokens, b.summary.readingTokens, c.summary.readingTokens],
      quick: [a.summary.quickChatTokens, b.summary.quickChatTokens, c.summary.quickChatTokens],
      answered: [a.summary.answered, b.summary.answered, c.summary.answered],
    });
  }
  const passed = async (file: string) => {
    const r = await json<{ numPassedTests: number; numTotalTests: number }>(path.join("..", "..", "security", file));
    return [r.numPassedTests, r.numTotalTests] as const;
  };
  const [auditBefore, auditBeforeTotal] = await passed("audit-before-fixes.json");
  const [auditAfter, auditTotal] = await passed("audit-after-fixes.json");
  const [owaspBefore, owaspBeforeTotal] = await passed("owasp-before-fixes.json");
  const [owaspAfter, owaspTotal] = await passed("owasp-after-fixes.json");
  const rounds: Round[] = [
    // The first audit had 37 tests when it ran before the fixes; the 38th (false alarms) was added with the fixes.
    { label: "First audit", before: auditBefore, beforeTotal: auditBeforeTotal, after: auditAfter, total: auditTotal },
    { label: "OWASP LLM Top 10 (2026)", before: owaspBefore, beforeTotal: owaspBeforeTotal, after: owaspAfter, total: owaspTotal },
  ];

  for (const theme of THEMES) {
    await writeFile(path.join(OUT, `growth-${theme.name}.svg`), growthChart(theme, scale.rows));
    await writeFile(path.join(OUT, `test-sets-${theme.name}.svg`), setsChart(theme, sets));
    await writeFile(path.join(OUT, `security-${theme.name}.svg`), securityChart(theme, rounds));
  }
  console.log(`Wrote ${THEMES.length * 3} charts to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
