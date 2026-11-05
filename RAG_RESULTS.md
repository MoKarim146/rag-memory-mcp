# RAG results: tokens before and after

Every number here comes from a saved result file in `bench/results/`, produced by scripts in `bench/`. Nothing
is estimated; percentages are rounded to one decimal. Where something got worse, it says so.

## What was measured, in plain words

- **The vault.** `bench/fixture-vault/` is a fake project (an online ordering app for a bakery): 32 notes with
  a main context, a decision log of 20 decisions, 23 tasks, 12 AI session notes, 8 project notes, 4 meeting
  notes and 3 reference notes. About 25 KB of text. All invented.
- **The tasks** (`bench/tasks.json`): starting a session, 25 lookups ("Why did we choose SQLite instead of
  Postgres?"), each with a short answer that must appear in what the server returns, and 4 writes.
- **The scripted agent** (`bench/run.ts`). It connects through a real MCP client and does what an AI would
  do: read the start-of-chat summary, then for each lookup search once. If the answer is not in the search
  result, it reads one listed note. It is an *ideal* agent: when the right note is in the list it always
  picks it. Then it stops. The same agent is used for the old and the new server.
- **Two ways of asking.** "keyword": the agent searches with a short keyword ("Postgres"), the way you would
  use a search box. "question": it searches with the full question. The old server only finds exact text, so
  the keyword run is the fair comparison for it.
- **Counting.** Tokens are counted offline with the `o200k_base` tokenizer (OpenAI's, via `js-tiktoken`).
  Claude and Gemini split text a little differently, so exact token numbers will differ by AI; the
  before/after percentages are the meaningful part. The count covers what the AI reads: the tool
  descriptions (name, description and input schema of each tool), the server instructions, every tool
  result, and the arguments the AI writes when calling a tool.
- **Repeatable.** Fresh copy of the vault every run, clock frozen, no network. Running the old code twice gives
  the same numbers to the token.

Run it yourself:

```bash
npm run bench
```

## The result

Both columns use the same library versions (MCP SDK 1.32.2, zod 4), so only the server code differs.

| What the AI reads | Before | After | Change |
|---|---:|---:|---:|
| Tool descriptions (8 tools) | 831 | 508 | −38.9% |
| Server instructions | 55 | 50 | −9.1% |
| Start-of-chat summary (`read_main_context`) | 2,549 | 1,590 | −37.6% |
| 25 lookups (searches plus follow-up reads) | 8,924 | 6,711 | −24.8% |
| 4 writes | 396 | 305 | −23.0% |
| Tool-call arguments the AI writes | 531 | 499 | −6.0% |
| **Whole session** | **13,286** | **9,663** | **−27.3%** |

Source: `bench/results/final.json`, rows `baseline / keyword` and `current / keyword`.

The baseline saved before any change (`bench/results/baseline.json`, old libraries: MCP SDK 1.29, zod 3) was
**13,323**. The old code run again with the new libraries gives 13,286. The 37-token difference is zod 4
printing slightly shorter input schemas (it no longer prints `"additionalProperties": false`), not this
project's work. Against the saved baseline the session saving is −27.5%; the table above uses the fairer
same-library number.

### Answer quality

| | Before (keyword) | After (keyword) | After (question) |
|---|---:|---:|---:|
| Lookups answered (of 24 with an answer) | 23 | **24** | 21 |
| Answered by the search alone, no extra read | 19 | **22** | 20 |
| Search calls plus reads | 30 | 27 | 27 |
| Mean reciprocal rank | 0.505 | **0.736** | 0.685 |

*Mean reciprocal rank* scores where the answer appears in the results: 1 if it is in the first result, 0.5 if
second, 0.33 if third, 0 if missing, averaged over the lookups. Higher is better.

The old server with full questions found nothing (0 of 24), because it only matches the exact text of a line.

### What got worse

1. **The start-of-chat summary knows less.** It now shows only the newest decisions (8 of 20 here) and only
   open tasks. The old one contained the answer to **10** of the 24 lookups; the new one contains **5**. Those
   answers are still found by search, but the AI has to ask.
2. **Some single lookups cost more.** When the old search matched exactly one short line it was cheaper than
   five sections: `rate-limit` 80 → 200 tokens, `launch-date` 70 → 390, `smtp` 62 → 104. RAG wins on broad
   words (`delivery` 1,228 → 338) and when the old search needed a follow-up read (`welsh-file` 1,055 → 478).
3. **Full questions miss 3 answers.** With question-style searches: "How do we undo a bad release?" and
   "What share of shoppers abandon the purchase?" return nothing, because the note uses other words ("roll
   back", "drop-offs") and the rule "a 3+ word question must match at least 2 words" removes weak matches.
   "When is the Welsh launch?" finds the Welsh notes but not the meeting note that holds the date. Keyword
   search cannot know that two different words mean the same thing; that is what embeddings are for.
4. **The first attempt was worse than the old server.** Version 1 returned 5 whole sections per search. It
   answered 24 of 24, but lookups cost **2.8% more** than the old server (9,174 vs 8,924 tokens). Showing
   only the matching lines of hits 2 to 5 and dropping one-word coincidences brought it to −24.8%.

Per lookup (tokens, and whether the answer was reached):

| Lookup | Before (keyword) | After (keyword) | After (question) |
|---|---:|---:|---:|
| postgres | 180 (yes) | 217 (yes) | 278 (yes) |
| rate-limit | 80 (yes) | 200 (yes) | 329 (yes) |
| timezone | 231 (yes, +read) | 162 (yes) | 631 (yes, +read) |
| delivery-fee | 1,228 (yes) | 338 (yes) | 437 (yes) |
| contrast | 383 (yes) | 298 (yes) | 452 (yes) |
| restart | 318 (yes) | 347 (yes) | 396 (yes) |
| welsh-file | 1,055 (yes, +read) | 478 (yes, +read) | 354 (yes) |
| csv-columns | 526 (yes, +read) | 244 (yes) | 352 (yes) |
| pause | 765 (yes, +read) | 506 (yes, +read) | 322 (yes) |
| secret-rotation | 365 (yes) | 327 (yes) | 360 (yes) |
| collect-window | 173 (yes) | 276 (yes) | 220 (yes) |
| queue | 281 (yes) | 228 (yes) | 246 (yes) |
| brand-green | 296 (yes) | 303 (yes) | 219 (yes) |
| load-test | 290 (yes) | 346 (yes) | 280 (yes) |
| accounts | 145 (yes) | 159 (yes) | 379 (yes) |
| smtp | 62 (yes) | 104 (yes) | 516 (yes) |
| regression | 91 (yes) | 152 (yes) | 248 (yes) |
| restore | 210 (yes) | 159 (yes) | 159 (yes) |
| rollback | 285 (**no**) | 360 (yes) | 4 (**no**) |
| launch-date | 70 (yes) | 390 (yes) | 486 (**no**) |
| missing-products | 189 (yes) | 242 (yes) | 332 (yes) |
| cut-off | 263 (yes) | 211 (yes) | 468 (yes) |
| translator | 534 (yes) | 294 (yes) | 364 (yes) |
| paraphrase-dropoff | 889 (yes) | 366 (yes) | 4 (**no**) |
| no-answer (nothing to find) | 15 | 4 | 4 |

"+read" means the agent also had to call `read_note`.

## Where the savings come from

- **Tool descriptions, −323 tokens per chat.** Shorter descriptions, no repeated parameter descriptions, and
  the SDK's `"$schema": "http://json-schema.org/draft-07/schema#"` line removed from each of the 8 tools. Input
  checking is unchanged.
- **Start-of-chat summary, −959 tokens.** Newest decisions only (up to 1,500 characters) and open tasks only.
- **Search, −2,213 tokens over 25 lookups.** Ranked sections instead of up to 50 matching lines in
  alphabetical order; the best hit shown whole, others only their matching lines; at most 2 hits per note;
  fewer follow-up reads.
- **Writes, −91 tokens.** "Saved to 02_DECISIONS.md." instead of a JSON object sent twice.

## The cost of the security work

Compared with the RAG version before the security fixes (`bench/results/after-rag.json`), the warning and
`written_by="ai"` labels added **81 tokens** to the session (75 in lookups, 6 in writes), about 0.8%. zod 4
saved 21 tokens of tool descriptions in the same step, so the session total moved from 9,603 to 9,663.

## Settings tried

Before settling on the defaults (5 results, 300 characters per extra hit, best hit whole) I tried other
settings on the same 25 lookups. This was measured on the RAG version before the security labels and before
the library update, so the numbers are a few tokens lower than above.

| Results | Characters per extra hit | Best hit | Lookups, keyword | Answered | Lookups, question | Answered |
|---:|---:|---|---:|---:|---:|---:|
| 3 | 200 | whole | 6,313 | 22/24 | 5,604 | 20/24 |
| 3 | 300 | whole | 6,337 | 22/24 | 5,870 | 20/24 |
| 3 | 400 | whole | 6,663 | 22/24 | 6,157 | 20/24 |
| 4 | 200 | whole | 5,960 | 24/24 | 6,555 | 20/24 |
| 4 | 300 | whole | 5,984 | 24/24 | 6,949 | 20/24 |
| 4 | 400 | whole | 6,507 | 24/24 | 7,507 | 20/24 |
| 4 | 300 | 300 chars | 5,832 | 24/24 | 6,533 | 20/24 |
| 5 | 200 | whole | 6,573 | 24/24 | 7,264 | 21/24 |
| **5** | **300** | **whole** | **6,636** | **24/24** | **7,755** | **21/24** |
| 5 | 400 | whole | 7,225 | 24/24 | 8,510 | 21/24 |
| 5 | 300 | 300 chars | 6,484 | 24/24 | 7,339 | 21/24 |

The bold row is the default, chosen before this sweep was run. 4 results would save about 10% more on
keyword searches but lose one answer on question searches. Warning: these settings were judged on the same
25 lookups as the results above, so they may suit this fake vault better than your real one. An AI can always
ask for more with `limit` (up to 10).

## Optional vectors

**Built-in `ngram` vectors** (`RAG_EMBEDDINGS=ngram`, measured): they compare three-letter pieces of words, so
they help with typos ("acessibility" still finds "accessibility"), but they do not understand meaning. On this
benchmark they did not help: keyword run 9,706 tokens and 24/24 (same answers as without, 43 tokens more);
question run 12,628 tokens, 21/24 answered and only 19 by search alone (worse than without). Off by default.

**A real embedding model through Ollama** (`RAG_EMBEDDINGS=ollama`): **not measured.** The build environment
could not download a model. What was tested is the safety around it: only addresses on your own computer are
accepted, redirects to other servers are refused, secrets and hidden comments are removed before any text is
sent, and if Ollama is down, search falls back to keywords (SECURITY_REPORT.md, AB-5 to AB-7 and SL-3).
Measure it on your laptop:

```bash
ollama pull nomic-embed-text
```

```bash
npx tsx bench/run.ts baseline current current-ollama
```

## Speed and growth (synthetic vaults)

To see how the server behaves as notes pile up, `bench/scale.ts` builds bigger vaults by copying the test vault
into `Archive/copy-N/` folders and growing the decision and task logs. These vaults are **synthetic**: good for
speed and size, not for answer quality. Run on **one core** (`taskset -c 0`) of an Intel Xeon at 2.10 GHz,
not on an actual laptop, so a slow laptop will be slower. Source: `bench/results/scale.json`.

| Vault | Old start summary | New start summary | First search (builds the index) | Later searches | Old search ("delivery") |
|---|---:|---:|---:|---:|---:|
| 32 notes | 2,549 tokens | 1,590 | 22.5 ms | 3.1 to 10.2 ms | 1,228 tokens, 17.1 ms |
| 491 notes | 7,513 | 1,590 | 265.8 ms | 20.2 to 27.5 ms | 2,751 tokens, 28.9 ms |
| 1,895 notes | 13,718 | 1,590 | 807.6 ms | 63.5 to 92.1 ms | 2,575 tokens, 71.5 ms |
| 4,730 notes | 26,128 | 1,590 | 2,044.1 ms | 148.5 to 210.8 ms | 2,335 tokens, 153.5 ms |

- The new start summary does not grow; the old one grew to 26,128 tokens.
- New search results stayed between 251 and 452 tokens at every size.
- The index lives in memory (process memory grew by about 22 MB at 4,730 notes; a rough reading), and nothing
  is written to disk. It is built on the first search after the server starts, then only changed notes are
  re-read. Every search first checks every note's size and change time, so search time grows with the number
  of notes.
- The old server's two- and three-word searches found nothing in any vault (18 and 24 tokens) because the
  exact phrase was not on one line.

## Limits of this benchmark

- One fake vault, 25 lookups, one tokenizer. A real vault will behave differently.
- The scripted agent is ideal and simple: real AIs sometimes search twice, read the wrong note, or skip
  searching. Both servers were given the same agent.
- "Answered" means the answer text appeared in what the AI received, not that an AI then answered correctly.
- The server code was tuned while looking at these same tasks (see "Settings tried").
