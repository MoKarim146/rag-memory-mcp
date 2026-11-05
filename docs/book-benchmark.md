# Long-text benchmark: real books and 10,570 outside questions

The other benchmarks in this project use small fake vaults and questions written alongside the search. This one
asks a harder question: **with real books and questions written by other people, does the search give the AI
the answer as reliably as pasting the whole text, and at what cost?**

Every number here comes from the run folder `bench/runs/books/20261105T050800Z-7cb61de` (commit `7cb61de`, one
record per query; check it with `npm run bench:verify`), made by `bench/books.ts`. Nothing in it was used to tune
the search. Percentages are rounded to one decimal. The first publication of this benchmark
(`bench/results/books.json`, commit `09766a6`) gave the same quality numbers except for the optional `ngram`
vectors, which changed when vectors became per passage (see section 1).

How to run it and what the records contain: [docs/benchmarks.md](benchmarks.md).

## The short version

- **10,570 questions about 48 Wikipedia articles** (SQuAD, written by crowd workers, not by this project). The
  articles together are 330,795 tokens, more than a 200,000-token chat window holds. Search put the exact
  answer in front of the AI for **82.3%** of questions, at **186 tokens** per search. Pasting as much as fits in
  200,000 tokens covers 54.7%.
- **One made-up fact hidden in a whole book** (Moby Dick, 291,728 tokens), 20 times at 20 depths. Searched with
  words from the fact: **20 of 20** found, at 75 tokens per search. Asked in other words that keep a name: 8 of
  10. Asked in words the fact does not contain at all: **0 of 10**. Keyword search cannot match meaning.
- **A library of 18 books and the 48 articles** (3,157,635 tokens, far beyond any chat window). Still 20 of 20
  planted facts with keywords; SQuAD accuracy dropped by 1.4 points. On one CPU core the first search took 3.4
  seconds to build the index, later searches 47 ms on average.
- **Two bugs found and fixed:** a whole book in one note over 1 MB was silently left out of search, and the
  check for orders to an AI flagged ordinary dialogue ("you are now going to leave me") in 5 of 587 chapters.
