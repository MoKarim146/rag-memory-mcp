// Run records: every benchmark run gets its own folder, so each published number can be traced to the exact
// code, data, settings and per-query results that produced it, and recomputed without running anything again.
//
//   bench/runs/<benchmark>/<UTC time>-<commit>[-dirty]/
//     meta.json         what ran: commit, uncommitted files, machine, Node, settings, seeds, data checksums and
//                       licenses, and the plan (how many queries each group must have)
//     queries.jsonl.br  one line per query (Brotli: `brotli -dc queries.jsonl.br`, or bench/lib/runs.ts readRecords): the query, gold evidence, what was retrieved (chunk ids, text, ranks,
//                       scores), whether it was correct, tokens, time and any error
//     summary.json      quality numbers per group. Deterministic: the same code and data give the same numbers
//     timings.json      times per group. They vary between runs and machines, so they are kept apart
//     tables.md         the tables, generated from summary.json and timings.json
//
// `npm run bench:verify` recomputes summary.json and tables.md from queries.jsonl.br and fails if a record is
// missing, a group has the wrong number of queries, or any number differs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { constants, createBrotliCompress, createBrotliDecompress, type BrotliCompress } from "node:zlib";

export interface Retrieved {
  rank: number; // 1-based place in what the tool returned
  chunk: string; // stable id: "path#section" for this server, "path:line" for the old server
  path: string;
  heading?: string;
  span?: [number, number]; // where this result's text is in the record's output (start, end)
  text?: string; // the result's text, stored only when it is not a verbatim part of the output
  fusedRank?: number;
  bm25?: number | null;
  vector?: number | null;
  matchedPassages?: number[];
  vectorPassage?: number | null;
}

export interface QueryRecord {
  group: string;
  id: string;
  query: string;
  gold: {
    answers: string[];
    evidence?: string[]; // answer with its neighbouring words in the source
    chunk?: string; // the note that holds the answer
    book?: string; // for book-level questions
    pasteTokenEnd?: number; // token count, in paste order, at the end of the paragraph that holds the answer
  };
  tags: Record<string, string>;
  output: string; // the whole tool answer the AI received
  retrieved: Retrieved[];
  correct: {
    found: boolean;
    evidence: boolean | null;
    goldListed: boolean | null;
    rank: number; // first result containing an answer, 0 if none
    topRightBook: boolean | null;
    rightBookShare: number | null;
  };
  tokens: number; // tokens of the whole tool answer (o200k_base)
  ms: number; // time of the tool call
  error: string | null;
}

// Each result's text, exactly as the AI was shown it.
export function shownOf(output: string, retrieved: Retrieved[]): { path: string; text: string }[] {
  return retrieved.map((r) => ({ path: r.path, text: r.span ? output.slice(r.span[0], r.span[1]) : (r.text ?? "") }));
}

export interface GroupPlan {
  name: string;
  queries: number;
  about: Record<string, unknown>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? round1((100 * part) / whole) : 0);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Quality numbers for a list of records. Used both when a run is written and when it is verified, so the two
// can only differ if the records changed.
export function quality(records: QueryRecord[]) {
  const n = records.length;
  const count = (f: (r: QueryRecord) => boolean | null) => records.filter((r) => f(r) === true).length;
  const has = (f: (r: QueryRecord) => unknown) => records.some((r) => f(r) !== null);
  return {
    questions: n,
    errors: records.filter((r) => r.error !== null).length,
    found: count((r) => r.correct.found),
    foundPct: pct(count((r) => r.correct.found), n),
    evidencePct: has((r) => r.correct.evidence) ? pct(count((r) => r.correct.evidence), n) : null,
    goldListedPct: has((r) => r.correct.goldListed) ? pct(count((r) => r.correct.goldListed), n) : null,
    topRightBookPct: has((r) => r.correct.topRightBook) ? pct(count((r) => r.correct.topRightBook), n) : null,
    rightBookSharePct: has((r) => r.correct.rightBookShare)
      ? round1((100 * records.reduce((s, r) => s + (r.correct.rightBookShare ?? 0), 0)) / n)
      : null,
    mrr: Math.round((1000 * records.reduce((s, r) => s + (r.correct.rank ? 1 / r.correct.rank : 0), 0)) / Math.max(1, n)) / 1000,
    tokensMean: Math.round(records.reduce((s, r) => s + r.tokens, 0) / Math.max(1, n)),
    tokensMedian: percentile(records.map((r) => r.tokens), 50),
    tokensP90: percentile(records.map((r) => r.tokens), 90),
  };
}

