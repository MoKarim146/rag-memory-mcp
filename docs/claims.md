# What is verified, provisional and untested

Every claim this repository makes, sorted by how well it is backed. **Verified**: a test or a check in CI, or a
committed run that `npm run bench:verify` recomputes, backs it on every push. **Provisional**: measured, but on a
small or self-written sample, on one machine, with one model, or once by hand. **Untested**: not measured; no claim
is made.

## Verified

| Claim | Backed by |
|---|---|
| Overlapping handoff saves keep every version in history, within one process and across two processes | `tests/correctness.test.ts` |
| Of six clients saving the handoff with the version they read, exactly one wins and five are refused as conflicts | `tests/correctness.test.ts` |
| Six concurrent decisions are all saved whole, none interleaved | `tests/correctness.test.ts` |
| A vector match's evidence is shown in the result even when it shares no word with the query | `tests/correctness.test.ts` |
| Sessions with different masking or indexing settings never share an index | `tests/correctness.test.ts` |
| A note that is deleted or marked private leaves the index and its vectors | `tests/correctness.test.ts`, `tests/owasp-2026.test.ts` O2-5 |
| The server does not use the MCP SDK's private fields (such as `_requestHandlers`) | `tests/correctness.test.ts` |
| A decision is replaced only by an explicit `supersedes`; AI-written decisions stay marked | `tests/correctness.test.ts`, `npm run demo` |
| The listed injection, poisoning, path, access, secret-leak and masking cases behave as described | `tests/security-audit.test.ts`, `tests/security-attacks.test.ts`, `tests/owasp-2026.test.ts` ([SECURITY_REPORT.md](../SECURITY_REPORT.md)) |
| Ordinary hashes, ids, addresses, dates, ISBNs and prices are not masked or flagged | `tests/security-audit.test.ts` FP-1 to FP-3 |
| Every committed benchmark run's summary and tables follow from its per-query records | `npm run bench:verify` in CI |
| Every generated table in the documents matches its run or result file | `npx tsx bench/report.ts --check` in CI |
| The agent evaluation's plumbing (tools, trace, judging, run folder) works | `npm run bench:agent:dry` in CI, with a scripted stand-in model |

## Provisional

| Claim | Why it is provisional |
|---|---|
| A short chat uses fewer tokens than pasting the notes or the old server (README table) | Three small fake vaults written for this project; sets 1 and 2 were used for tuning, set 3 once |
| Pasting every note is cheaper when one chat asks every question on these small vaults | Same three vaults |
| The answer reached the AI for 82.3% of 10,570 SQuAD questions | One configuration, keyword search; SQuAD questions often share words with their paragraph ([book-benchmark.md](book-benchmark.md)) |
| Planted facts in Moby Dick: 20 of 20 found with the fact's words, 0 of 10 with no shared word (keyword search); with hybrid search 3 of 10 (Moby Dick) and 4 of 10 (Emma) with no shared word | 20 facts written for this project; 10 questions per kind; one embedding model through a stand-in |
| Results on BEIR SciFact, LongMemEval-S and the paraphrase set ([evaluation.md](evaluation.md)) | One embedding model (`all-MiniLM-L6-v2`), served by a stand-in rather than Ollama; SciFact abstracts are probably in that model's training data; dense and hybrid on LongMemEval-S use a 101-question subset; the paraphrase set (64 evaluation questions) was written for this project |
| Hybrid search finds questions worded unlike the note more often than keyword search | Paraphrase set and planted facts, written for this project; on SciFact and LongMemEval-S the gain is smaller, and vectors alone were no better than keyword search there |
| With vectors alone, the evidence turn is shown less often on long chat histories | One dataset (LongMemEval-S, 95 questions), one model |
| Search, index and embedding times | One run on one machine, pinned to two cores; not compared across runs ([benchmarks.md](benchmarks.md)) |
| The three setup steps work from a fresh clone, and Claude Code connects | Checked once by hand on Linux with Node.js 22.23.4 and Claude Code 2.1.318 (README, "What has been tested") |
| The skill improves what an AI does | The skill's rules come from the measurements above, but no model has been evaluated with or without it |

## Untested

- **What a real AI does with the memory**: answer correctness, citations, abstention, stale facts and unrequested
  writes with a real model. The harness exists ([agent-evaluation.md](agent-evaluation.md)); no paid run was made.
- **Ollama itself**, and `nomic-embed-text`, the default model in `.env.example`.
- **Reranking and query rewriting**: neither is implemented.
- **macOS, Windows, and Node.js 22.13 exactly**; ChatGPT or other web apps through a tunnel.
- **Locks on network or synced folders** (SMB, Dropbox, iCloud), where exclusive file creation may not be reliable.
- **Real vaults**: every test and benchmark uses fake notes or public datasets.

## Not claimed

- That the server is secure. The tests cover the listed attacks; the known gaps are in
  [SECURITY_REPORT.md](../SECURITY_REPORT.md), and politely worded orders in notes are not flagged.
- That it is better than other memory servers or RAG tools: only the original project was compared.
- That it saves money in general: token use depends on the vault, the questions and the client.
