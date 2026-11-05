# RAG results: tokens before and after

Every number here comes from a saved result file in `bench/results/`, produced by the scripts in `bench/`.
Nothing is estimated; percentages are rounded to one decimal. Where something got worse, it says so.

## The short version

| | Test set 1 (used for tuning) | Test set 2 (held out, never used for tuning) |
|---|---:|---:|
| Old server, whole session | 13,286 tokens | 10,392 tokens |
| New server, whole session | 9,329 tokens | 9,252 tokens |
| **Change** | **−29.8%** | **−11.0%** |
| Lookups answered, old → new | 23/24 → 24/24 | 30/31 → 31/31 |

Read the right-hand column as the realistic one. Set 1 is the one the search settings were tuned on, so its
saving is flattering. Set 2 was written later and never used for tuning. Its saving is smaller but honest.

## What was measured, in plain words

- **Two fake vaults.** Set 1 (`bench/fixture-vault/`): an online ordering app for a bakery, 32 notes. Set 2
  (`bench/holdout-vault/`): a volunteer app for a community garden, 24 notes, using Obsidian features set 1
  lacks: front matter, tags, `[[links]]`, tables, code blocks, callouts, file names with spaces. All invented.
- **The tasks.** Starting a session, lookups with a short answer that must appear in what the server returns
  (25 in set 1, 33 in set 2, of which 9 are worded differently from the note and 2 have no answer), and 4 writes.
- **The scripted agent** (`bench/run.ts`). It connects through a real MCP client and acts like an AI: read the
  start-of-chat summary, then for each lookup search once; if the answer is not in the result, read one listed
  note. It is an ideal agent: when the right note is listed it always picks it. The old and the new server get
  the same agent.
- **Two ways of asking.** "Keyword": a short search term ("Postgres"). "Question": the full question. The old
  server only finds exact text, so the keyword run is the fair comparison with it.
- **Counting.** Tokens are counted offline with the `o200k_base` tokenizer (OpenAI's, via `js-tiktoken`).
  Claude and Gemini split text a little differently, so the percentages matter more than the exact numbers.
  The count covers what the AI reads: tool descriptions, server instructions, every tool result, and the
  arguments the AI writes.
- **Repeatable.** Fresh copy of the vault for every run, clock frozen, no network. Same code, same numbers.

```bash
npm run bench
```

```bash
npx tsx bench/run.ts --set holdout
```

## The full numbers

Keyword searches. Old and new server use the same library versions, so only the server code differs.

| What the AI reads | Set 1 old | Set 1 new | Change | Set 2 old | Set 2 new | Change |
|---|---:|---:|---:|---:|---:|---:|
| Tool descriptions + instructions | 886 | 558 | −37.0% | 886 | 558 | −37.0% |
| Start-of-chat summary | 2,549 | 1,868 | −26.7% | 1,506 | 1,246 | −17.3% |
| All lookups | 8,924 | 6,090 | −31.8% | 7,331 | 6,888 | −6.0% |
| 4 writes | 396 | 306 | −22.7% | 283 | 201 | −29.0% |
| Arguments the AI writes | 531 | 507 | −4.5% | 386 | 359 | −7.0% |
| **Whole session** | **13,286** | **9,329** | **−29.8%** | **10,392** | **9,252** | **−11.0%** |

Sources: `bench/results/dev-final.json` and `bench/results/holdout-final.json`, rows `baseline / keyword` and
`current / keyword`.

### Answer quality

| | Set 1 old | Set 1 new | Set 2 old | Set 2 new |
|---|---:|---:|---:|---:|
| Lookups answered | 23/24 | 24/24 | 30/31 | 31/31 |
| Answered by the search alone | 19/24 | 21/24 | 27/31 | 31/31 |
| Mean reciprocal rank | 0.505 | 0.764 | 0.618 | 0.748 |
| With full questions: answered | 0/24 | 23/24 | 0/31 | 29/31 |
| With full questions: whole session | 5,066 | 9,245 | 4,042 | 11,376 |

*Mean reciprocal rank* scores where the answer appears in the results: 1 if in the first result, 0.5 if
second, 0.33 if third, 0 if missing, averaged. Higher is better. The old server with full questions finds
nothing (0 answered); its low token count there is the cost of answering nothing.

On set 2, the 9 questions worded differently from the note: all 9 answered with keyword searches; 7 of 9 with
full questions. Missed: "Who pays for the server?" (the note says "grant from the green spaces fund") and "How
do I bring the database back after a crash?" (the note says "Restoring the database").

## What got worse

1. **On held-out notes the saving is much smaller: 11%, not 30%.** Short notes and precise keywords favour the
   old one-line grep. Some single lookups still cost more than before.
2. **With full questions on set 2, a session costs 9.5% more than the old server's keyword session** (11,376
   vs 10,392). Questions match more words, so more sections come back. The new server does answer 29 of 31
   that way; the old one answers none.
