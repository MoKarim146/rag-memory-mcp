# How it works

This page explains, in plain words, how the server saves tokens and how it keeps notes safe. The code is in
`src/`; every rule below has a test in `tests/`.

## The memory folder

The memory is a folder of markdown notes, for example a folder inside your Obsidian vault. Five main notes are
created if they are missing:

| Note | What goes in it |
|---|---|
| `00_MAIN_CONTEXT.md` | What the project is, its goals and rules |
| `01_CURRENT_WORK.md` | What is being worked on now |
| `02_DECISIONS.md` | Dated decisions with their reasons (`add_decision` appends here) |
| `03_OPEN_TASKS.md` | Open tasks (`add_open_task` appends here) |
| `04_MODEL_HANDOFF.md` | A short note from the last AI to the next one (`update_handoff_summary` replaces it) |

Session notes go in `Sessions/`. Any other markdown note in the folder can be searched and read.

## How a search works

```mermaid
flowchart LR
  subgraph index["Step 1: index the notes"]
    direction TB
    N["Markdown notes"] --> C["Clean: remove hidden text,<br/>mask secrets, skip private notes"]
    C --> P["Cut into sections<br/>and passages"]
    P --> F[("SQLite FTS5 index,<br/>in memory")]
  end
  subgraph search["Step 2: answer a search"]
    direction TB
    Q["AI calls search_memory"] --> R["Rank passages with BM25"]
    R --> K["Keep strong matches,<br/>at most 2 per note"]
    K --> S["Pick the matching sentences"]
    S --> A["Short reply, each hit<br/>inside a note tag"]
  end
  index --> search
```

1. **Clean.** Every note is cleaned before it is indexed or shown (see "Safety" below). A private note is not
   indexed at all.
