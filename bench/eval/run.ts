// Retrieval evaluation on outside datasets, with the same run records as the other benchmarks.
//
//   npx tsx bench/eval/run.ts scifact [--split test|train] [--systems bm25,old] [--quick 50]
//   npx tsx bench/eval/run.ts longmemeval-s [--split evaluation|development|evaluation-dense] [--systems ...]
//
// Systems, all through the real MCP server and its search_memory tool, on the same notes, chunking and output
// budget (5 or 10 results):
//   bm25     this server, keyword search only (SQLite FTS5 BM25)
//   dense    this server, vectors only (RAG_RETRIEVAL=dense; needs an embedding model, see below)
//   hybrid   this server, keywords and vectors merged (RAG_RETRIEVAL=hybrid)
//   old      the original project before this work, searched with the query's rarest word (it only matches the
//            exact text typed, so a whole question finds nothing); a historical baseline
//
// dense and hybrid use RAG_EMBEDDINGS=ollama at 127.0.0.1:11434 with RAG_OLLAMA_MODEL (default all-minilm). Without
// Ollama, bench/tools/ollama_compatible.py serves the same model (pinned in bench/tools/fetch-minilm.sh). Set
// RAG_EVAL_MODEL_NOTE to describe what served the model; it is saved in meta.json.
//
// Queries are the dataset's own text, unchanged: no rewriting, and nothing from the gold answers.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, runQueries, seededShuffle, systemEnv, warmUp, writeVault, type Query, type Server, type System } from "../books.js";
import { RunWriter, quality, shownOf, timings, type QueryRecord } from "../lib/runs.js";
import { judgeRetrieval } from "../lib/scoring.js";
import { EVAL_SOURCES, fetchPinned, longMemEvalS, sciFact, type EvalDoc, type EvalQuery } from "./data.js";

process.env.TZ = "UTC";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.join(HERE, "..");
const CACHE = path.join(BENCH, ".cache", "eval");

type SystemName = "bm25" | "dense" | "hybrid" | "old";
const SYSTEMS: Record<SystemName, { system: System; env: Record<string, string>; about: string }> = {
  bm25: { system: "current", env: { RAG_RETRIEVAL: "keyword" }, about: "this server, keyword search only (FTS5 BM25)" },
  dense: { system: "current-ollama", env: { RAG_RETRIEVAL: "dense" }, about: "this server, vectors only" },
  hybrid: { system: "current-ollama", env: { RAG_RETRIEVAL: "hybrid" }, about: "this server, keywords and vectors merged (reciprocal rank fusion)" },
  old: { system: "baseline", env: {}, about: "the original project, searched with the query's rarest word" },
};
const LIMITS = [5, 10];

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function rarestWord(text: string, df: Map<string, number>): string {
  let best = words(text)[0] ?? text;
  let bestDf = Infinity;
  for (const w of words(text)) {
    const f = df.get(w) ?? 0;
    if (w.length > 2 && f > 0 && f < bestDf) {
      best = w;
      bestDf = f;
    }
  }
  return best;
}

function docFrequency(docs: EvalDoc[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(words(d.text))) df.set(w, (df.get(w) ?? 0) + 1);
  return df;
}

function toQuery(q: EvalQuery, system: SystemName, df: Map<string, number>): Query {
  return {
    id: q.id,
    query: system === "old" ? rarestWord(q.text, df) : q.text,
    answers: q.answers ?? [],
    tags: { ...(q.type ? { type: q.type } : {}), ...(q.abstention !== undefined ? { abstention: String(q.abstention) } : {}) },
  };
}

