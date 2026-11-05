# rag-memory-mcp

One shared notebook for all your AI assistants, which hands each AI only the few paragraphs it needs and keeps
hidden tricks and passwords out of what it reads.

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

- **It spends fewer tokens.** It looks things up first and hands over only the best few sections. This is
  called RAG, retrieval-augmented generation: the server *retrieves* the relevant parts, then the AI
  *generates* its answer from them.
- **It treats notes as untrusted.** A note can contain hidden text that tries to give the AI orders (this is
  called *prompt injection*), or a password someone pasted in. The server cleans that out before the AI sees it.

Everything runs on your own computer. No note is sent over the network by this server.

## Measured results

Measured with a repeatable benchmark: a script plays the AI on a fake bakery project of 32 notes, with
25 lookups that have known answers. Full numbers, and what got worse, are in [RAG_RESULTS.md](RAG_RESULTS.md).

| What the AI reads | Before | After | Change |
|---|---:|---:|---:|
| Tool descriptions + server instructions, every chat | 886 tokens | 558 tokens | −37.0% |
| Start-of-chat summary | 2,549 | 1,590 | −37.6% |
| 25 lookups | 8,924 | 6,711 | −24.8% |
| **A whole scripted session** | **13,286** | **9,663** | **−27.3%** |
| Lookups answered | 23 of 24 | 24 of 24 | +1 |

On a bigger, synthetic vault (4,730 notes, with a much longer decision log) the old start-of-chat summary
grew to 26,128 tokens; the new one stayed at 1,590.

Tokens were counted with an OpenAI tokenizer (`o200k_base`) because it runs offline. Claude and Gemini count a
little differently, so treat the percentages as the result, not the exact token numbers.

What got worse: the shorter start-of-chat summary leaves out old decisions and finished tasks, so it holds the
answer to 5 of the 24 lookups instead of 10. The AI has to search for the rest.

## How it saves tokens

- **Search returns sections, not files.** Notes are cut into small sections (one heading's worth of text,
  at most 800 characters). Search returns the 5 best sections, at most 2 from the same note. The best one is
  shown whole, the others only show their matching lines.
- **Ranking, not alphabetical order.** Search uses SQLite FTS5, the full-text search built into the SQLite
  database that ships with Node.js. It works like the index at the back of a book. Results are ranked with
  BM25, a standard scoring formula: rare words count more than common ones, and a short section that matches
  beats a long one that mentions the word once. It also matches word forms ("rolling back" finds "roll back").
- **No noise.** For a question of 3 or more words, a section must match at least 2 of them. "What is the name
  of our Kubernetes cluster?" now returns nothing instead of every note containing "name".
- **Short start-of-chat summary.** Only the newest decisions and the open tasks are included.
- **Short tool descriptions** and one-line answers from the write tools.

Optional extra: **embeddings** (`RAG_EMBEDDINGS`). An embedding turns text into a list of numbers so that
texts with similar meaning get similar numbers, which can find "undo a release" when the note says "roll
back". It is off by default. You can use a real model through [Ollama](https://ollama.com) on your own
computer, or a small built-in option (`ngram`) that only helps with typos. See RAG_RESULTS.md for what was and
was not measured.

## How it keeps your notes safe

- Only reads and writes markdown files inside your memory folder. Blocks `../` tricks, absolute paths,
  symlinks that point outside, and hidden folders such as Obsidian's `.trash`.
- Removes text you cannot see but the AI can: `<!-- HTML comments -->`, `%% Obsidian comments %%`,
  zero-width characters and other invisible characters.
- Replaces secret-looking text (API keys, tokens, passwords, private keys) with `[secret removed]`.
- Puts all note text inside `<note>` labels and tells the AI that note text is data, not orders. Notes that
  look like orders aimed at an AI get a visible warning.
- Marks what an AI wrote: session notes are labelled `written_by="ai"`, and decisions or tasks saved through
  the tools end with `(added by AI via MCP)`.
