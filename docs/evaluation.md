# Retrieval evaluation on outside datasets

This page compares four ways of searching on two public datasets that this project did not write, BEIR SciFact
(scientific claims and abstracts) and LongMemEval-S (questions about long chat histories), and on this project's
own frozen paraphrase set (questions worded unlike the note that answers them). It asks one question:
**does the right evidence reach the AI, and at what cost?** It does not measure whether an AI then answers
correctly; that needs a model and is described under "Not measured".

Every table between `generated` markers is produced from run folders by `bench/report.ts`; CI fails if one differs
from the records (`npx tsx bench/report.ts --check`). How runs are recorded and checked: [benchmarks.md](benchmarks.md).

## The four systems

All four answer through the real MCP server and its `search_memory` tool, on the same notes, the same chunking
(sections of up to 800 characters, passages of up to 400) and the same output budget: the best result shows up to
450 characters, the others up to 180, at most 2 results per note, 5 or 10 results per search.

| System | What ranks the results |
|---|---|
| `bm25` | Keywords only: SQLite FTS5 with BM25, the default when no embedding model is set |
| `dense` | Vectors only (`RAG_RETRIEVAL=dense`): cosine similarity of one vector per passage |
| `hybrid` | Both, merged by reciprocal rank fusion (`RAG_RETRIEVAL=hybrid`, the default when a model is set) |
| `old` | The original project before this work, as a historical baseline. It only finds the exact text typed, so it is searched with the query's rarest word; a whole question finds nothing |

Queries are the dataset's own text, unchanged: no rewriting, and nothing from the gold answers is used.

The embedding model is `all-MiniLM-L6-v2` (384 dimensions, no query or document prefix), the model Ollama ships as
`all-minilm`. Here it was served by `bench/tools/ollama_compatible.py`, a stand-in for Ollama's `/api/embed` that
runs the same weights in ONNX form, pinned by SHA-256 (`bench/tools/fetch-minilm.sh`). Ollama itself runs a GGUF
conversion of these weights, so its vectors can differ slightly.

**Caution: the model has probably seen SciFact's documents.** Its model card (revision `1110a24`) lists, among
its 1 billion training pairs, S2ORC title-abstract pairs and S2ORC citation pairs, and SciFact's abstracts come
from S2ORC. It was also trained on SQuAD 2.0's training questions. Dense and hybrid results on SciFact may
therefore be better than on text the model has never seen. LongMemEval's chat histories are not in that list.

## Datasets and splits

| Dataset | Searched notes | Queries | Relevance | Split used here | Role |
|---|---|---|---|---|---|
| BEIR SciFact | 5,183 abstracts, one note each (title as heading) | scientific claims | BEIR's labels: the abstracts the claim cites | BEIR test (300 claims) | evaluation |
| | | | | BEIR train (809 claims) | development only, not reported |
| LongMemEval-S (cleaned, Sept. 2025) | each question's own chat history: about 53 sessions, one note per session, with its date | questions about the history | the sessions that hold the answer (`answer_session_ids`) | evaluation (402 questions) | evaluation |
| | | | | evaluation-dense (101 of the 402) | evaluation, for dense and hybrid |
| | | | | development (98) | development only, not reported |
| Paraphrase set (this project) | 138 notes: each group's target and distractor note, and the 90 notes of the three fake test vaults as filler | 4 questions per group, written unlike the target (lexical, synonym, low-overlap, negation, date) | the target note | evaluation (16 groups, 64 questions) | evaluation |
| | | | | development (8 groups) | development only, not reported |

- **SciFact** was rebuilt from the original release because BEIR's own files could not be downloaded here. For all
  300 test claims BEIR's relevant documents are exactly the claim's `cited_doc_ids` in the release, so the
  relevance labels are BEIR's own (pinned revision `2938d17`).
- **LongMemEval-S** splits were frozen before any evaluation run (`bench/eval/splits/longmemeval-s.json`, commit
  `1de3db4`): stratified by question type and by no-answer (`_abs`) questions, seed 2026. Embedding every session of
  402 histories takes hours on one CPU core, so dense and hybrid run on a fixed quarter of the evaluation split
  (101 questions, same strata); bm25 runs on it too, for a matched comparison.