2. **Cut into pieces.** A note is cut into *sections* (the text under one heading) and each section into
   *passages*: one list item, one paragraph, one table row (with the table's header row kept as context) or one
   code block.
3. **Index.** The passages go into a full-text index. It uses SQLite FTS5, the full-text search built into the
   SQLite that ships with Node.js, so there is nothing extra to install. Words are stemmed, so "rolling back"
   also finds "roll back", and accents are ignored. The index lives in memory and is never written to disk.
   Before each search the server checks each note's size and change time and re-reads only the notes that
   changed.
4. **Rank.** Passages are scored with BM25, the standard formula search engines use: rare words count more than
   common ones, and a word in the note's name or headings counts double. A section's score is its best passage's score. This is
   called *small-to-big* retrieval: the small passage that answers the question wins, then it is shown under
   its section's heading.
5. **Keep only strong matches.** A section must score at least half as well as the best one. A question of 3
   or more words must match at least 2 of them. At most 2 sections per note and 5 per search (the AI can ask
   for up to 10). If nothing matches well, up to 2 partial matches come back, labelled `match="partial"`.
   Notes that look like orders to an AI only appear when nothing clean matches.
6. **Show only the matching sentences.** Each hit is split into sentences, list items and table rows. The best
   hit shows its matching sentences plus the one or two after them (the answer often comes right after the
   sentence that matches), up to 450 characters. Other hits show up to 180 characters. "…" marks a gap. A hit
   that repeats one already shown (60% or more of the same words) is dropped.
7. **Reply.** Each hit comes back inside a `<note>` tag with its path and section, and the reply starts with a
   one-line reminder that note text is data, not instructions.

`read_note` still returns a whole note (in pages for long notes) when the AI needs more than a snippet.

### Optional: embeddings

An *embedding* turns text into a list of numbers so that texts with similar meaning end up close together. It
can find "undo a release" when the note says "roll back". It is off by default (`RAG_EMBEDDINGS=none`).

- `RAG_EMBEDDINGS=ollama` uses a real embedding model through [Ollama](https://ollama.com) on your own
  computer. Only a local address is accepted (`localhost`, `127.0.0.1` or `::1`), redirects are refused and
  replies are capped at 8 MB. Not measured yet (see [RAG_RESULTS.md](../RAG_RESULTS.md)).
- `RAG_EMBEDDINGS=ngram` is a small built-in option that compares three-letter pieces of words. It helps with
  typos, not meaning, and it did not improve the benchmark.

When embeddings are on, keyword results and embedding results are merged with *reciprocal rank fusion*: each
result gets points for how high it ranks in each list, and the totals decide the order.

## How the start-of-chat summary stays short

`read_main_context` returns the five main notes with fixed limits:

- each main note up to 4,000 characters;
- the newest decisions in full (up to 1,500 characters), older ones as one line each with only their first
  sentence (up to 900 characters);
- open tasks only, up to 2,000 characters; finished tasks are left out.

So the summary stays about the same size however long the project runs. On the test vault it was 1,850 tokens;
the old server's summary grew to 26,128 tokens at 4,730 notes.

## Safety

The server treats every note as untrusted: a note can be pasted from the web, written by another AI, or
planted by someone else. The rules follow the
[OWASP Top 10 for LLM Applications 2026](https://github.com/GenAI-Security-Project/GenAI-LLM-Top10); each rule's
tests are listed in [SECURITY_REPORT.md](../SECURITY_REPORT.md).

### What the AI reads

- **Only the memory folder.** Only markdown files inside it. `../` tricks, absolute paths, symlinks that point
  outside and hidden folders such as Obsidian's `.trash` are refused. The `AI Review/` folder is never read.
- **No hidden text.** Text you cannot see but an AI can is removed: `<!-- -->` and `%% %%` comments,
  `[//]: # ()` comment links, HTML hidden with `hidden`, `display:none`, zero font size or white text,
  zero-width and other invisible characters, and terminal control codes.
- **No secrets.** API keys, tokens, passwords and private keys are replaced with `[secret removed]` (22 rules).
  Email addresses, phone numbers and card numbers are masked too (`MASK_EMAILS`, `MASK_PHONE_NUMBERS`).
- **No leaking images.** Remote images and embedded pages are replaced by a label, so a note cannot make an AI
  repeat an image link that sends data to someone's server when it is displayed.
- **Private notes stay private.** A note with `ai_private: true` in its front matter, or the tag `#ai-private`,
  is never read, searched or sent.
- **Orders in notes are labelled.** All note text comes inside `<note>` tags with the reminder that it is data.
  A note that looks like orders to an AI ("ignore previous instructions", including look-alike letters and
  base64) gets a visible warning.

### What an AI can write

- **No delete tool.** Writes only append to fixed notes or replace the handoff, whose old versions are kept in
  `.history/`.
- **Suspicious writes wait for you.** A write that looks like orders to an AI is not saved. It goes to
  `AI Review/pending.md`, which you see in Obsidian and no AI can read. With `AI_MEMORY_WRITE_REVIEW=all`, every
  write waits.
- **Hidden text and remote content are refused.** Comments, invisible characters, remote images, scripts and
  `javascript:` links in a write are refused. Secrets are masked before saving.
- **AI writing is marked.** Everything an AI writes ends with `(added by AI via MCP)`, and search labels
  session notes `written_by="ai"`.
- **Limits.** Field sizes, 2 MB per file, 20 writes per 10 minutes per session, a third identical write within
  5 minutes is refused, 120 calls per minute per session, 32 open sessions, idle sessions closed after 30
  minutes.
- **Audit log.** Every write is recorded in `.history/audit.jsonl`: time, session, tool, file, outcome, size and
  a hash of the text, never the text itself.

### Who can connect

- The server listens on `127.0.0.1` (this computer only) by default.
- Requests from web pages in your browser are refused (Host and Origin checks), so a website cannot reach the
  server through your browser.
- Optional token login (`MCP_AUTH_REQUIRED=true`): a write token can use every tool, a read token only the read
  tools. Tokens are compared in constant time and must be 32 or more characters.
- `AI_MEMORY_TOOLS` offers only the tools you list; `AI_MEMORY_WRITE_ENABLED=false` makes the memory read-only.

### Not solved

- A note stuffed with likely search words but no obvious order still shows up in searches.
- Politely worded orders are not flagged.
- The server cannot tell a true note from a false one.

Keep the memory folder for memory only, and read what your AIs write into it.