3. **Answers rank lower on set 2.** Mean reciprocal rank on set 2 fell from 0.851 (round 1) to 0.748
   (this version). Every answer is still in the results, but often in second or third place instead of first.
4. **The start-of-chat summary holds fewer answers.** It shows only the newest decisions in full, older ones as
   one line each, and only open tasks. Set 1: 9 of 24 answers in it (old: 10). Set 2: 7 of 31 (old: 8).
5. **Indexing is slower.** Ranking paragraphs instead of sections makes the first search on a big vault slower:
   3.0 s instead of 2.0 s at 4,730 notes (see "Speed and growth").

## How it got here: three rounds

| Round | What changed | Set 1 session | Set 2 session |
|---|---|---:|---:|
| Old server | Line-by-line text match, up to 50 lines, alphabetical | 13,286 | 10,392 |
| RAG version 1 | 5 whole sections per search | lookups 2.8% **worse** than old | not measured yet |
| RAG round 1 | Only matching lines shown; one-word coincidences dropped | 9,663 (−27.3%) | 11,093 (**+6.7%**) |
| RAG round 2 | Paragraph ranking, score cutoff, partial matches, decision list | 9,329 (−29.8%) | 9,252 (−11.0%) |

Set 2 was written after round 1 and measured before round 2 changed anything
(`bench/results/holdout-before.json`). It showed round 1 was **worse** than the old server on notes it had not
been tuned on. Round 2 was tuned on set 1 only; set 2 was run once at the end.

## What round 2 changed, in plain words