- **What the server never sees:** relevance labels, answers and LongMemEval's `has_answer` turn labels stay in the
  gold data. Notes hold only the documents, and the original document and session ids are kept in the note paths
  so results map back to them exactly.
- **No-answer questions** (LongMemEval `_abs`, 30 of 500) are left out of the retrieval measures, as LongMemEval
  does, and shown separately.
- **Paraphrase set** (`bench/paraphrase/set.json`, SHA-256 `6109fe2a…`; splits `bench/paraphrase/splits.json`,
  SHA-256 `ce529848…`, both unchanged since commit `5ab78b7`): 24 groups, each a target note that answers, a distractor
  note that shares its topic and words but does not answer, and four questions. Every question was written and
  reviewed against rules that `bench/paraphrase/check.ts` checks (for example, a low-overlap question shares no
  content word with its target) before the set was frozen. The split into 8 development and 16 evaluation groups
  was frozen before any run (seed 2027), with each group's questions kept together.

Licenses: SciFact claims CC BY 4.0, abstracts ODC-By 1.0; BEIR labels CC BY-SA 4.0; LongMemEval MIT; the paraphrase
set and the filler notes were written for this repository (MIT). Files, revisions
and SHA-256 sums: `bench/eval/data.ts`, and in each run's `meta.json`.

## Measures

For each query, the documents of the results are taken in order, each counted once at its first place.

- **Recall@k**: the share of the relevant documents among the first k. A cut-off beyond the number of results asked
  for is left empty, not guessed.
- **nDCG@10**: rewards relevant documents near the top (only for 10 results).
- **MRR**: 1 divided by the place of the first relevant document, averaged.
- **Distractor first** (paraphrase set): the distractor note is ranked above the target, or shown while the target
  is not.
- **Evidence shown** (LongMemEval): the output holds 8 consecutive words of a turn labelled `has_answer`, so the
  evidence itself, not only its session, reached the AI.
- **Answer present** (LongMemEval): the reference answer appears word for word. Most LongMemEval answers are free
  text, so this undercounts heavily; it is shown for completeness, not as a quality score.
- **Tokens**: the whole tool answer, counted with `o200k_base`.
- **Search ms**: one search after the index is built. **Index ms**: building the index (and, for dense and
  hybrid, embedding every passage) before the first search: once for SciFact's shared corpus, once per question
  for LongMemEval, where every question has its own history.

Timings are from one run on the reference machine ([benchmarks.md](benchmarks.md)) with the search pinned to two
cores and the model on two others. They are not compared between runs. The model server embeds identical texts only
once, and hybrid runs after dense on the same notes, so hybrid's index time reuses dense's vectors and is lower than
a first build: **the cost of embedding is dense's index time.** Search times include embedding the query, which
for hybrid was also already cached from the dense run, so hybrid's search times are slightly flattered too.

## Results

### BEIR SciFact, test split (300 claims)

<!-- generated: retrieval eval-scifact test -->
Run `bench/runs/eval-scifact/20261105T055421Z-1bd2c4b` (commit `1bd2c4b`). Recall@5 interval: 95% bootstrap over questions (2,000 resamples, seed 1). Warm search: one search once the index is built. Cold start: building the index, with embedding for dense and hybrid. Memory: growth of the benchmark process's resident memory while the index was built, a rough reading that garbage collection can make negative.

| System | Results | Questions | Recall@5 | Recall@5, 95% interval | Recall@10 | nDCG@10 | MRR | Evidence shown | Answer present | Without vectors | Tokens (mean) | Warm search ms (mean) | Cold start ms (mean) | Memory MB (rough) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bm25 | 5 | 300 | 0.707 | 0.659 to 0.754 |  |  | 0.624 |  |  | 0 | 390 | 272.3 | 6,179 | 53 |
| bm25 | 10 | 300 | 0.720 | 0.671 to 0.768 | 0.750 | 0.655 | 0.632 |  |  | 0 | 649 | 273.6 | 6,179 | 53 |
| old | 5 | 300 | 0.410 | 0.353 to 0.464 |  |  | 0.313 |  |  |  | 1,080 | 1,937.9 | 2,028 | 0.5 |
| old | 10 | 300 | 0.410 | 0.353 to 0.464 | 0.480 | 0.349 | 0.313 |  |  |  | 1,080 | 1,950.9 | 2,028 | 0.5 |
| dense | 5 | 300 | 0.719 | 0.669 to 0.770 |  |  | 0.629 |  |  | 0 | 359 | 459.4 | 517,816 | 173.6 |
| dense | 10 | 300 | 0.738 | 0.692 to 0.787 | 0.753 | 0.660 | 0.636 |  |  | 0 | 647 | 454.4 | 517,816 | 173.6 |
| hybrid | 5 | 300 | 0.765 | 0.717 to 0.810 |  |  | 0.677 |  |  | 0 | 418 | 481.1 | 17,257 | 99.8 |
| hybrid | 10 | 300 | 0.806 | 0.762 to 0.847 | 0.818 | 0.712 | 0.687 |  |  | 0 | 762 | 481.4 | 17,257 | 99.8 |

