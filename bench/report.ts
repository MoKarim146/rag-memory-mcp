// Fills the result tables in the docs from run folders, so no published number is copied by hand.
//
//   npx tsx bench/report.ts            rewrite every generated block in docs/*.md, README.md and RAG_RESULTS.md
//   npx tsx bench/report.ts --check    fail if any generated block differs from what the run folders give (CI)
//
// A generated block looks like this in a markdown file:
//
//   <!-- generated: retrieval eval-scifact test -->
//   ...table...
//   <!-- /generated -->
//
// Kinds:
//   retrieval <benchmark> <split>   the latest clean run of bench/runs/<benchmark>/ with that split: one row per
//                                   system and number of results
//   retrieval-by <benchmark> <split> <results>
//                                   the same run, broken down by question type: Recall@5 per system, with its 95%
//                                   interval, for the groups with that number of results
//   books <group> [<group> ...]     the latest clean run of bench/runs/books/: one row per named group
//   tokens <file> [<file> ...]      the token benchmark's committed results (bench/results/<file>.json, written by
//                                   bench/run.ts): a short chat per test set, with keyword searches
// "Clean" means the folder name does not end in -dirty (the code was exactly the commit it names).
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRecords, type QueryRecord } from "./lib/runs.js";
import { bootstrapMean, bootstrapPairedDifference } from "./lib/stats.js";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(BENCH, "..");
const RUNS = path.join(BENCH, "runs");

interface Run {
  dir: string;
  id: string;
  meta: { config: Record<string, unknown>; plan: { name: string; about: Record<string, unknown> }[]; git: { commit: string }; facts?: Record<string, unknown> };
  summary: Record<string, Record<string, unknown>>;
  timings: { groups: Record<string, Record<string, unknown>>; other: Record<string, unknown> };
}

async function runs(benchmark: string): Promise<Run[]> {
  const base = path.join(RUNS, benchmark);
  if (!existsSync(base)) return [];
  const out: Run[] = [];
  for (const id of (await readdir(base)).sort()) {
    if (id.endsWith("-dirty")) continue;
    const dir = path.join(base, id);
    const read = async (f: string) => JSON.parse(await readFile(path.join(dir, f), "utf8"));
    out.push({ dir, id, meta: await read("meta.json"), summary: await read("summary.json"), timings: await read("timings.json") });
  }
  return out;
}

const fmt = (v: unknown, digits = 3) =>
  v === null || v === undefined
    ? ""
    : typeof v === "number"
      ? Number.isInteger(v) || digits === 0
        ? Math.round(v).toLocaleString("en-US")
        : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: digits < 3 })
      : String(v);
const pctCell = (v: unknown) => (v === null || v === undefined ? "" : `${v}%`);

const interval = (ci: [number, number] | null) => (ci ? `${ci[0].toFixed(3)} to ${ci[1].toFixed(3)}` : "");

