# rag-memory-mcp

One shared notebook for all your AI assistants. It hands each AI only the few paragraphs it needs, and keeps
hidden tricks, passwords and private notes out of what it reads.

## Why this exists

Many people cannot pay for one top AI plan, so they mix cheaper ones. For example:

- **plan** in ChatGPT,
- **build** in Claude Code,
- **double-check** in Gemini.

Every time you switch, the next AI knows nothing. So people keep a "handoff" document and paste it in, or
connect the AIs to a memory server. Both cost **tokens**. A token is a small piece of text, roughly three
quarters of an English word. AI plans limit how many tokens you can use, and every token the AI reads comes out
of that budget.

A simple memory server makes this worse in three ways:

1. **Tool descriptions are loaded into every chat.** Before you type anything, the AI is given the name,
   description and inputs of every tool the server offers.
2. **It hands over whole files.** Ask "what did we decide about the database?" and you get every line that
   matches, or the whole file, not just the answer.
3. **The start-of-chat summary keeps growing.** Decisions and tasks pile up over months, and all of it is
   loaded again at the start of every chat.

This project is the same idea done more carefully. It is built from
[secure-obsidian-memory-mcp](https://github.com/MoKarim146/secure-obsidian-memory-mcp) and changes it in two
ways:

- **It spends fewer tokens.** It looks things up first and hands over only the best few passages. This is
  called RAG, retrieval-augmented generation: the server *retrieves* the relevant parts, then the AI
  *generates* its answer from them.
- **It treats notes as untrusted.** A note can contain hidden text that tries to give the AI orders (this is
  called *prompt injection*), or a password someone pasted in. The server cleans that out before the AI sees
  it, and checks what an AI tries to save. It follows the
  [OWASP Top 10 for LLM Applications 2026](https://github.com/GenAI-Security-Project/GenAI-LLM-Top10).

Everything runs on your own computer. No note is sent over the network by this server.

## Measured results

A repeatable benchmark plays the AI against the server with fake notes and questions with known answers. It
was run on two sets of notes: one the search was tuned on, and one written later and **never used for tuning**,
which is the honest number. Details, and everything that got worse, are in [RAG_RESULTS.md](RAG_RESULTS.md).

| A whole scripted session | Set 1 (tuned on) | Set 2 (never tuned on) |
|---|---:|---:|
| Old server | 13,286 tokens | 10,392 tokens |
| This server | 9,329 tokens | 9,252 tokens |
| **Change** | **−29.8%** | **−11.0%** |
| Lookups answered, old → new | 23/24 → 24/24 | 30/31 → 31/31 |

- Tool descriptions and instructions sent at the start of every chat: 886 → 558 tokens (−37.0%).
- On a synthetic vault of 4,730 notes the old start-of-chat summary grew to 26,128 tokens; this one stays at
  1,868.
- Tokens were counted with an OpenAI tokenizer (`o200k_base`) because it runs offline. Claude and Gemini count a
  little differently, so treat the percentages as the result.

What got worse: on notes it was not tuned on the saving is 11%, not 30%; with full-question searches a session
on set 2 costs 9.5% more than the old server's keyword session (but answers 29 of 31 questions, where the old
server answers none); and the start-of-chat summary holds a few fewer answers.

## How it saves tokens

- **Small-to-big search.** Notes are cut into sections (one heading's text), and sections into passages (one
  list item, paragraph, table row or code block). Search ranks the small passages, so the bullet that answers
  your question wins, and shows it under its section's heading.
- **Only good matches.** Ranking uses SQLite FTS5, the full-text search built into the SQLite that ships with
  Node.js, with BM25 scoring and word stemming ("rolling back" finds "roll back"). A result must score at least
  half as well as the best one, and a 3+ word question must match 2 of its words. Precise searches return 1 or 2
  results instead of 5. If nothing matches well, up to 2 partial matches come back, labelled as partial.
- **Short output.** The best result shows up to 600 characters around its best passage; the others only their
  matching passages, up to 200 characters. At most 2 results per note, at most 10 per search.
- **Short start-of-chat summary.** Newest decisions in full, older ones as one line each, open tasks only.
- **Short tool descriptions** and one-line answers from the write tools.

Optional extra: **embeddings** (`RAG_EMBEDDINGS`). An embedding turns text into numbers so that texts with
similar meaning are close together, which can find "undo a release" when the note says "roll back". Off by
default. Use a real model through [Ollama](https://ollama.com) on your own computer, or a small built-in option
(`ngram`) that only helps with typos. The real-model option was not measured yet; see RAG_RESULTS.md.

## How it keeps your notes safe

What the AI reads:

- Only markdown files inside your memory folder. `../` tricks, absolute paths, symlinks pointing outside and
  hidden folders such as Obsidian's `.trash` are refused.
- Text you cannot see but an AI can is removed: `<!-- -->` and `%% %%` comments, `[//]: # ()` comment links,
  HTML hidden with `hidden`, `display:none`, zero font size or white text, zero-width and other invisible
  characters, and terminal control codes.
- Secret-looking text (API keys, tokens, passwords, private keys) is replaced with `[secret removed]`; email
  addresses, phone numbers and card numbers are masked too.
- Remote images and embedded pages are replaced by a label, so a note cannot steer an AI into repeating an
  image link that leaks data when shown.
- Notes with `ai_private: true` in their front matter, or the tag `#ai-private`, are never read, searched or
  sent anywhere.
- All note text comes inside `<note>` labels with the instruction that it is data, not orders. Notes that look
  like orders to an AI get a visible warning, and search only shows them when nothing clean matches.

What an AI can write:

- No delete tool. Writes only append to fixed notes or replace the handoff, whose old versions are kept.
- **A write that looks like an order to an AI is not saved.** It waits in `AI Review/pending.md`, which you see
  in Obsidian and no AI can read; you decide. With `AI_MEMORY_WRITE_REVIEW=all`, every write waits for you.
- Hidden text, remote images, scripts and `javascript:` links are refused; secrets are masked before saving.
- Everything an AI writes is marked `(added by AI via MCP)`, and session notes are labelled `written_by="ai"`.
- Limits: field sizes, 2 MB per file, 20 writes per 10 minutes per session, repeated identical writes refused,
  120 calls per minute per session, 32 open sessions.
- Every write is recorded in `.history/audit.jsonl` (time, tool, file, outcome, size and hash, never the text).

Who can connect: only this computer by default, web pages in your browser are refused, and there is optional
token login with a read token and a write token.

Tested by 124 attack, fuzz and stress tests. What they found and what is still open:
[SECURITY_REPORT.md](SECURITY_REPORT.md).

**Not solved:** a note stuffed with likely search words but no obvious order still shows up in searches;
politely worded orders are not flagged; the server cannot tell a true note from a false one. Keep the memory
folder for memory only, and read what your AIs write into it.

## Example workflow

1. In ChatGPT, plan the next feature. Ask it to save the plan with `update_handoff_summary` and the key choices
   with `add_decision`.
2. Open Claude Code. It calls `read_main_context` (about 1,900 tokens on the test vault, instead of pasting a
   long handoff) and starts building. When it needs a detail it calls `search_memory` instead of reading every
   note.
3. At the end, Claude Code saves what it did with `append_session_note` and updates the handoff.
4. Gemini or another assistant can review the work from the same memory.
5. Now and then, open `AI Review/pending.md` in Obsidian to approve or delete anything that was held.

This is one example. Any assistant that supports MCP (Model Context Protocol, the standard way AI apps connect
to tools) can use the server.

## Quickstart

Needs Node.js 22.13 or newer.

```bash
npm install
```

```bash
npm run build
```

Run it on the fake sample vault first:

```bash
AI_MEMORY_DIR="$PWD/examples/sample-vault" npm start
```

It listens on `http://127.0.0.1:8787/mcp`, on your computer only. Node prints an `ExperimentalWarning` about
SQLite at start: that is Node.js labelling its built-in SQLite as experimental, and it is expected.

Connect Claude Code:

```bash
claude mcp add --transport http memory http://127.0.0.1:8787/mcp
```

Run the tests and the benchmarks:

```bash
npm test
```

```bash
npm run test:heavy
```

```bash
npm run bench
```

**ChatGPT and other web apps** connect from their company's servers, so they need a public address (a tunnel
such as Cloudflare Tunnel or ngrok). Only do that with token login on (`MCP_AUTH_REQUIRED=true`) or with access
control on the tunnel itself, and stop the tunnel when you are done.

## Tools

| Tool | What it does |
|---|---|
| `read_main_context` | Start here: main notes, current work, handoff, newest decisions, open tasks |
| `read_handoff_summary` | Read `04_MODEL_HANDOFF.md` |
| `search_memory` | Search all notes; returns the best passages, best first (`limit` 1 to 10, default 5) |
| `read_note` | Read one note by its path; long notes come in pages |
| `update_handoff_summary` | Replace the handoff note (old versions kept in `.history/`; marked destructive) |
| `append_session_note` | Add a dated note under `Sessions/` |
| `add_decision` | Add a dated decision to `02_DECISIONS.md` |
| `add_open_task` | Add a task to `03_OPEN_TASKS.md` |

## Settings

Copy `.env.example` to `.env`; every setting is explained there. The main ones:

| Setting | Default | Meaning |
|---|---|---|
| `AI_MEMORY_DIR` | `~/ObsidianVault/AI-Memory` | The memory folder. Use a folder only for AI memory, not your whole vault. |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Where the server listens. Keep `127.0.0.1`. |
| `AI_MEMORY_WRITE_ENABLED` | `true` | `false` makes the memory read-only. |
| `AI_MEMORY_WRITE_REVIEW` | `suspicious` | Which writes wait for you in `AI Review/pending.md`: `suspicious`, `all` or `off`. |
| `AI_MEMORY_TOOLS` | all | Offer only these tools, comma separated. |
| `MCP_AUTH_REQUIRED` | `false` | `true` turns on token login; set `MCP_WRITE_TOKEN` and/or `MCP_READ_TOKEN` (32+ characters). |
| `MASK_EMAILS`, `MASK_PHONE_NUMBERS` | `true` | Mask contact details in everything the AI reads. |
| `RAG_EMBEDDINGS` | `none` | `ngram` or `ollama` for the optional vector search. |
| `RAG_SHOW_DATES` | `false` | Show each undated note's last-change date in results (about 8% more tokens). |
| `MCP_MAX_CALLS_PER_MINUTE`, `MCP_MAX_WRITES_PER_10_MIN` | `120`, `20` | Per-session limits. |

## Project layout

- `src/`: the server. `src/retrieval/` is the search (chunker, index, embeddings); `src/safety.ts` cleans note
  text and checks writes; `src/context.ts` builds the short start-of-chat summary.
- `tests/`: 129 fast tests (`npm test`). `tests/heavy/`: 15 fuzz and stress tests (`npm run test:heavy`).
- `bench/`: the token benchmark, two fake test vaults and saved results.
- `security/`: raw test results before and after each round of fixes, and `npm audit` before and after.
- `sbom.cdx.json`: the list of every package the server contains (CycloneDX).

## Who made what

- The original project, [secure-obsidian-memory-mcp](https://github.com/MoKarim146/secure-obsidian-memory-mcp),
  was written with **Codex**. **Mohamed Karim** designed it, directed the work and tested it.
- **Claude Code** (Anthropic's coding agent) wrote this version's additions at his direction: the token
  benchmark, the RAG search, the security audit, the OWASP controls, the heavy tests and these documents.
- The first commit in this repository is the original project, unchanged, so every later change can be seen on
  its own.

## Privacy

Only use fake notes in this repository (`examples/` and `bench/` vaults are fictional). Never commit a real
vault, `.env`, tokens or tunnel addresses. Anything an AI reads can be sent to that AI's company under its own
terms; this server only controls what it hands over.