Index: bm25 5,188 notes, 27,691 passages, 0 vectors; dense 5,188 notes, 27,691 passages, 27,691 vectors; hybrid 5,188 notes, 27,691 passages, 27,691 vectors. The notes include the server's five main notes, which it creates with only a heading.

Paired differences on the same questions (95% bootstrap interval of the mean difference, 2,000 resamples, seed 1). An interval that includes 0 means the difference may be chance.

| Difference | Results | Same questions | Recall@5 | Recall@5, 95% interval | MRR | MRR, 95% interval |
|---|---:|---:|---:|---:|---:|---:|
| dense minus bm25 | 5 | 300 | +0.012 | -0.035 to 0.059 | +0.005 | -0.038 to 0.048 |
| hybrid minus bm25 | 5 | 300 | +0.058 | 0.030 to 0.089 | +0.053 | 0.027 to 0.079 |
| hybrid minus dense | 5 | 300 | +0.046 | 0.011 to 0.083 | +0.048 | 0.017 to 0.079 |
| old minus bm25 | 5 | 300 | -0.297 | -0.356 to -0.238 | -0.311 | -0.358 to -0.263 |
| dense minus bm25 | 10 | 300 | +0.018 | -0.026 to 0.063 | +0.003 | -0.039 to 0.044 |
| hybrid minus bm25 | 10 | 300 | +0.085 | 0.056 to 0.117 | +0.054 | 0.030 to 0.079 |
| hybrid minus dense | 10 | 300 | +0.067 | 0.035 to 0.101 | +0.051 | 0.022 to 0.082 |
| old minus bm25 | 10 | 300 | -0.310 | -0.368 to -0.251 | -0.319 | -0.366 to -0.272 |
<!-- /generated -->

### LongMemEval-S, evaluation split (402 questions), keyword search and the old server

<!-- generated: retrieval eval-longmemeval-s evaluation -->
Run `bench/runs/eval-longmemeval-s/20261105T063532Z-1bd2c4b` (commit `1bd2c4b`). Recall@5 interval: 95% bootstrap over questions (2,000 resamples, seed 1). Warm search: one search once the index is built. Cold start: building the index, with embedding for dense and hybrid. Memory: growth of the benchmark process's resident memory while the index was built, a rough reading that garbage collection can make negative.

| System | Results | Questions | Recall@5 | Recall@5, 95% interval | Recall@10 | nDCG@10 | MRR | Evidence shown | Answer present | Without vectors | Tokens (mean) | Warm search ms (mean) | Cold start ms (mean) | Memory MB (rough) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bm25 | 5 | 377 | 0.852 | 0.823 to 0.881 |  |  | 0.875 | 72.7% | 31.8% | 0 | 340 | 32.9 | 165 | 0 |
| bm25 (no-answer questions) | 5 | 25 | 0.790 |  |  |  | 0.890 | 55.6% | 0% | 0 | 332 | 24.2 | 162 | 0 |
| bm25 | 10 | 377 | 0.864 | 0.835 to 0.892 | 0.890 | 0.848 | 0.877 | 74.8% | 33.4% | 0 | 438 | 33.2 |  | 0 |
| bm25 (no-answer questions) | 10 | 25 | 0.803 |  | 0.813 | 0.783 | 0.890 | 55.6% | 0% | 0 | 458 | 26.2 |  | 0 |
| old | 5 | 377 | 0.589 | 0.548 to 0.628 |  |  | 0.638 | 63.1% | 29.4% |  | 860 | 26.3 | 28 | -0.2 |
| old (no-answer questions) | 5 | 25 | 0.570 |  |  |  | 0.637 | 55.6% | 0% |  | 914 | 27.8 | 28 | -0.2 |
| old | 10 | 377 | 0.589 | 0.548 to 0.628 | 0.608 | 0.563 | 0.638 | 63.1% | 29.4% |  | 860 | 27 |  | -0.2 |
| old (no-answer questions) | 10 | 25 | 0.570 |  | 0.570 | 0.520 | 0.637 | 55.6% | 0% |  | 914 | 27 |  | -0.2 |

