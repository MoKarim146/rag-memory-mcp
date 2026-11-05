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
//   books <group> [<group> ...]     the latest clean run of bench/runs/books/: one row per named group
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
  meta: { config: Record<string, unknown>; plan: { name: string; about: Record<string, unknown> }[]; git: { commit: string } };
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

const fmt = (v: unknown, digits = 3) => (v === null || v === undefined ? "" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(digits)) : String(v));
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
    `Run \`${path.relative(ROOT, run.dir)}\` (commit \`${run.meta.git.commit.slice(0, 7)}\`). Recall@5 interval: 95% bootstrap over questions (2,000 resamples, seed 1).`,
    "",
    `| System | Results | Questions | Recall@5 | Recall@5, 95% interval | Recall@10 | nDCG@10 | MRR | Evidence shown | Answer present |${hasDistractors ? " Distractor first |" : ""} Without vectors | Tokens (mean) | Search ms (mean) | Index ms (mean) |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|${hasDistractors ? "---:|" : ""}---:|---:|---:|---:|`,
  ];
  for (const group of run.meta.plan) {
    const s = run.summary[group.name] ?? {};
    const t = run.timings.groups[group.name] ?? {};
    const about = group.about;
    const system = `${about.system}${group.name.endsWith("/abstention") ? " (no-answer questions)" : ""}`;
    const cold = t.indexMsMean ?? run.timings.other[`${about.system}/coldStartMs`];
    const ci = group.name.endsWith("/abstention") ? null : bootstrapMean(recall5(byGroup.get(group.name) ?? []));
    lines.push(
      `| ${system} | ${about.limit} | ${fmt(s.questions)} | ${fmt(s.recallAt5)} | ${interval(ci)} | ${fmt(s.recallAt10)} | ${fmt(s.ndcgAt10)} | ${fmt(s.mrr)} | ${pctCell(s.evidenceShownPct)} | ${pctCell(s.answerPresentPct)} |${hasDistractors ? ` ${pctCell(s.distractorFirstPct)} |` : ""} ${fmt(s.embeddingFailed ?? "")} | ${fmt(s.tokensMean)} | ${fmt(t.msMean, 1)} | ${fmt(cold, 0)} |`,
    );
  }
  // Paired differences from keyword search, on the same questions and number of results.
  const diffs: string[] = [];
  for (const group of run.meta.plan) {
    const about = group.about;
    if (about.system === "bm25" || group.name.endsWith("/abstention")) continue;
    const base = run.meta.plan.find((g) => g.about.system === "bm25" && g.about.limit === about.limit && !g.name.endsWith("/abstention"));
    if (!base) continue;
    const mine = new Map((byGroup.get(group.name) ?? []).map((r) => [r.id, (r.correct.recallAt5 as number | null) ?? 0]));
    const theirs = new Map((byGroup.get(base.name) ?? []).map((r) => [r.id, (r.correct.recallAt5 as number | null) ?? 0]));
    const ids = [...mine.keys()].filter((id) => theirs.has(id)).sort();
    if (ids.length < 2) continue;
    const d = bootstrapPairedDifference(ids.map((id) => mine.get(id)!), ids.map((id) => theirs.get(id)!));
    diffs.push(`| ${about.system} minus bm25 | ${about.limit} | ${ids.length} | ${d.mean >= 0 ? "+" : ""}${d.mean.toFixed(3)} | ${interval(d.interval)} |`);
  }
  if (diffs.length) {
    lines.push("", "| Recall@5 difference | Results | Same questions | Mean | 95% interval |", "|---|---:|---:|---:|---:|", ...diffs);
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

async function generate(spec: string): Promise<string> {
  const [kind, ...args] = spec.trim().split(/\s+/);
  if (kind === "retrieval") return retrievalTable(args[0], args[1]);
  if (kind === "books") return booksTable(args);
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