- Write limits: one-line fields cannot contain line breaks, inputs have size limits, files stop growing at
  2 MB, and the old handoff is kept every time it is replaced.
- Optional read-only mode and optional token login (a read token and a write token).
- Refuses web pages in your browser, unless you allow their address.

38 attack tests, what they found and what is still open: [SECURITY_REPORT.md](SECURITY_REPORT.md).

**Not solved:** a note written on purpose to match many searches still shows up in results (it is capped at
2 results and flagged, but it is not blocked), and the server cannot stop an AI from obeying a cleverly worded
note. Keep the memory folder for memory only, and read what your AIs write into it.

## Example workflow

1. In ChatGPT, plan the next feature. Ask it to save the plan with `update_handoff_summary` and the key choices
   with `add_decision`.
2. Open Claude Code. It calls `read_main_context` (about 1,600 tokens on the test vault, instead of pasting a
   long handoff) and starts building. When it needs a detail it calls `search_memory` instead of reading every
   note.
3. At the end, Claude Code saves what it did with `append_session_note` and updates the handoff.
4. Gemini or another assistant can review the work from the same memory.

This is one example. Any assistant that supports MCP (Model Context Protocol, the standard way AI apps
connect to tools) can use the server.

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

Run the tests and the benchmark:

```bash
npm test
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
| `search_memory` | Search all notes; returns the best sections, best first (`limit` 1 to 10, default 5) |
| `read_note` | Read one note by its path; long notes come in pages |
| `update_handoff_summary` | Replace the handoff note (the old version is kept in `.history/`) |
| `append_session_note` | Add a dated note under `Sessions/` |
| `add_decision` | Add a dated decision to `02_DECISIONS.md` |
| `add_open_task` | Add a task to `03_OPEN_TASKS.md` |

There is no delete tool.

## Settings

Copy `.env.example` to `.env`. The main ones:

| Setting | Default | Meaning |
|---|---|---|
| `AI_MEMORY_DIR` | `~/ObsidianVault/AI-Memory` | The memory folder. Point it at a folder used only for AI memory, not your whole vault. |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Where the server listens. Keep `127.0.0.1`. |
| `AI_MEMORY_WRITE_ENABLED` | `true` | `false` makes the memory read-only. |
| `MCP_AUTH_REQUIRED` | `false` | `true` turns on token login. Then set `MCP_WRITE_TOKEN` and/or `MCP_READ_TOKEN` (32+ characters, for example from `openssl rand -hex 32`). |
| `RAG_EMBEDDINGS` | `none` | `ngram` or `ollama` for the optional vector search. |
| `RAG_OLLAMA_URL`, `RAG_OLLAMA_MODEL` | `http://127.0.0.1:11434`, `nomic-embed-text` | Must point at your own computer; anything else is refused. |
| `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` | local only | Extra host names, and browser pages allowed to call the server. |

## Project layout

- `src/` the server. `src/retrieval/` is the search (chunker, index, embeddings), `src/safety.ts` cleans note
  text, `src/context.ts` builds the short start-of-chat summary.
- `tests/` 87 automated tests, including the attack tests.
- `bench/` the token benchmark, the fake test vault, and saved results.
- `security/` raw test results before and after the security fixes.

## Who made what

- The original project, [secure-obsidian-memory-mcp](https://github.com/MoKarim146/secure-obsidian-memory-mcp),
  was written with **Codex**. **Mohamed Karim** designed it, directed the work and tested it.
- **Claude Code** (Anthropic's coding agent) wrote this version's additions at his direction: the token
  benchmark, the RAG search, the security audit and fixes, and these documents.
- The first commit in this repository is the original project, unchanged, so every later change can be seen
  on its own.

## Privacy

Only use fake notes in this repository (`examples/` and `bench/fixture-vault/` are fictional). Never commit a
real vault, `.env`, tokens or tunnel addresses. Anything an AI reads can be sent to that AI's company under
its own terms; this server only controls what it hands over.
