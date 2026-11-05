// Recomputes every number of a benchmark run from its per-query records, without running retrieval again.
//
//   npm run bench:verify                       every run under bench/runs/
//   npm run bench:verify -- <run folder> ...   only these
//   add --tokens to also recount every answer's tokens (slower)
//
// For each run it checks that: meta.json, queries.jsonl.br, summary.json, timings.json and tables.md exist; every
// record belongs to a planned group and no query id repeats within a group; every planned group has exactly its
// planned number of records; each record's correctness, recomputed from the answer it stored and its gold
// evidence, matches what was recorded; and summary.json, the per-group times and tables.md equal what the records
// give. Any difference is listed and the command exits with status 1.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";
import { agentCalls, readRecords, shownOf, summarise, tablesMarkdown, type RunMeta } from "./lib/runs.js";
import { judge, judgeAgent, judgeRetrieval } from "./lib/scoring.js";

const BENCH = path.dirname(fileURLToPath(import.meta.url));

async function runFolders(base: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(base)) return out;
  for (const benchmark of await readdir(base, { withFileTypes: true })) {
    if (!benchmark.isDirectory()) continue;
    for (const run of await readdir(path.join(base, benchmark.name), { withFileTypes: true })) {
      if (run.isDirectory()) out.push(path.join(base, benchmark.name, run.name));
    }
  }
  return out.sort();
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function verifyRun(dir: string, recountTokens = false): Promise<string[]> {
  const problems: string[] = [];
  for (const file of ["meta.json", "queries.jsonl.br", "summary.json", "timings.json", "tables.md"]) {
    if (!existsSync(path.join(dir, file))) problems.push(`missing ${file}`);
  }
  if (problems.length) return problems;

  const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as RunMeta;
  const records = await readRecords(dir);
  const planned = new Map(meta.plan.map((g) => [g.name, g.queries]));
  const seen = new Map<string, Set<string>>();
  const encoder = recountTokens ? getEncoding("o200k_base") : undefined;
  let wrongJudgement = 0;
  let wrongTokens = 0;
  for (const r of records) {
    if (!planned.has(r.group)) problems.push(`record ${r.id} is in group ${r.group}, which is not in the plan`);
    const ids = seen.get(r.group) ?? new Set<string>();
    if (ids.has(r.id)) problems.push(`query ${r.id} appears twice in ${r.group}`);
    ids.add(r.id);
    seen.set(r.group, ids);
    const shown = shownOf(r.output, r.retrieved);
    const again =
      r.kind === "agent"
        ? judgeAgent(r.output, agentCalls(r), { expect: r.gold.expect ?? "answer", answers: r.gold.answers ?? [], wrong: r.gold.wrong, sources: r.gold.sources ?? [], canary: r.gold.canary })
        : r.kind === "retrieval"
        ? judgeRetrieval(r.output, shown.map((s, i) => ({ doc: r.retrieved[i].doc ?? "", text: s.text })), { relevant: r.gold.relevant ?? {}, answers: r.gold.answers, evidenceTurns: r.gold.evidenceTurns, distractors: r.gold.distractors }, r.k ?? 5)
        : judge(r.output, shown, { answers: r.gold.answers ?? [], evidence: r.gold.evidence, chunk: r.gold.chunk, book: r.gold.book });
    if (r.error === null && !same(again, r.correct)) {
      wrongJudgement++;
      if (wrongJudgement <= 5) problems.push(`${r.group} ${r.id}: recorded correctness differs from the answer it stored`);
    }
    // Agent records count what the memory tools returned; the others count the whole tool answer.
    if (encoder) {
      const counted = r.kind === "agent" ? agentCalls(r).reduce((sum, c) => sum + encoder.encode(c.output).length, 0) : encoder.encode(r.output).length;
      if (counted !== r.tokens) wrongTokens++;
    }
  }
  if (wrongJudgement > 5) problems.push(`... ${wrongJudgement} records in total with differing correctness`);
  if (wrongTokens) problems.push(`${wrongTokens} records whose token count differs from a recount`);
  for (const [group, count] of planned) {
    const got = seen.get(group)?.size ?? 0;
    if (got !== count) problems.push(`${group}: ${got} records, the plan says ${count}`);
  }

  const { summary, times } = summarise(meta.plan, records);
  const storedSummary = JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8"));
  for (const group of Object.keys({ ...summary, ...storedSummary })) {
    if (!same(summary[group], storedSummary[group])) problems.push(`summary.json differs for ${group}`);
  }
  const storedTimes = JSON.parse(await readFile(path.join(dir, "timings.json"), "utf8"));
  if (!same(times, storedTimes.groups)) problems.push("timings.json per-group times differ from the records");
  const tables = tablesMarkdown(meta, summary as Record<string, Record<string, unknown>>, times as Record<string, Record<string, unknown>>);
  if (tables !== (await readFile(path.join(dir, "tables.md"), "utf8"))) problems.push("tables.md differs from the tables the records give");
  return problems;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recount = args.includes("--tokens");
  const given = args.filter((a) => !a.startsWith("--"));
  const dirs = given.length ? given.map((d) => path.resolve(d)) : await runFolders(path.join(BENCH, "runs"));
  if (dirs.length === 0) {
    console.error("No runs to verify.");
    process.exit(1);
  }
  let failed = 0;
  for (const dir of dirs) {
    const problems = await verifyRun(dir, recount);
    const name = path.relative(process.cwd(), dir);
    if (problems.length) {
      failed++;
      console.log(`FAIL ${name}`);
      for (const p of problems) console.log(`  - ${p}`);
    } else {
      console.log(`ok   ${name}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} of ${dirs.length} runs failed verification.`);
    process.exit(1);
  }
  console.log(`\nAll ${dirs.length} runs verified.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
