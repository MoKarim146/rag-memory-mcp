// Freezes the LongMemEval-S splits before any evaluation is run. Deterministic: the same data and seed give the
// same split. Writes bench/eval/splits/longmemeval-s.json, which is committed and must not change afterwards.
//
//   npx tsx bench/eval/make-splits.ts
//
// - development (20%): for trying changes;
// - evaluation (80%): reported, never used to choose a setting;
// - evaluation-dense (100 of the evaluation questions): the subset used for dense and hybrid runs, because
//   embedding every session of 400 questions takes hours on one CPU core.
// Each split keeps the share of every question type and of the no-answer (_abs) questions.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seededShuffle } from "../books.js";
import { fetchPinned, longMemEvalS, EVAL_SOURCES } from "./data.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = 2026;

const items = longMemEvalS(await fetchPinned(path.join(HERE, "..", ".cache", "eval"), "longmemevalS"));
const strata = new Map<string, string[]>();
for (const { query } of items) {
  const key = `${query.type}${query.abstention ? " (abstention)" : ""}`;
  strata.set(key, [...(strata.get(key) ?? []), query.id]);
}
const development: string[] = [];
const evaluation: string[] = [];
const evaluationDense: string[] = [];
for (const [key, ids] of [...strata.entries()].sort()) {
  const shuffled = seededShuffle([...ids].sort(), SEED);
  const dev = Math.round(shuffled.length * 0.2);
  development.push(...shuffled.slice(0, dev));
  const evalIds = shuffled.slice(dev);
  evaluation.push(...evalIds);
  evaluationDense.push(...seededShuffle(evalIds, SEED + 1).slice(0, Math.round(evalIds.length / 4)));
  console.log(`${key}: ${ids.length} -> development ${dev}, evaluation ${evalIds.length}`);
}
const out = {
  about: "Frozen before any evaluation run. Do not edit; a new split needs a new file and a note in docs/evaluation.md.",
  source: { url: EVAL_SOURCES.longmemevalS.url, sha256: EVAL_SOURCES.longmemevalS.sha256 },
  method: "Stratified by question_type and by abstention (_abs ids); seeded shuffle of the sorted ids; 20% development, 80% evaluation; evaluation-dense is a seeded quarter of each stratum of evaluation.",
  seed: SEED,
  counts: { development: development.length, evaluation: evaluation.length, evaluationDense: evaluationDense.length },
  development: development.sort(),
  evaluation: evaluation.sort(),
  evaluationDense: evaluationDense.sort(),
};
await writeFile(path.join(HERE, "splits", "longmemeval-s.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(out.counts);