- **Rank small pieces, show their section.** Notes are cut into sections (one heading's text), and sections
  into passages: one list item, paragraph, table row or code block. Search ranks passages, so one bullet that
  answers the question can win on its own, then shows it under its section's name. RAG people call this
  "small-to-big" retrieval.
- **Drop weak hits.** A section must score at least half of the best section's score. Precise searches now
  return 1 or 2 results instead of always 5.
- **Shorter extra hits.** The best hit shows its best passage with the passages around it (up to 600
  characters). The others show only their matching passages (up to 200).
- **Partial matches instead of nothing.** If nothing matches well, up to 2 sections that share one word come
  back, labelled `match="partial"`. This found one more answer on set 1 ("How do we undo a bad release?") for
  about 750 extra tokens across the question run.
- **Older decisions as one line each** in the start-of-chat summary (278 tokens on set 1). Set 1's summary
  went from holding 5 answers to 9. In real use, an answer already in the summary saves a search.
- **Dates on request.** `RAG_SHOW_DATES=true` adds each undated note's last-change date to search hits, so an
  AI can prefer newer notes. Off by default: it added 8.4% to lookup tokens on set 1.

## Settings tried (round 2, set 1 only)

| Score cutoff | Best hit chars | Other hits chars | Lookups, keyword | Answered | Lookups, question | Answered |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 400 | 200 | 6,489 | 24/24 | 7,289 | 23/24 |
| 0 | 600 | 200 | 6,420 | 24/24 | 7,314 | 23/24 |
| 0 | 600 | 300 | 6,665 | 24/24 | 7,719 | 23/24 |
| 0.35 | 600 | 200 | 6,313 | 24/24 | 6,675 | 23/24 |
| 0.35 | 600 | 300 | 6,551 | 24/24 | 6,973 | 23/24 |
| 0.5 | 400 | 200 | 6,159 | 24/24 | 5,743 | 23/24 |
| **0.5** | **600** | **200** | **6,090** | **24/24** | **5,768** | **23/24** |
| 0.5 | 600 | 300 | 6,254 | 24/24 | 5,974 | 23/24 |
| 0.65 | 600 | 200 | 5,505 | 24/24 | 5,554 | **22/24** |
| 0.65 | 400 | 200 | 5,574 | 24/24 | 5,529 | **22/24** |

The bold row is the default: the cheapest setting that lost no answer. A cutoff of 0.65 saves more but loses
an answer. Full list: `bench/results/sweep-round2.txt` (round 1's sweep: `sweep-round1.txt`).

## The cost of the security work

The security labels from the first security round cost 81 tokens per session on set 1. The OWASP round
(see SECURITY_REPORT.md) changed the set 1 session from 9,328 to 9,329 tokens and changed no answer.

## Optional vectors

**Built-in `ngram` vectors** (`RAG_EMBEDDINGS=ngram`, measured). They compare three-letter pieces of words,
which helps with typos, not with meaning. They did not help here: set 1 keyword 9,391 tokens (+62 over
keywords only), set 2 keyword 9,394 (+142), the same answers, and on full questions they cost more (set 1:
10,834 vs 9,245). Off by default.

**A real embedding model through Ollama** (`RAG_EMBEDDINGS=ollama`): **not measured.** The build environment
could not download a model. Its safety rules were tested (SECURITY_REPORT.md: AB-5 to AB-7, SL-3, O6-4,
O9-3, O9-4). Measure it on your own computer:

```bash
ollama pull nomic-embed-text
```

```bash
npx tsx bench/run.ts --set holdout baseline current current-ollama
```

## Speed and growth (synthetic vaults)

`bench/scale.ts` builds bigger vaults by copying set 1 into `Archive/copy-N/` folders and growing the decision
and task logs. They are **synthetic**: good for speed and size, not for answer quality. Run on **one core**
(`taskset -c 0`) of an Intel Xeon at 2.10 GHz, not on an actual laptop, so a slow laptop will be slower.
Source: `bench/results/scale.json`.

| Notes | Old start summary | New start summary | First search (builds index) | Later searches | Old search for "delivery" |
|---:|---:|---:|---:|---:|---:|
| 32 | 2,549 tokens | 1,868 | 47.6 ms | 3.1 to 4.6 ms | 1,228 tokens, 14.3 ms |
| 491 | 7,513 | 1,868 | 441.6 ms | 35.7 to 50.4 ms | 2,751 tokens, 25.3 ms |
| 1,895 | 13,718 | 1,868 | 1,270.1 ms | 74.0 to 99.2 ms | 2,575 tokens, 72.7 ms |
| 4,730 | 26,128 | 1,868 | 2,984.1 ms | 158.0 to 201.6 ms | 2,335 tokens, 153.2 ms |

- The new start summary does not grow; the old one reached 26,128 tokens.
- New search results stayed between 293 and 511 tokens at every size.
- The index lives in memory (process memory grew by about 29 MB at 4,730 notes, a rough reading) and nothing is
  written to disk. It is built on the first search after the server starts; after that, only changed notes are
  re-read. Every search first checks every note's size and change time, so search time grows with the number
  of notes.
- The heavy test suite also builds a 10,000-note vault and checks it stays within generous limits (index under
  2 minutes, a search under 5 seconds, under 1.5 GB of memory growth).

## Limits of this benchmark

- Two small fake vaults and one tokenizer. A real vault will behave differently.
- The scripted agent is ideal and simple. Real AIs sometimes search twice, read the wrong note, or skip
  searching. Both servers got the same agent.
- "Answered" means the answer text was in what the AI received, not that an AI then answered correctly.
- The search was tuned on set 1. Set 2 is the honest check, and it was run on this version once.