// Turns runQueries' answer record into a retrieval record: each result is mapped to its dataset document id
// and judged with the standard retrieval measures.
function asRetrieval(record: QueryRecord, q: EvalQuery, docOf: Map<string, string>, k: number): QueryRecord {
  const shown = shownOf(record.output, record.retrieved);
  const retrieved = record.retrieved.map((r) => ({ ...r, doc: docOf.get(r.path) ?? `unknown:${r.path}` }));
  const gold = { relevant: q.relevant, ...(q.answers ? { answers: q.answers } : {}), ...(q.evidenceTurns ? { evidenceTurns: q.evidenceTurns } : {}) };
  return {
    ...record,
    kind: "retrieval",
    k,
    gold,
    retrieved,
    correct: judgeRetrieval(record.output, shown.map((s, i) => ({ doc: retrieved[i].doc, text: s.text })), gold, k),
  };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dataset = process.argv[2];
  if (dataset !== "scifact" && dataset !== "longmemeval-s") {
    console.error("usage: npx tsx bench/eval/run.ts scifact|longmemeval-s [--split ...] [--systems bm25,dense,hybrid,old] [--quick N]");
    process.exit(2);
  }
  const systems = (argValue("--systems") ?? "bm25,old").split(",") as SystemName[];
  const quick = argValue("--quick") ? Number(argValue("--quick")) : undefined;
  const started = Date.now();
  const modelNote = process.env.RAG_EVAL_MODEL_NOTE ?? null;
  const usesModel = systems.some((s) => s === "dense" || s === "hybrid");

  // Each item: one query and the notes it is searched in (one shared corpus for SciFact, one history per question
  // for LongMemEval).
  let split: string;
  let items: { query: EvalQuery; docs: EvalDoc[]; shared: boolean }[];
  let dataFacts: Record<string, unknown>;
  if (dataset === "scifact") {
    split = argValue("--split") ?? "test";
    const data = sciFact(
      await fetchPinned(CACHE, "scifactRelease"),
      await fetchPinned(CACHE, "scifactQrelsTest"),
      await fetchPinned(CACHE, "scifactQrelsTrain"),
    );
    const queries = split === "test" ? data.test : split === "train" ? data.train : undefined;
    if (!queries) throw new Error("SciFact splits: test (evaluation), train (development)");
    items = queries.map((query) => ({ query, docs: data.docs, shared: true }));
    dataFacts = { documents: data.docs.length, sources: ["scifactRelease", split === "test" ? "scifactQrelsTest" : "scifactQrelsTrain"] };
  } else {
    split = argValue("--split") ?? "evaluation";
    const splits = JSON.parse(await readFile(path.join(HERE, "splits", "longmemeval-s.json"), "utf8")) as Record<string, string[]>;
    const key = split === "evaluation-dense" ? "evaluationDense" : split;
    if (!Array.isArray(splits[key])) throw new Error("LongMemEval-S splits: evaluation, development, evaluation-dense");
    const wanted = new Set(splits[key]);
    items = longMemEvalS(await fetchPinned(CACHE, "longmemevalS"))
      .filter((it) => wanted.has(it.query.id))
      .map((it) => ({ ...it, shared: false }));
    dataFacts = { sources: ["longmemevalS"], splitFile: "bench/eval/splits/longmemeval-s.json", meanSessionsPerQuestion: Math.round(items.reduce((s, it) => s + it.docs.length, 0) / Math.max(1, items.length)) };
  }
  if (quick) items = seededShuffle(items, 3).slice(0, quick);
  // LongMemEval leaves its no-answer (_abs) questions out of retrieval measures; they get their own group.
  const groupOf = (system: SystemName, k: number, q: EvalQuery) => `${dataset}/${split}/${system}/limit-${k}${q.abstention ? "/abstention" : ""}`;

  const plan = new Map<string, { name: string; queries: number; about: Record<string, unknown>; breakdowns?: string[] }>();
  for (const system of systems) {
    for (const k of LIMITS) {
      for (const it of items) {
        const name = groupOf(system, k, it.query);
        const entry = plan.get(name) ?? {
          name,
          queries: 0,
          about: {
            dataset,
            split,
            system,
            systemAbout: SYSTEMS[system].about,
            limit: k,
            ...(it.query.abstention ? { note: "No-answer questions: LongMemEval leaves them out of retrieval measures; shown for tokens and answer presence only." } : {}),
          },
          ...(dataset === "longmemeval-s" ? { breakdowns: ["type"] } : {}),
        };
        entry.queries++;
        plan.set(name, entry);
      }
    }
  }

  const writer = await RunWriter.start(path.join(BENCH, ".."), path.join(BENCH, "runs"), `eval-${dataset}${quick ? "-quick" : ""}`, {
    config: {
      about: "Retrieval evaluation (bench/eval/run.ts) through the MCP server's search_memory tool. Queries are the dataset's text, unchanged.",
      dataset,
      split,
      quick: quick ?? null,
      quickSeed: quick ? 3 : null,
      limits: LIMITS,
      systems: Object.fromEntries(systems.map((s) => [s, { about: SYSTEMS[s].about, env: systemEnv(SYSTEMS[s].system, "<vault>", SYSTEMS[s].env) }])),
      embeddingModel: usesModel ? { ollamaModel: process.env.RAG_OLLAMA_MODEL || "all-minilm", note: modelNote, formatting: "none (all-minilm takes no query or document prefix)" } : null,
      tokenizer: "o200k_base",
      timeZone: process.env.TZ,
    },
    data: {
      dataset,
      split,
      sources: Object.fromEntries(Object.entries(EVAL_SOURCES).map(([k, s]) => [k, { url: s.url, sha256: s.sha256, about: s.about, license: s.license }])),
      ...dataFacts,
    },
    plan: [...plan.values()],
  });

  const base = await mkdtemp(path.join(os.tmpdir(), `eval-${dataset}-`));
  const timingFacts: Record<string, unknown> = {};
  const facts: Record<string, unknown> = {};
  const { closeMemoryIndex, getMemoryIndex } = await import(pathToFileURL(path.join(BENCH, "..", "src", "retrieval", "memoryIndex.ts")).href);
  const { getMemoryConfig } = await import(pathToFileURL(path.join(BENCH, "..", "src", "memory.ts")).href);
  let embeddingErrors = 0;
  try {
    for (const system of systems) {
      const spec = SYSTEMS[system];
      let shared: { server: Server; docOf: Map<string, string>; df: Map<string, number> } | undefined;
      const rss: number[] = [];
      for (const [i, it] of items.entries()) {
        let server: Server;
        let docOf: Map<string, string>;
        let df: Map<string, number>;
        let indexMs: number | undefined;
        const vault = path.join(base, system, it.shared ? "shared" : String(i));
        if (it.shared && shared) {
          ({ server, docOf, df } = shared);
        } else {
          await writeVault(vault, it.docs);
          docOf = new Map(it.docs.map((d) => [d.path, d.id]));
          df = docFrequency(it.docs);
          const before = process.memoryUsage().rss;
          server = await connect(spec.system, vault, spec.env);
          indexMs = await warmUp(server);
          rss.push(process.memoryUsage().rss - before);
          if (spec.system !== "baseline") {
            const stats = getMemoryIndex(getMemoryConfig(systemEnv(spec.system, vault, spec.env))).stats();
            if (it.shared) facts[`${system}/index`] = stats;
            if (usesModel && spec.system === "current-ollama" && stats.vectors < stats.passages) embeddingErrors++;
          }
          if (it.shared) {
            shared = { server, docOf, df };
            timingFacts[`${system}/coldStartMs`] = Math.round(indexMs * 10) / 10;
            indexMs = undefined;
          }
        }
        for (const k of LIMITS) {
          const [record] = await runQueries(server, [toQuery(it.query, system, df)], k, groupOf(system, k, it.query));
          const r = asRetrieval(record, it.query, docOf, k);
          if (indexMs !== undefined && k === LIMITS[0]) r.indexMs = Math.round(indexMs * 10) / 10;
          writer.record(r);
        }
        if (!it.shared) {
          await server.close();
          if (spec.system !== "baseline") closeMemoryIndex(getMemoryConfig(systemEnv(spec.system, vault, spec.env)));
          await rm(vault, { recursive: true, force: true });
        }
        if ((i + 1) % 50 === 0) console.log(`${system}: ${i + 1}/${items.length}`);
      }
      if (shared) await shared.server.close();
      timingFacts[`${system}/rssGrowthMBMean`] = rss.length ? Math.round(rss.reduce((s, x) => s + x, 0) / rss.length / 1e5) / 10 : null;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  facts.embeddingIncomplete = embeddingErrors;
  timingFacts.minutes = Math.round((Date.now() - started) / 6000) / 10;
  const { summary } = await writer.finish(facts, timingFacts);
  for (const [group, s] of Object.entries(summary as Record<string, ReturnType<typeof quality>>)) {
    const q = s as Record<string, unknown>;
    console.log(`${group.padEnd(60)} R@5 ${q.recallAt5} R@10 ${q.recallAt10} nDCG@10 ${q.ndcgAt10} MRR ${q.mrr} answer ${q.answerPresentPct ?? ""} tokens ${q.tokensMean}${q.errors ? ` ERRORS ${q.errors}` : ""}`);
  }
  void timings;
  console.log(`\nWrote ${path.relative(process.cwd(), writer.dir)}. Check it with: npm run bench:verify -- ${path.relative(process.cwd(), writer.dir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
