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
//   needles <benchmark>             planted facts from the latest clean run of bench/runs/<benchmark>/: one row per book and
//                                   system, by how the question was worded
//   tokens <file> [<file> ...]      the token benchmark's committed results (bench/results/<file>.json, written by
//                                   bench/run.ts): a short chat per test set, with keyword searches
//   tokens-overview <file> ...      the same files: short chat, every question in one chat, answers found
//   tokens-detail <file> ...        the same files: where the tokens go, old server against this server
//   tokens-quality <file> ...       the same files: answers found (realistic and upper bound), rank, full questions
//   tokens-ngram <file> ...         the same files: every question in one chat, with and without ngram vectors
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

async function needlesTable(benchmark: string): Promise<string> {
  const run = (await runs(benchmark)).at(-1);
  if (!run) return `_No clean run of ${benchmark} yet._`;
  type Group = { found: number; questions: number; tokensMean: number; by_overlap: Record<string, { found: number; questions: number }> };
  const group = (scope: string, system: string, style: string) => run.summary[`${scope}/${system}/needles/${style}/limit-5`] as unknown as Group | undefined;
  const names: Record<string, string> = { current: "keyword search", "current-ollama": "keywords and vectors (hybrid)", "current-ngram": "keywords and ngram vectors" };
  const lines = [
    `Run \`${path.relative(ROOT, run.dir)}\` (commit \`${run.meta.git.commit.slice(0, 7)}\`). Found: the fact reached the AI in the results of one search (5 results). First search: building the index, and for vectors embedding the whole book.`,
    "",
    "| Book | Search | Words from the fact | Reworded, keeps a name | No word in common | Tokens per search (reworded) | First search s |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];
  const scopes = [...new Set(run.meta.plan.map((g) => String(g.about.scope)))];
  for (const scope of scopes) {
    for (const system of [...new Set(run.meta.plan.filter((g) => g.about.scope === scope).map((g) => String(g.about.system)))]) {
      const kw = group(scope, system, "keyword");
      const q = group(scope, system, "question");
      if (!kw || !q) continue;
      const cell = (key: string) => (q.by_overlap[key] ? `${q.by_overlap[key].found}/${q.by_overlap[key].questions}` : "");
      const first = run.timings.other[`${scope}/${system}/firstSearchMs`] as number | undefined;
      lines.push(
        `| ${scope.replace(/-chapters$/, "")} | ${names[system] ?? system} | ${kw.found}/${kw.questions} | ${cell("name")} | ${cell("none")} | ${fmt(kw.tokensMean)} (${fmt(q.tokensMean)}) | ${first === undefined ? "" : (first / 1000).toFixed(1)} |`,
      );
    }
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

interface TokenResult {
  variant: string;
  style: string;
  definitions: { modelFacingTokens: number; instructionsTokens: number };
  summary: TokenSummary & { readingTokens: number; startTokens: number; lookupResultTokens: number; sessionTotalTokens: number; meanReciprocalRank: number; startAnswersCovered: number };
}

async function tokenSets(files: string[]) {
  return Promise.all(
    files.map(async (f) => {
      const results = JSON.parse(await readFile(path.join(BENCH, "results", `${f}.json`), "utf8")) as TokenResult[];
      return (variant: string, style = "keyword") => {
        const r = results.find((x) => x.variant === variant && x.style === style);
        if (!r) throw new Error(`${f}.json has no ${variant} ${style} result`);
        return r;
      };
    }),
  );
}

const n0 = (v: number) => v.toLocaleString("en-US");
const change = (a: number, b: number) => `${a < b ? "\u2212" : "+"}${Math.abs((100 * (a - b)) / b).toFixed(1)}%`;

// The smallest value of each column in bold.
function block(rows: [string, number[]][]): string[] {
  const min = rows[0][1].map((_, i) => Math.min(...rows.map(([, v]) => v[i])));
  return rows.map(([label, v]) => `| ${label} | ${v.map((x, i) => (x === min[i] ? `**${n0(x)}**` : n0(x))).join(" | ")} |`);
}

async function tokensOverview(files: string[]): Promise<string> {
  const sets = await tokenSets(files);
  const cols = files.map((_, i) => `Set ${i + 1}`);
  const empty = ` ${files.map(() => "|").join(" ")}`;
  const of = (s: TokenSummary, key: "answeredBySearchAlone" | "answered") => `${s[key]} of ${s.answerableLookups}`;
  const row = (label: string, cells: string[]) => `| ${label} | ${cells.join(" | ")} |`;
  return [
    `| Keyword searches | ${cols.join(" | ")} |`,
    `|---|${files.map(() => "---:").join("|")}|`,
    `| **A short chat** (start summary and 3 searches) |${empty}`,
    ...block([
      ["Paste every note", sets.map((g) => g("fullcontext").summary.quickChatTokens)],
      ["Old server", sets.map((g) => g("baseline").summary.quickChatTokens)],
      ["This server", sets.map((g) => g("current").summary.quickChatTokens)],
    ]),
    `| **Every question in one chat** |${empty}`,
    ...block([
      ["Paste every note", sets.map((g) => g("fullcontext").summary.readingTokens)],
      ["Old server", sets.map((g) => g("baseline").summary.readingTokens)],
      ["This server", sets.map((g) => g("current").summary.readingTokens)],
    ]),
    `| **Answer in what the AI reads** (realistic: the search result alone) |${empty}`,
    row("Paste every note", sets.map((g) => of(g("fullcontext").summary, "answered"))),
    row("Old server", sets.map((g) => of(g("baseline").summary, "answeredBySearchAlone"))),
    row("This server", sets.map((g) => of(g("current").summary, "answeredBySearchAlone"))),
    `| **With an ideal follow-up read** (upper bound, see below) |${empty}`,
    row("Old server", sets.map((g) => of(g("baseline").summary, "answered"))),
    row("This server", sets.map((g) => of(g("current").summary, "answered"))),
  ].join("\n");
}

async function tokensDetail(files: string[]): Promise<string> {
  const sets = await tokenSets(files);
  const pairs = sets.map((g) => [g("baseline"), g("current")] as const);
  const cells = (f: (r: TokenResult) => number, bold = false) => pairs.flatMap(([o, c]) => [o, c].map((r) => (bold ? `**${n0(f(r))}**` : n0(f(r)))));
  const row = (label: string, v: string[]) => `| ${label} | ${v.join(" | ")} |`;
  return [
    `| What the AI reads | ${files.map((_, i) => `Set ${i + 1} old | Set ${i + 1} new`).join(" | ")} |`,
    `|---|${files.map(() => "---:|---:").join("|")}|`,
    row("Tool descriptions + instructions", cells((r) => r.definitions.modelFacingTokens + r.definitions.instructionsTokens)),
    row("Start-of-chat summary", cells((r) => r.summary.startTokens)),
    row("All searches and reads", cells((r) => r.summary.lookupResultTokens)),
    row("**Every question in one chat**", cells((r) => r.summary.readingTokens, true)),
    row("Change", pairs.flatMap(([o, c]) => ["", change(c.summary.readingTokens, o.summary.readingTokens)])),
    row("Whole session, with 4 writes and the AI's own arguments", cells((r) => r.summary.sessionTotalTokens)),
  ].join("\n");
}

async function tokensQuality(files: string[]): Promise<string> {
  const sets = await tokenSets(files);
  const cells = (f: (o: TokenResult, c: TokenResult) => [string, string]) => sets.flatMap((g) => f(g("baseline"), g("current")));
  const of = (r: TokenResult, key: "answeredBySearchAlone" | "answered") => `${r.summary[key]}/${r.summary.answerableLookups}`;
  const row = (label: string, v: string[]) => `| ${label} | ${v.join(" | ")} |`;
  const q = (variant: string, g: (typeof sets)[number]) => g(variant, "question");
  return [
    `| | ${files.map((_, i) => `Set ${i + 1} old | Set ${i + 1} new`).join(" | ")} |`,
    `|---|${files.map(() => "---:|---:").join("|")}|`,
    row("Found by the search alone (realistic)", cells((o, c) => [of(o, "answeredBySearchAlone"), of(c, "answeredBySearchAlone")])),
    row("Found with an ideal follow-up read (upper bound)", cells((o, c) => [of(o, "answered"), of(c, "answered")])),
    row("Mean reciprocal rank", cells((o, c) => [o.summary.meanReciprocalRank.toFixed(3), c.summary.meanReciprocalRank.toFixed(3)])),
    row("Answers already in the start summary", cells((o, c) => [String(o.summary.startAnswersCovered), String(c.summary.startAnswersCovered)])),
    row("Full questions: found by the search alone (realistic)", sets.flatMap((g) => [of(q("baseline", g), "answeredBySearchAlone"), of(q("current", g), "answeredBySearchAlone")])),
    row("Full questions: with an ideal follow-up read (upper bound)", sets.flatMap((g) => [of(q("baseline", g), "answered"), of(q("current", g), "answered")])),
    row("Full questions: every question in one chat", sets.flatMap((g) => [n0(q("baseline", g).summary.readingTokens), n0(q("current", g).summary.readingTokens)])),
  ].join("\n");
}

async function tokensNgram(files: string[]): Promise<string> {
  const sets = await tokenSets(files);
  const row = (label: string, variant: string, style: string) => `| ${label} | ${sets.map((g) => n0(g(variant, style).summary.readingTokens)).join(" | ")} |`;
  return [
    `| Every question in one chat | ${files.map((_, i) => `Set ${i + 1}`).join(" | ")} |`,
    `|---|${files.map(() => "---:").join("|")}|`,
    row("Keywords only", "current", "keyword"),
    row("Keywords + ngram, keyword searches", "current-ngram", "keyword"),
    row("Keywords only, full questions", "current", "question"),
    row("Keywords + ngram, full questions", "current-ngram", "question"),
  ].join("\n");
}

async function generate(spec: string): Promise<string> {
  const [kind, ...args] = spec.trim().split(/\s+/);
  if (kind === "retrieval") return retrievalTable(args[0], args[1]);
  if (kind === "retrieval-by") return breakdownTable(args[0], args[1], args[2]);
  if (kind === "books") return booksTable(args);
  if (kind === "tokens") return tokensTable(args);
  if (kind === "tokens-overview") return tokensOverview(args);
  if (kind === "tokens-detail") return tokensDetail(args);
  if (kind === "tokens-quality") return tokensQuality(args);
  if (kind === "tokens-ngram") return tokensNgram(args);
  if (kind === "needles") return needlesTable(args[0]);
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
