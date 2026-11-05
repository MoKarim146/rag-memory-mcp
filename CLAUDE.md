# CLAUDE.md

Guidance for AI coding agents working in this repository.

## What this is

An MCP server (TypeScript, Node.js 22.13+) that serves a folder of markdown notes as shared memory for several
AI assistants. It cuts tokens with local search (SQLite FTS5 through `node:sqlite`, optional embeddings) and
treats every note as untrusted input. No note leaves the computer through this server.

## Commands

```bash
npm ci --ignore-scripts      # install
npm run build                # compile to dist/
npm run typecheck            # src only
npm run typecheck:all        # src, bench, examples and tests (vitest and tsx do not check types)
npm test                     # build + fast tests (tests/*.test.ts)
npm run test:heavy           # fuzz and stress tests (tests/heavy/), a few minutes
npm run bench                # token benchmark on set 1 (npm run bench -- --set holdout, or --set test3)
npm run charts               # redraw docs/charts/*.svg from bench/results and security/
npm run bench:books          # real books and 10,570 SQuAD questions, one run folder (bench:books:quick: 200)
npm run bench:verify         # recompute every committed run from its per-query records
npm run bench:smoke          # free CI check: set 1 through the record-and-verify pipeline
npx tsx bench/report.ts      # rewrite the generated tables in the docs from the runs (--check: compare only, CI)
npx tsx bench/eval/run.ts paraphrase|scifact|longmemeval-s --split ... --systems bm25,dense,hybrid,old
npm run bench:agent:dry      # agent evaluation plumbing with a scripted stand-in model (free, CI)
npm run demo                 # the HTTP server on a copy of bench/agent/test-vault, with checks (CI)
npm run audit                # npm audit, production packages, high and above
```

Run one test file: `npx vitest run tests/retrieval.test.ts`.

## Layout

- `src/index.ts`: startup; loads `.env`, reads settings, starts HTTP.
- `src/httpServer.ts`: Streamable HTTP transport, Host and Origin checks, token login, session limits.
- `src/mcpServer.ts`: the 8 tools, their descriptions, rate limits and output format.
- `src/memory.ts`: settings, safe paths, reads, and every write (`guardedWrite`).
- `src/safety.ts`: `prepareNoteText` (hidden text, secrets, personal data, injection flags) and
  `findWriteProblem`.
- `src/context.ts`: the short start-of-chat summary.
- `src/format.ts`: `<note>` blocks and the data notice.
- `src/retrieval/`: `chunker.ts` (sections and passages), `memoryIndex.ts` (FTS5 index, ranking, snippets),
  `embeddings.ts` (optional `ngram` or loopback-only Ollama vectors).
- `bench/`: benchmark (`run.ts`), scale test (`scale.ts`), long-text benchmark on real books (`books.ts`,
  `books-data.ts`), charts (`charts.ts`), three fake vaults with their task files, and saved results in
  `bench/results/`.
- `bench/lib/`: run folders (`runs.ts`), judging (`scoring.ts`), bootstrap intervals (`stats.ts`).
  `bench/verify.ts` recomputes runs; `bench/report.ts` writes the docs' generated tables.
- `bench/eval/`: outside datasets (SciFact, LongMemEval-S) and their frozen splits. `bench/paraphrase/`: the
  frozen paraphrase set, its rule checker and splits. `bench/agent/`: the optional agent evaluation, its questions
  and test vault. `bench/tools/`: the stand-in embedding server for benchmarks.
- `security/`: test results before and after each round of fixes.
- `skills/rag-memory/SKILL.md`: an Agent Skill that teaches an assistant how to use the server.

## Rules that must keep holding

1. Every note text that is indexed or returned goes through `prepareNoteText`. Never return raw file text.
2. Every write goes through `guardedWrite`. Do not add another write path or any delete tool.
3. Paths go through the existing path checks: inside the memory folder only, markdown only, no symlinks out,
   no hidden folders, never `AI Review/`.
4. Tool results that contain note text start with `DATA_NOTICE` and wrap text with `noteBlock`.
5. No network calls except the optional Ollama embedder, which must stay loopback-only. No telemetry.
6. Tool descriptions and server instructions are sent in every chat. Keep them short; the benchmark reports
   their size (`definitions` in each result file).
7. A new security rule starts with a failing test. Save results before and after the fix in `security/`.

## Benchmark honesty

- Tune search changes on set 1 (`bench/tasks.json`) and set 2 (`bench/holdout-tasks.json`) only. Set 3
  (`bench/test3-tasks.json`) is for reporting: run it once at the end, never tune on it. The same goes for the long-text
  benchmark (`bench/books.ts`): it reports, it is not a tuning set.
- `tests/quality.test.ts` fails if a change loses answers or adds more than 5% tokens on sets 1 and 2. Do not
  loosen it without writing the reason in `RAG_RESULTS.md`.
- Evaluation splits (SciFact test, LongMemEval-S evaluation, paraphrase evaluation groups, the agent questions)
  are frozen and never used to choose a setting; only development splits may be used for tuning. Default settings
  are not chosen from evaluation scores.
- Never edit result files by hand; regenerate them. Report numbers exactly as measured, including anything that
  got worse. Published numbers come from clean run folders (`bench/runs/`, not `-dirty`) that pass
  `npm run bench:verify`; see docs/benchmarks.md.

## Writing docs

- Plain English, short sentences, technically correct. Explain a term the first time it appears.
- Numbers only from files in `bench/results/`, `bench/runs/` or `security/`. Tables between `<!-- generated -->`
  markers come from `bench/report.ts`; never edit them by hand. Label results that assume the AI picks the right
  note (the benchmark's ideal follow-up read) as an upper bound.
- Project content only: no personal notes in the repository.
- Only fake notes in the repository. Never commit a real vault, `.env`, tokens or tunnel addresses.
- Credits stay as written in the README: Codex wrote the original project; the owner designed, directed and
  tested it; Claude Code added this version's work.

## Commits

Prefixes in use: `feat`, `fix`, `test`, `bench`, `docs`, `chore`. CI (`.github/workflows/ci.yml`) runs typecheck,
tests, heavy tests and `npm audit` on every push; its actions are pinned by commit SHA.