async function retrievalTable(benchmark: string, split: string): Promise<string> {
  const run = (await runs(benchmark)).filter((r) => r.meta.config.split === split).at(-1);
  if (!run) return `_No clean run of ${benchmark} (${split}) yet._`;
  const records = await readRecords(run.dir);
  const byGroup = new Map<string, QueryRecord[]>();
  for (const r of records) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  const recall5 = (rs: QueryRecord[]) => rs.map((r) => (r.correct.recallAt5 as number | null) ?? 0);
  const hasDistractors = run.meta.plan.some((g) => run.summary[g.name]?.distractorFirstPct != null);
  const lines = [
    `Run \`${path.relative(ROOT, run.dir)}\` (commit \`${run.meta.git.commit.slice(0, 7)}\`). Recall@5 interval: 95% bootstrap over questions (2,000 resamples, seed 1). Warm search: one search once the index is built. Cold start: building the index, with embedding for dense and hybrid. Memory: growth of the benchmark process's resident memory while the index was built, a rough reading that garbage collection can make negative.`,
    "",
    `| System | Results | Questions | Recall@5 | Recall@5, 95% interval | Recall@10 | nDCG@10 | MRR | Evidence shown | Answer present |${hasDistractors ? " Distractor first |" : ""} Without vectors | Tokens (mean) | Warm search ms (mean) | Cold start ms (mean) | Memory MB (rough) |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|${hasDistractors ? "---:|" : ""}---:|---:|---:|---:|---:|`,
  ];
  for (const group of run.meta.plan) {
    const s = run.summary[group.name] ?? {};
    const t = run.timings.groups[group.name] ?? {};
    const about = group.about;
    const system = `${about.system}${group.name.endsWith("/abstention") ? " (no-answer questions)" : ""}`;
    const cold = t.indexMsMean ?? run.timings.other[`${about.system}/coldStartMs`];
    const ci = group.name.endsWith("/abstention") ? null : bootstrapMean(recall5(byGroup.get(group.name) ?? []));
    lines.push(
      `| ${system} | ${about.limit} | ${fmt(s.questions)} | ${fmt(s.recallAt5)} | ${interval(ci)} | ${fmt(s.recallAt10)} | ${fmt(s.ndcgAt10)} | ${fmt(s.mrr)} | ${pctCell(s.evidenceShownPct)} | ${pctCell(s.answerPresentPct)} |${hasDistractors ? ` ${pctCell(s.distractorFirstPct)} |` : ""} ${fmt(s.embeddingFailed ?? "")} | ${fmt(s.tokensMean)} | ${fmt(t.msMean, 1)} | ${fmt(cold, 0)} | ${fmt(run.timings.other[`${about.system}/rssGrowthMBMean`], 1)} |`,
    );
  }
  // Index size, for corpora shared by all questions (the run records it once per system).
  const sizes = [...new Set(run.meta.plan.map((g) => String(g.about.system)))]
    .map((system) => [system, run.meta.facts?.[`${system}/index`] as { files: number; passages: number; vectors: number } | undefined] as const)
    .filter(([, stats]) => stats);
  if (sizes.length) {
    lines.push(
      "",
      `Index: ${sizes.map(([system, st]) => `${system} ${fmt(st!.files)} notes, ${fmt(st!.passages)} passages, ${fmt(st!.vectors)} vectors`).join("; ")}. The notes include the server's five main notes, which it creates with only a heading.`,
    );
  }
  // Paired differences on the same questions and number of results: each system against keyword search, and
  // hybrid against vectors alone.
  const diffs: string[] = [];
  const valueOf = (r: QueryRecord, key: string) => (r.correct[key] as number | null) ?? 0;
  const pairs: [string, string][] = [
    ["dense", "bm25"],
    ["hybrid", "bm25"],
    ["hybrid", "dense"],
    ["old", "bm25"],
  ];
  for (const limit of [...new Set(run.meta.plan.map((g) => g.about.limit))]) {
    for (const [a, b] of pairs) {
      const find = (system: string) => run.meta.plan.find((g) => g.about.system === system && g.about.limit === limit && !g.name.endsWith("/abstention"));
      const ga = find(a);
      const gb = find(b);
      if (!ga || !gb) continue;
      const mine = new Map((byGroup.get(ga.name) ?? []).map((r) => [r.id, r]));
      const theirs = new Map((byGroup.get(gb.name) ?? []).map((r) => [r.id, r]));
      const ids = [...mine.keys()].filter((id) => theirs.has(id)).sort();
      if (ids.length < 2) continue;
      const cells = ["recallAt5", "reciprocalRank"].map((key) => {
        const d = bootstrapPairedDifference(ids.map((id) => valueOf(mine.get(id)!, key)), ids.map((id) => valueOf(theirs.get(id)!, key)));
        return `${d.mean >= 0 ? "+" : ""}${d.mean.toFixed(3)} | ${interval(d.interval)}`;
      });
      diffs.push(`| ${a} minus ${b} | ${limit} | ${ids.length} | ${cells.join(" | ")} |`);
    }
  }
  if (diffs.length) {
    lines.push(
      "",
      "Paired differences on the same questions (95% bootstrap interval of the mean difference, 2,000 resamples, seed 1). An interval that includes 0 means the difference may be chance.",
      "",
      "| Difference | Results | Same questions | Recall@5 | Recall@5, 95% interval | MRR | MRR, 95% interval |",
      "|---|---:|---:|---:|---:|---:|---:|",
      ...diffs,
    );
  }
  return lines.join("\n");
}