Paired differences on the same questions (95% bootstrap interval of the mean difference, 2,000 resamples, seed 1). An interval that includes 0 means the difference may be chance.

| Difference | Results | Same questions | Recall@5 | Recall@5, 95% interval | MRR | MRR, 95% interval |
|---|---:|---:|---:|---:|---:|---:|
| old minus bm25 | 5 | 377 | -0.263 | -0.307 to -0.220 | -0.237 | -0.286 to -0.192 |
| old minus bm25 | 10 | 377 | -0.274 | -0.317 to -0.233 | -0.239 | -0.287 to -0.195 |
<!-- /generated -->

<!-- generated: retrieval-by eval-longmemeval-s evaluation 5 -->
Recall@5 by question type, 5 results per search, same run. 95% bootstrap interval over that type's questions (2,000 resamples, seed 1).

| Question type | Questions | bm25 Recall@5 | old Recall@5 |
|---|---:|---:|---:|
| knowledge-update | 58 | 0.940 (0.90 to 0.97) | 0.724 (0.62 to 0.82) |
| multi-session | 97 | 0.804 (0.75 to 0.85) | 0.460 (0.39 to 0.53) |
| single-session-assistant | 45 | 1.000 (1.00 to 1.00) | 0.778 (0.64 to 0.89) |
| single-session-preference | 24 | 0.583 (0.38 to 0.79) | 0.583 (0.38 to 0.79) |
| single-session-user | 51 | 0.961 (0.90 to 1.00) | 0.882 (0.78 to 0.96) |
| temporal-reasoning | 102 | 0.793 (0.73 to 0.85) | 0.407 (0.34 to 0.47) |
<!-- /generated -->

### LongMemEval-S, evaluation-dense subset (101 questions), all three ranking methods

<!-- generated: retrieval eval-longmemeval-s evaluation-dense -->
_No clean run of eval-longmemeval-s (evaluation-dense) yet._
<!-- /generated -->

<!-- generated: retrieval-by eval-longmemeval-s evaluation-dense 5 -->
_No clean run of eval-longmemeval-s (evaluation-dense) yet._
<!-- /generated -->

### Paraphrase set, evaluation split (16 groups, 64 questions)

<!-- generated: retrieval eval-paraphrase evaluation -->
Run `bench/runs/eval-paraphrase/20261105T055359Z-1bd2c4b` (commit `1bd2c4b`). Recall@5 interval: 95% bootstrap over questions (2,000 resamples, seed 1). Warm search: one search once the index is built. Cold start: building the index, with embedding for dense and hybrid. Memory: growth of the benchmark process's resident memory while the index was built, a rough reading that garbage collection can make negative.

| System | Results | Questions | Recall@5 | Recall@5, 95% interval | Recall@10 | nDCG@10 | MRR | Evidence shown | Answer present | Distractor first | Without vectors | Tokens (mean) | Warm search ms (mean) | Cold start ms (mean) | Memory MB (rough) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bm25 | 5 | 64 | 0.422 | 0.297 to 0.547 |  |  | 0.404 |  | 42.2% | 4.7% | 0 | 133 | 21 | 170 | 8.8 |
| bm25 | 10 | 64 | 0.422 | 0.297 to 0.547 | 0.422 | 0.408 | 0.404 |  | 42.2% | 4.7% | 0 | 155 | 22.1 | 170 | 8.8 |
| dense | 5 | 64 | 0.656 | 0.547 to 0.766 |  |  | 0.633 |  | 65.6% | 3.1% | 0 | 85 | 25.1 | 499 | 19.2 |
| dense | 10 | 64 | 0.656 | 0.547 to 0.766 | 0.656 | 0.639 | 0.633 |  | 65.6% | 3.1% | 0 | 96 | 24.4 | 499 | 19.2 |
| hybrid | 5 | 64 | 0.719 | 0.609 to 0.828 |  |  | 0.571 |  | 71.9% | 4.7% | 0 | 165 | 24.7 | 455 | -6.7 |
| hybrid | 10 | 64 | 0.719 | 0.609 to 0.828 | 0.719 | 0.609 | 0.571 |  | 71.9% | 4.7% | 0 | 205 | 25.7 | 455 | -6.7 |
| old | 5 | 64 | 0.328 | 0.219 to 0.438 |  |  | 0.279 |  | 35.9% | 4.7% |  | 339 | 66.3 | 65 | 0.5 |
| old | 10 | 64 | 0.328 | 0.219 to 0.438 | 0.344 | 0.293 | 0.279 |  | 35.9% | 4.7% |  | 339 | 67 | 65 | 0.5 |