export function timings(records: QueryRecord[]) {
  const ms = records.map((r) => r.ms);
  return { msMean: round1(ms.reduce((s, x) => s + x, 0) / Math.max(1, ms.length)), msP95: round1(percentile(ms, 95)) };
}

export function qualityBy(records: QueryRecord[], tag: string) {
  const groups = new Map<string, QueryRecord[]>();
  for (const r of records) {
    const key = r.tags[tag] ?? "other";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, rs]) => {
        const q = quality(rs);
        return [key, { questions: q.questions, found: q.found, foundPct: q.foundPct, evidencePct: q.evidencePct }];
      }),
  );
}

// Share of questions whose answer paragraph fits in the first N tokens of everything pasted in path order.
export function truncationRecall(records: QueryRecord[], windows: number[]) {
  return windows.map((window) => ({
    window,
    pct: pct(records.filter((r) => (r.gold.pasteTokenEnd ?? Infinity) <= window).length, records.length),
  }));
}

export interface GroupSpec {
  breakdowns?: string[]; // tags to break the quality numbers down by
  truncationWindows?: number[];
}

// Everything in summary.json is derived from the records by this function.
export function summarise(plan: (GroupPlan & GroupSpec)[], records: QueryRecord[]) {
  const byGroup = new Map<string, QueryRecord[]>();
  for (const r of records) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  const summary: Record<string, unknown> = {};
  const times: Record<string, unknown> = {};
  for (const group of plan) {
    const rs = byGroup.get(group.name) ?? [];
    const entry: Record<string, unknown> = { ...quality(rs) };
    for (const tag of group.breakdowns ?? []) entry[`by_${tag}`] = qualityBy(rs, tag);
    if (group.truncationWindows) entry.pasteTruncation = truncationRecall(rs, group.truncationWindows);
    summary[group.name] = entry;
    times[group.name] = timings(rs);
  }
  return { summary, times };
}