async function breakdownTable(benchmark: string, split: string, limit: string): Promise<string> {
  const run = (await runs(benchmark)).filter((r) => r.meta.config.split === split).at(-1);
  if (!run) return `_No clean run of ${benchmark} (${split}) yet._`;
  const records = await readRecords(run.dir);
  const groups = run.meta.plan.filter((g) => String(g.about.limit) === limit && !g.name.endsWith("/abstention"));
  if (groups.length === 0) throw new Error(`${run.id} has no groups with ${limit} results`);
  const types = [...new Set(records.map((r) => r.tags.type).filter((t): t is string => Boolean(t)))].sort();
  const lines = [
    `Recall@5 by question type, ${limit} results per search, same run. 95% bootstrap interval over that type's questions (2,000 resamples, seed 1).`,
    "",
    `| Question type | Questions | ${groups.map((g) => `${g.about.system} Recall@5`).join(" | ")} |`,
    `|---|---:|${groups.map(() => "---:").join("|")}|`,
  ];
  for (const type of types) {
    const cells = groups.map((g) => {
      const xs = records.filter((r) => r.group === g.name && r.tags.type === type).map((r) => (r.correct.recallAt5 as number | null) ?? 0);
      const ci = bootstrapMean(xs);
      const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      return `${m.toFixed(3)}${ci ? ` (${ci[0].toFixed(2)} to ${ci[1].toFixed(2)})` : ""}`;
    });
    const n = records.filter((r) => r.group === groups[0].name && r.tags.type === type).length;
    lines.push(`| ${type} | ${n} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

async function booksTable(groups: string[]): Promise<string> {
  const run = (await runs("books")).at(-1);
  if (!run) return "_No clean run of books yet._";
  const lines = [
    `Run \`${path.relative(ROOT, run.dir)}\` (commit \`${run.meta.git.commit.slice(0, 7)}\`).`,
    "",
    "| Group | Questions | Answer found | With context | Note listed | MRR | Tokens (mean) | Search ms (mean) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const name of groups) {
    const s = run.summary[name];
    if (!s) throw new Error(`books run ${run.id} has no group ${name}`);
    const t = run.timings.groups[name] ?? {};
    lines.push(`| ${name} | ${fmt(s.questions)} | ${pctCell(s.foundPct)} | ${pctCell(s.evidencePct)} | ${pctCell(s.goldListedPct)} | ${fmt(s.mrr)} | ${fmt(s.tokensMean)} | ${fmt(t.msMean, 1)} |`);
  }
  return lines.join("\n");
}

interface TokenSummary {
  quickChatTokens: number;
  answerableLookups: number;
  answered: number;
  answeredBySearchAlone: number;
}

// The README's short-chat table. "Answered" by search alone is the realistic measure; the row after it assumes the
// AI then opens the right listed note, which the benchmark knows and an AI does not, so it is an upper bound.
async function tokensTable(files: string[]): Promise<string> {
  const sets = await Promise.all(
    files.map(async (f) => {
      const results = JSON.parse(await readFile(path.join(BENCH, "results", `${f}.json`), "utf8")) as { variant: string; style: string; summary: TokenSummary }[];
      const pick = (variant: string) => {
        const r = results.find((x) => x.variant === variant && x.style === "keyword");
        if (!r) throw new Error(`${f}.json has no ${variant} keyword result`);
        return r.summary;
      };
      return { paste: pick("fullcontext"), old: pick("baseline"), current: pick("current") };
    }),
  );
  const n = (v: number) => v.toLocaleString("en-US");
  const saving = (a: number, b: number) => `${a < b ? "\u2212" : "+"}${Math.abs((100 * (a - b)) / b).toFixed(1)}%`;
  const row = (label: string, cells: string[]) => `| ${label} | ${cells.join(" | ")} |`;
  return [
    `| A short chat | ${files.map((_, i) => `Set ${i + 1}`).join(" | ")} |`,
    `|---|${files.map(() => "---:").join("|")}|`,
    row("Paste every note", sets.map((s) => `${n(s.paste.quickChatTokens)} tokens`)),
    row("Old server", sets.map((s) => n(s.old.quickChatTokens))),
    row("**This server**", sets.map((s) => `**${n(s.current.quickChatTokens)}**`)),
    row("Saving against pasting every note", sets.map((s) => saving(s.current.quickChatTokens, s.paste.quickChatTokens))),
    row("Saving against the old server", sets.map((s) => saving(s.current.quickChatTokens, s.old.quickChatTokens))),
    row("Answer in this server's search results", sets.map((s) => `${s.current.answeredBySearchAlone} of ${s.current.answerableLookups}`)),
    row("... if the AI then opens the right listed note (upper bound)", sets.map((s) => `${s.current.answered} of ${s.current.answerableLookups}`)),
  ].join("\n");
}

async function generate(spec: string): Promise<string> {
  const [kind, ...args] = spec.trim().split(/\s+/);
  if (kind === "retrieval") return retrievalTable(args[0], args[1]);
  if (kind === "retrieval-by") return breakdownTable(args[0], args[1], args[2]);
  if (kind === "books") return booksTable(args);
  if (kind === "tokens") return tokensTable(args);
  throw new Error(`unknown generated block: ${spec}`);
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const files = [path.join(ROOT, "README.md"), path.join(ROOT, "RAG_RESULTS.md"), ...(await readdir(path.join(ROOT, "docs"))).filter((f) => f.endsWith(".md")).map((f) => path.join(ROOT, "docs", f))];
  let stale = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const blocks = [...text.matchAll(/<!-- generated: ([^>]*) -->\n([\s\S]*?)<!-- \/generated -->/g)];
    if (blocks.length === 0) continue;
    let out = text;
    for (const block of blocks) {
      const fresh = `<!-- generated: ${block[1]} -->\n${await generate(block[1])}\n<!-- /generated -->`;
      if (fresh !== block[0]) {
        stale++;
        if (check) console.log(`stale: ${path.relative(ROOT, file)} (${block[1]})`);
        out = out.replace(block[0], fresh);
      }
    }
    if (!check && out !== text) {
      await writeFile(file, out);
      console.log(`updated ${path.relative(ROOT, file)}`);
    }
  }
  if (check && stale) {
    console.log(`${stale} generated block(s) differ from the run folders. Run: npx tsx bench/report.ts`);
    process.exit(1);
  }
  if (check) console.log("Every generated table matches the run folders.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