Index: bm25 143 notes, 652 passages, 0 vectors; dense 143 notes, 652 passages, 652 vectors; hybrid 143 notes, 652 passages, 652 vectors. The notes include the server's five main notes, which it creates with only a heading.

Paired differences on the same questions (95% bootstrap interval of the mean difference, 2,000 resamples, seed 1). An interval that includes 0 means the difference may be chance.

| Difference | Results | Same questions | Recall@5 | Recall@5, 95% interval | MRR | MRR, 95% interval |
|---|---:|---:|---:|---:|---:|---:|
| dense minus bm25 | 5 | 64 | +0.234 | 0.109 to 0.375 | +0.229 | 0.104 to 0.354 |
| hybrid minus bm25 | 5 | 64 | +0.297 | 0.188 to 0.406 | +0.167 | 0.102 to 0.238 |
| hybrid minus dense | 5 | 64 | +0.063 | 0.016 to 0.125 | -0.062 | -0.150 to 0.027 |
| old minus bm25 | 5 | 64 | -0.094 | -0.172 to -0.031 | -0.125 | -0.208 to -0.050 |
| dense minus bm25 | 10 | 64 | +0.234 | 0.109 to 0.375 | +0.229 | 0.104 to 0.354 |
| hybrid minus bm25 | 10 | 64 | +0.297 | 0.188 to 0.406 | +0.167 | 0.102 to 0.238 |
| hybrid minus dense | 10 | 64 | +0.063 | 0.016 to 0.125 | -0.062 | -0.150 to 0.027 |
| old minus bm25 | 10 | 64 | -0.094 | -0.172 to -0.031 | -0.125 | -0.208 to -0.050 |
<!-- /generated -->

<!-- generated: retrieval-by eval-paraphrase evaluation 5 -->
Recall@5 by question type, 5 results per search, same run. 95% bootstrap interval over that type's questions (2,000 resamples, seed 1).

| Question type | Questions | bm25 Recall@5 | dense Recall@5 | hybrid Recall@5 | old Recall@5 |
|---|---:|---:|---:|---:|---:|
| date | 8 | 0.375 (0.13 to 0.75) | 0.250 (0.00 to 0.63) | 0.500 (0.13 to 0.88) | 0.125 (0.00 to 0.38) |
| lexical | 16 | 1.000 (1.00 to 1.00) | 1.000 (1.00 to 1.00) | 1.000 (1.00 to 1.00) | 0.875 (0.69 to 1.00) |
| low-overlap | 16 | 0.000 (0.00 to 0.00) | 0.313 (0.06 to 0.56) | 0.313 (0.06 to 0.56) | 0.000 (0.00 to 0.00) |
| negation | 8 | 0.750 (0.38 to 1.00) | 0.875 (0.63 to 1.00) | 1.000 (1.00 to 1.00) | 0.625 (0.25 to 0.88) |
| synonym | 16 | 0.125 (0.00 to 0.31) | 0.750 (0.50 to 0.94) | 0.813 (0.56 to 1.00) | 0.063 (0.00 to 0.19) |
<!-- /generated -->

## Not measured

- **Whether an AI answers correctly** with these results. That needs a model, a fixed prompt and a budget; the
  harness for it is described in [agent-evaluation.md](agent-evaluation.md).
- **Other embedding models** (for example `nomic-embed-text`, the server's default Ollama model). Only
  all-MiniLM-L6-v2 was available here.
- **Reranking.** No reranking model was evaluated.
- **The development splits** were not used to tune anything in this round, so no development results are reported.