export function tablesMarkdown(meta: RunMeta, summary: Record<string, Record<string, unknown>>, times: Record<string, Record<string, unknown>>): string {
  const lines = [
    `# ${meta.benchmark} run ${meta.runId}`,
    "",
    `Generated from queries.jsonl.br by bench/lib/runs.ts. Commit ${meta.git.commit}${meta.git.dirty ? " with uncommitted changes" : ""}.`,
    "",
    "| Group | Questions | Errors | Answer found | With context | Note listed | MRR | Tokens mean | Tokens p90 | ms mean | ms p95 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const show = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  for (const group of meta.plan) {
    const s = summary[group.name] ?? {};
    const t = times[group.name] ?? {};
    lines.push(
      `| ${group.name} | ${show(s.questions)} | ${show(s.errors)} | ${show(s.foundPct)}% | ${s.evidencePct === null ? "" : `${show(s.evidencePct)}%`} | ${s.goldListedPct === null ? "" : `${show(s.goldListedPct)}%`} | ${show(s.mrr)} | ${show(s.tokensMean)} | ${show(s.tokensP90)} | ${show(t.msMean)} | ${show(t.msP95)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------

export interface RunMeta {
  benchmark: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  git: { commit: string; dirty: boolean; dirtyFiles: string[] };
  environment: Record<string, unknown>;
  config: Record<string, unknown>;
  data: Record<string, unknown>;
  plan: (GroupPlan & GroupSpec)[];
  facts?: Record<string, unknown>; // numbers about the inputs (for example tokens if everything is pasted)
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function gitState() {
  const dirtyFiles = git(["status", "--porcelain"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  return { commit: git(["rev-parse", "HEAD"]) || "unknown", dirty: dirtyFiles.length > 0, dirtyFiles };
}

export function environment(root: string): Record<string, unknown> {
  let cpuAffinity: string | undefined;
  try {
    cpuAffinity = /Cpus_allowed_list:\s*(\S+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
  } catch {
    cpuAffinity = undefined;
  }
  let lockSha256: string | undefined;
  try {
    lockSha256 = createHash("sha256").update(readFileSync(path.join(root, "package-lock.json"))).digest("hex");
  } catch {
    lockSha256 = undefined;
  }
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    cpuAffinity,
    memoryGB: round1(os.totalmem() / 1e9),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    TZ: process.env.TZ ?? null,
    packageLockSha256: lockSha256,
  };
}

export class RunWriter {
  readonly dir: string;
  readonly meta: RunMeta;
  // Records are kept in memory and compressed only when the run finishes: compressing while searches are timed
  // would compete with them for the CPU (reference runs are pinned to one core) and inflate the timings.
  private readonly records: QueryRecord[] = [];

  private constructor(dir: string, meta: RunMeta) {
    this.dir = dir;
    this.meta = meta;
  }

  static async start(root: string, base: string, benchmark: string, fields: Omit<RunMeta, "benchmark" | "runId" | "startedAt" | "git" | "environment">) {
    const state = gitState();
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${state.commit.slice(0, 7)}${state.dirty ? "-dirty" : ""}`;
    const dir = path.join(base, benchmark, runId);
    await mkdir(dir, { recursive: true });
    const meta: RunMeta = { benchmark, runId, startedAt, git: state, environment: environment(root), ...fields };
    await writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    return new RunWriter(dir, meta);
  }

  record(r: QueryRecord): void {
    this.records.push(r);
  }

  // facts: deterministic numbers about the inputs. timingFacts: measured times that are not per query (cold
  // start, index build); they go to timings.json with the per-group times.
  async finish(
    facts: Record<string, unknown> = {},
    timingFacts: Record<string, unknown> = {},
  ): Promise<{ summary: Record<string, unknown>; times: Record<string, unknown> }> {
    // Brotli at its highest level with a 16 MB window: answers repeat across groups, and the records are committed
    // to the repository (about 3 times smaller than gzip on this data).
    const brotli: BrotliCompress = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } });
    const file: WriteStream = createWriteStream(path.join(this.dir, "queries.jsonl.br"));
    brotli.pipe(file);
    await new Promise<void>((resolve, reject) => {
      file.on("finish", resolve).on("error", reject);
      for (const r of this.records) brotli.write(`${JSON.stringify(r)}\n`);
      brotli.end();
    });
    this.meta.finishedAt = new Date().toISOString();
    this.meta.facts = facts;
    await writeFile(path.join(this.dir, "meta.json"), `${JSON.stringify(this.meta, null, 2)}\n`);
    const { summary, times } = summarise(this.meta.plan, this.records);
    await writeFile(path.join(this.dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(path.join(this.dir, "timings.json"), `${JSON.stringify({ groups: times, other: timingFacts }, null, 2)}\n`);
    await writeFile(
      path.join(this.dir, "tables.md"),
      tablesMarkdown(this.meta, summary as Record<string, Record<string, unknown>>, times as Record<string, Record<string, unknown>>),
    );
    return { summary, times };
  }
}

export async function readRecords(dir: string): Promise<QueryRecord[]> {
  const out: QueryRecord[] = [];
  const lines = createInterface({ input: createReadStream(path.join(dir, "queries.jsonl.br")).pipe(createBrotliDecompress()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) out.push(JSON.parse(line) as QueryRecord);
  }
  return out;
}