- **Not measured yet:** whether an AI then *answers* correctly. That needs a model and an API key (see "How to
  test this properly").

## How to test this properly

There are three levels of testing a memory search, from cheapest to most realistic:

1. **Does the answer reach the AI?** Ask a question, look at what the server returns, and check whether the
   answer is in it. No AI is needed, so it is free, fast and repeatable. This page does this.
2. **Does the AI then answer correctly?** Give a real model the same questions twice, once with the whole text
   and once with only the search results, and grade its answers. This also catches what level 1 cannot: a
   model can miss a fact buried in a very long text, and it can answer from a snippet that level 1 counts as a
   miss (see "How answers were checked"). It needs an AI API key and costs a little money, so it is not done yet.
3. **Does it help in real work?** Count tokens and repeated questions in your own sessions over a few weeks.

## What was tested

| Data | What it is | Why it is useful |
|---|---|---|
| [SQuAD 1.1](https://rajpurkar.github.io/SQuAD-explorer/) development set | 10,570 questions written by crowd workers about 48 Wikipedia articles (2,067 paragraphs), each with its exact answer and the paragraph it comes from. License CC BY-SA 4.0 | Written by other people, so not tuned to this search, and every answer can be checked |
| 18 books from [Project Gutenberg](https://www.gutenberg.org/), as packaged by [NLTK](https://www.nltk.org/nltk_data/) | Moby Dick, Emma, Persuasion, Paradise Lost, Hamlet, the King James Bible and 12 more. Public domain | Real, long text |
| 20 planted facts | Made-up facts such as "The spare key for the boathouse padlock is taped under the third step of the cellar stairs", placed evenly through a book from the first paragraph to the last | The classic "needle in a haystack" test: one fact hidden in a whole book |
| [NarrativeQA](https://github.com/google-deepmind/narrativeqa) | 146 questions about 5 of the books (Emma, Persuasion, Sense and Sensibility, Paradise Lost, The Man Who Was Thursday), written from plot summaries. License Apache 2.0 | Questions about a story as a whole |

The data is downloaded when the benchmark runs and checked against SHA-256 sums; none of it is stored in this
repository. Books are stored the way you would keep them in Obsidian: one note per chapter, one line per
paragraph. Each question is asked once with `search_memory` (5 results, the default) and nothing else: no
follow-up `read_note`.

**How answers were checked.** The SQuAD way: lower case, no punctuation, no "a", "an" or "the", then the answer
must appear as whole words in what the server returned. "With its context" is stricter: the answer must appear
together with up to four of the words around it in the source paragraph, which shows it came from the right
place and not from an unrelated mention. The check is strict on purpose, so it undercounts a little: for "Which
NFL team won Super Bowl 50?" the top result says "Denver won despite being massively outgained…", which an AI
would answer correctly, but the expected answer is "Denver Broncos", so it counts as a miss.

## 1. 10,570 questions about 48 Wikipedia articles

| What the AI gets | Tokens | Answer in it | With its context |
|---|---:|---:|---:|
| All 48 articles pasted | 330,795 per chat | 100% (if the window holds it) | 100% |
| As much as fits in 200,000 tokens | 200,000 per chat | 54.7% | |
| As much as fits in 128,000 tokens | 128,000 per chat | 34.6% | |
| As much as fits in 32,000 tokens | 32,000 per chat | 8.6% | |
| Only the right article, if you knew which | 6,885 on average | 100% | 100% |
| **This server, the question as asked** | **186 per search** | **82.3%** | **78.1%** |
| This server, the question without common words | 185 per search | 82.3% | 78.1% |
| Same, on a 1,000-question sample (used below) | 185 per search | 82.4% | 77.7% |
| Same sample, 10 results instead of 5 | 214 per search | 83.4% | 78.2% |
| Same sample, with `ngram` vectors (per-passage vectors since commit `a7664c5`) | 223 per search | 75.9% | 71.2% |
| This server, one word (the question's rarest word) | 215 per search | 43.6% | 38.8% |
| Old server, one word (the question's rarest word) | 839 per search | 60.2% | 54.3% |
| Old server, the question as asked (1,000-question sample) | 25 per search | 1.0% | 0.1% |

Every chat with this server also reads the tool descriptions and the start summary once: 650 tokens here. So a
chat with 3 such questions reads about 1,200 tokens, against 330,795 for pasting all the articles.

What the numbers say:

- **The right article was listed for 98.3% of questions**, even when the answer itself was not in the snippet.
  An AI that then opens that article with `read_note` can find most of the rest, at the cost of reading pages of
  it.
- **Typing the whole question works as well as picking keywords.** The server already ignores words such as
  "what" and "the", so both send the same search.
- **One word alone is much worse** (43.6%): in a big text, one word matches too many places. Use several
  specific words.
- **10 results instead of 5 barely helps** (+1.0 point for 16% more tokens). **The `ngram` vectors make it
  worse** (−6.5 points; −5.2 when vectors were per section, in the first publication), so they stay off by
  default.
- **It depends on wording, not on the kind of question.** "Who" and "which" questions: 85%; "why": 77.4%; the
  rest between 79.7% and 82.2%. The big difference is how many of the question's words appear in the sentence
  with the answer:

| Question words found in the answer's sentence | Questions | Answer in what the AI gets |
|---|---:|---:|
| 2/3 or more | 4,543 | 94.6% |
| 1/3 to 2/3 | 4,109 | 81.3% |
| Under 1/3 | 1,918 | 55.5% |

## 2. One fact hidden in a whole book

20 made-up facts, one at each depth from the first paragraph of Moby Dick to the last. Each was asked three ways:
with words from the fact (`boathouse padlock`); reworded but keeping a name ("How much does Bertram Quill bill us
for his time?"); and reworded with no word in common ("Where should staff gather if the alarm goes off?" for "The
fire assembly point for the Saltmarsh office is the bench beside the bakery").

| Moby Dick, 137 chapter notes | Tokens | Words from the fact | Reworded, keeps a name | No word in common |
|---|---:|---:|---:|---:|
| Whole book pasted | 291,728 per chat | 20/20 | 10/10 | 10/10 |
| As much as fits in 200,000 tokens | 200,000 per chat | 13/20 (by depth) | | |
| As much as fits in 128,000 tokens | 128,000 per chat | 8/20 (by depth) | | |
| **This server** | **75 per search** (reworded: 189) | **20/20** | **8/10** | **0/10** |
| This server with `ngram` vectors | 92 (reworded: 329) | 20/20 | 8/10 | 0/10 |
| Old server, one rare word from the fact (`boathouse`) | 284 | 20/20 | | |
| Old server, the same words as this server | 29 | 5/20 | | |

The depth of the fact made no difference to the search: it found all 20 from the first chapter to the last. The
same test on Emma (202,905 tokens, 56 chapters) gave the same result: 20/20, 8/10 and 0/10.

The two reworded questions with a name that were missed asked "When is the meeting in Larch about money now
held?" (the fact says "budget review") and "When does Halyard's test machine get shut down?" (the fact says
"staging server … switched off"). Questions with no word in common need a search that understands meaning:
embeddings from a real model (`RAG_EMBEDDINGS=ollama`, not measured yet) or an AI that searches again with other
words.

## 3. A whole book in one note

| Stored as | Size | Words from the fact | Reworded, keeps a name |
|---|---:|---:|---:|
| Emma, one note | 0.89 MB | 20/20 | 8/10 |
| Moby Dick, one note (before the fix, shown by the new test failing on the old code) | 1.22 MB | **0/20, and no message** | 0/10 |
| Moby Dick, one note (after the fix) | 1.22 MB | 0/20, and the note is named | 0/10 |

Notes over 1 MB are left out of search on purpose: it stops a huge file from slowing the server down. But
nothing said so, so a whole book saved as one note just never matched. Now the start-of-chat summary and every
search that finds nothing name such notes and say to split them, and the server log names them once.
`read_note` can still open them page by page. Splitting the book into chapters fixed it completely (section 2).

## 4. A library: 18 books and 48 articles together

587 notes, 13.3 MB, 3,157,635 tokens. No chat window holds that, so pasting is not an option.

| | Articles alone (48 notes) | Whole library (587 notes) |
|---|---:|---:|
| SQuAD, same 1,000 questions: answer in what the AI gets | 82.4% | 81.0% |
| Planted facts, words from the fact | 20/20 (book alone) | 20/20 |
| Planted facts, reworded with a name | 8/10 (book alone) | 8/10 |
| Tokens per search (SQuAD) | 185 | 198 |
| First search, which builds the index (one CPU core) | 0.4 s | 3.4 s |
| Later searches, average (95% under) | 13.8 ms (23.2 ms) | 47.0 ms (79.7 ms) |

The old server, given one rare word, found 19 of 20 planted facts in the library but returned 698 tokens per
search on average, 3,718 or more for one search in ten, and took 125 ms per search.

## 5. Questions about whole stories

NarrativeQA asks things like "Why is William concerned by the relationship between Mrs. Clay and Sir Walter?"
Its answers are written freely from plot summaries ("William is heir to the family estate"), so they rarely
appear in the book word for word, and a word-for-word check cannot score them. What can be checked is whether
the search at least lands in the right book: in the 587-note library, **the top result came from the right book
for 73.3%** of the 146 questions, and 68.5% of all results did.

This is the clearest limit of search: a question about why something happens in a story needs the story, not 5
snippets. For such questions, read the chapters, or paste the book if it fits.

## 6. The safety filters on real text

All 587 notes in the library are harmless, so anything the filters flag is a false alarm.

| | Before the fix | After |
|---|---:|---:|
| Notes flagged as orders to an AI | 5 | 0 |
| Notes with something masked as a secret | 1 | 1 |
| Notes with something masked as personal data | 1 | 1 |
| Notes with hidden text removed | 0 | 0 |
| SQuAD answers hidden by masking | 0 | 0 |

- **The 5 flags** all came from the rule for "you are now", which matched dialogue such as "You are now going to
  leave me" (The Parent's Assistant) and "there you are now; that's the stroke" (Moby Dick). A flagged note is
  only shown when nothing clean matches, so a false flag can hide an answer. The rule now needs a role or mode
  change after it ("you are now DAN", "you are now in admin mode"); test FP-2 checks both sides.
- **The secret mask** is a real false alarm, left as it is: in Paradise Lost, "And I perhaps am secret: Heaven
  is high" looks like a `secret: value` line, so "Heaven" is masked. Masking one word by mistake is much less
  harmful than missing a real secret.
- **The personal-data mask** is correct: a real email address in a Gutenberg credit line.

## What this means

- **For finding facts, search is much cheaper than pasting, and close to it in quality** when the question
  shares words with the text: 94.6% of answers found when two thirds of the words match, at about 186 tokens
  instead of a whole book.
- **It misses what is worded differently.** 55.5% when few words match, and 0 of 10 when none do. An AI that
  searches again with other words, or real embeddings, are the next steps.
- **It cannot replace reading for questions about a whole story.**
- **Pasting stops being an option at about one book.** A single novel (Emma: 201,979 tokens) already fills a
  200,000-token window; the library is 3.2 million tokens.

## Limits

- Level 1 only: "found" means the answer reached the AI, not that the AI answered correctly.
- The check is strict and undercounts answers worded slightly differently (see "How answers were checked").
- The planted facts and their questions were written for this test (20 facts, 40 questions); SQuAD and
  NarrativeQA were not.
- Timings are from one core of an Intel Xeon at 2.10 GHz, not a laptop.
- Pasting is credited with 100% when it fits, but real models miss some facts in very long texts; only a level 2
  test can measure that.

## Run it yourself

```bash
npx tsx bench/books.ts
```

It downloads about 21 MB once into `bench/.cache/books/` (not committed), checks every file's SHA-256 sum, and
writes a new run folder under `bench/runs/books/`. It takes about 16 minutes on one core. `npm run
bench:books:quick` runs 200 SQuAD questions instead of 10,570.
