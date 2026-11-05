// Token benchmark for the memory MCP server.
//
// It plays a scripted agent against the server over a real MCP client connection and counts the tokens of:
//   - the tool definitions and server instructions the model is given at the start of a session, and
//   - every tool result the model reads while doing realistic memory tasks (bench/tasks.json).
//
// Usage:
//   npx tsx bench/run.ts                 run every variant, print a table, write bench/results/latest.json
//   npx tsx bench/run.ts baseline        run one variant
//   npx tsx bench/run.ts --out file.json write somewhere else
//   npx tsx bench/run.ts --set holdout   use the held-out vault and questions instead
//
// Everything is deterministic: the vault is a fresh copy of bench/fixture-vault for every run, the clock is
// frozen at 2026-11-02T10:00:00Z and the time zone is UTC, so the same code gives the same numbers.
// No network is used. Tokens are counted locally with the o200k_base tokenizer (js-tiktoken). That is an
// OpenAI tokenizer used as a stand-in: Claude and Gemini tokenize differently, so absolute numbers will differ
// by model, but before/after ratios on the same tokenizer are comparable. Characters are reported too.

import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEncoding } from "js-tiktoken";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
// Two task sets. "dev" (bench/fixture-vault + tasks.json) is the one the search was tuned on. "holdout"
// (bench/holdout-vault + holdout-tasks.json) was written later and never used for tuning.
const SETS = {
  dev: { vault: path.join(BENCH_DIR, "fixture-vault"), tasks: path.join(BENCH_DIR, "tasks.json") },
  holdout: { vault: path.join(BENCH_DIR, "holdout-vault"), tasks: path.join(BENCH_DIR, "holdout-tasks.json") },
  test3: { vault: path.join(BENCH_DIR, "test3-vault"), tasks: path.join(BENCH_DIR, "test3-tasks.json") },
} as const;
export type SetName = keyof typeof SETS;
const FROZEN_NOW = Date.parse("2026-11-02T10:00:00.000Z");

process.env.TZ = "UTC";
freezeClock(FROZEN_NOW);

const encoder = getEncoding("o200k_base");
const countTokens = (text: string) => encoder.encode(text).length;

interface Variant {
  label: string;
  dir: string; // folder holding memory.ts and mcpServer.ts
  env: Record<string, string>;
}

export const VARIANTS: Record<string, Variant> = {
  // Not a server: every note pasted into the chat, the way people paste a handoff document. The quality
  // reference: the answer is always somewhere in what the AI reads.
  fullcontext: { label: "no server: all notes pasted into the chat", dir: "", env: {} },
  baseline: { label: "the original project before this work (frozen copy)", dir: path.join(BENCH_DIR, "baseline"), env: {} },
  current: { label: "this project, default settings (FTS5 keyword search only)", dir: path.join(BENCH_DIR, "..", "src"), env: {} },
  "current-ngram": {
    label: "this project, FTS5 + built-in character n-gram vectors",
    dir: path.join(BENCH_DIR, "..", "src"),
    env: { RAG_EMBEDDINGS: "ngram" },
  },
  // Opt-in: needs Ollama running on this computer with an embedding model pulled, for example
  //   ollama pull nomic-embed-text && npx tsx bench/run.ts baseline current current-ollama
  "current-ollama": {
    label: "this project, FTS5 + Ollama embeddings (local model)",
    dir: path.join(BENCH_DIR, "..", "src"),
    env: { RAG_EMBEDDINGS: "ollama", RAG_OLLAMA_MODEL: process.env.RAG_OLLAMA_MODEL || "nomic-embed-text" },
  },
};
const DEFAULT_VARIANTS = ["fullcontext", "baseline", "current", "current-ngram"];

interface Lookup {
  id: string;
  keyword: string;
  question: string;
  answer: string | null;
  note?: string;
}

interface WriteTask {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  read_first?: string;
  expect_file: string;
  expect_text: string;
}

export interface Tasks {
  session_start: { id: string; description: string; answer: string };
  lookups: Lookup[];
  writes: WriteTask[];
}

interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  argTokens: number;
  resultTokens: number;
  resultChars: number;
  wireTokens: number;
  isError: boolean;
  ms: number;
}

interface TaskRecord {
  id: string;
  kind: "start" | "lookup" | "write";
  query?: string;
  calls: CallRecord[];
  resultTokens: number;
  argTokens: number;
  answered: boolean | null; // null: the vault has no answer
  answeredBySearchAlone: boolean | null;
  answerRank: number | null; // 1-based position of the first search result that contains the answer
  writeLanded?: boolean;
}

export interface RunResult {
  set: SetName;
  variant: string;
  label: string;
  style: "keyword" | "question";
  tokenizer: string;
  frozenClock: string;
  node: string;
  definitions: {
    tools: number;
    toolNames: string[];
    modelFacingTokens: number;
    fullListTokens: number;
    instructionsTokens: number;
    perTool: { name: string; modelFacingTokens: number }[];
  };
  tasks: TaskRecord[];
  summary: {
    lookupTasks: number;
    answerableLookups: number;
    answered: number;
    answeredBySearchAlone: number;
    lookupResultTokens: number;
    lookupCalls: number;
    startTokens: number;
    startAnswersCovered: number; // lookup answers that already appear in the session-start context
    writeResultTokens: number;
    writesLanded: number;
    argTokens: number;
    sessionTotalTokens: number;
    meanReciprocalRank: number;
    // Tokens the AI reads to answer: tool descriptions, instructions, start summary and all lookups.
    readingTokens: number;
    // A short chat: tool descriptions, instructions, start summary and 3 lookups of average cost.
    quickChatTokens: number;
  };
}

export async function loadTasks(set: SetName): Promise<Tasks> {
  return JSON.parse(await readFile(SETS[set].tasks, "utf8")) as Tasks;
}

export async function runVariant(name: string, style: "keyword" | "question", tasks: Tasks, set: SetName): Promise<RunResult> {
  const FIXTURE = SETS[set].vault;
  const variant = VARIANTS[name];
  if (!variant) {
    throw new Error(`Unknown variant ${name}. Known: ${Object.keys(VARIANTS).join(", ")}`);
  }
  if (name === "fullcontext") {
    return runFullContext(style, tasks, set);
  }

  const base = await mkdtemp(path.join(os.tmpdir(), `bench-${name}-`));
  const vault = path.join(base, "vault");
  await cp(FIXTURE, vault, { recursive: true });

  const memory = await import(pathToFileURL(path.join(variant.dir, "memory.ts")).href);
  const server = await import(pathToFileURL(path.join(variant.dir, "mcpServer.ts")).href);
  const config = memory.getMemoryConfig({ AI_MEMORY_DIR: vault, ...variant.env });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.createObsidianMemoryMcpServer(config).connect(serverTransport);
  const client = new Client({ name: "token-benchmark", version: "1.0.0" });
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();
    const perTool = tools.map((tool) => ({
      name: tool.name,
      // What a model API receives for a tool: its name, description and input schema.
      modelFacingTokens: countTokens(
        JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }),
      ),
    }));
    const instructions = client.getInstructions() ?? "";

    const call = async (tool: string, args: Record<string, unknown> = {}): Promise<CallRecord & { text: string }> => {
      const started = performance.now();
      let text: string;
      let wire: string;
      let isError = false;
      try {
        const result = await client.callTool({ name: tool, arguments: args });
        text = (result.content as { type: string; text?: string }[])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        wire = JSON.stringify(result);
        isError = Boolean(result.isError);
      } catch (error) {
        text = error instanceof Error ? error.message : String(error);
        wire = text;
        isError = true;
      }
      return {
        tool,
        args,
        argTokens: countTokens(JSON.stringify(args)),
        resultTokens: countTokens(text),
        resultChars: text.length,
        wireTokens: countTokens(wire),
        isError,
        ms: Math.round((performance.now() - started) * 10) / 10,
        text,
      };
    };

    const records: TaskRecord[] = [];

    // 1. Session start.
    let startText = "";
    {
      const result = await call("read_main_context");
      startText = result.text;
      records.push(finishTask({ id: tasks.session_start.id, kind: "start" }, [result], {
        answered: contains(result.text, tasks.session_start.answer),
        answeredBySearchAlone: null,
        answerRank: null,
      }));
    }

    // 2. Lookups. The scripted agent searches once. If the answer is not in the search result, it reads one
    // listed note: the first listed note that really contains the answer (an ideal agent that picks the right
    // note from the list), or the first listed note if none does. Then it stops.
    for (const lookup of tasks.lookups) {
      const query = style === "keyword" ? lookup.keyword : lookup.question;
      const search = await call("search_memory", { query });
      const calls = [search];
      const items = splitSearchItems(search.text);
      const rankIndex = lookup.answer ? items.findIndex((item) => contains(item, lookup.answer!)) : -1;
      let answered = lookup.answer ? contains(search.text, lookup.answer) : null;
      const bySearch = answered;

      if (lookup.answer && !answered) {
        const listed = listedPaths(search.text);
        let pick: string | undefined;
        for (const candidate of listed) {
          const raw = await readFile(path.join(vault, candidate), "utf8").catch(() => "");
          if (contains(raw, lookup.answer)) {
            pick = candidate;
            break;
          }
        }
        pick ??= listed[0];
        if (pick) {
          const read = await call("read_note", { path: pick });
          calls.push(read);
          answered = contains(read.text, lookup.answer);
        }
      }

      records.push(finishTask({ id: lookup.id, kind: "lookup", query }, calls, {
        answered,
        answeredBySearchAlone: bySearch,
        answerRank: rankIndex >= 0 ? rankIndex + 1 : null,
      }));
    }

    // 3. Writes, last, so they cannot change what the lookups see.
    for (const write of tasks.writes) {
      const calls = [];
      if (write.read_first) {
        calls.push(await call(write.read_first));
      }
      calls.push(await call(write.tool, write.arguments));
      const landed = contains(await readFile(path.join(vault, write.expect_file), "utf8").catch(() => ""), write.expect_text);
      const record = finishTask({ id: write.id, kind: "write" }, calls, {
        answered: null,
        answeredBySearchAlone: null,
        answerRank: null,
      });
      record.writeLanded = landed;
      records.push(record);
    }

    const lookups = records.filter((r) => r.kind === "lookup");
    const answerable = lookups.filter((r) => r.answered !== null);
    const writes = records.filter((r) => r.kind === "write");
    const definitionsTokens = perTool.reduce((sum, t) => sum + t.modelFacingTokens, 0);
    const instructionsTokens = countTokens(instructions);
    const allResultTokens = records.reduce((sum, r) => sum + r.resultTokens, 0);
    const argTokens = records.reduce((sum, r) => sum + r.argTokens, 0);

    return {
      set,
      variant: name,
      label: variant.label,
      style,
      tokenizer: "o200k_base (js-tiktoken)",
      frozenClock: new Date(FROZEN_NOW).toISOString(),
      node: process.version,
      definitions: {
        tools: tools.length,
        toolNames: tools.map((t) => t.name),
        modelFacingTokens: definitionsTokens,
        fullListTokens: countTokens(JSON.stringify({ tools })),
        instructionsTokens,
        perTool,
      },
      tasks: records,
      summary: {
        lookupTasks: lookups.length,
        answerableLookups: answerable.length,
        answered: answerable.filter((r) => r.answered).length,
        answeredBySearchAlone: answerable.filter((r) => r.answeredBySearchAlone).length,
        lookupResultTokens: lookups.reduce((sum, r) => sum + r.resultTokens, 0),
        lookupCalls: lookups.reduce((sum, r) => sum + r.calls.length, 0),
        startTokens: records.filter((r) => r.kind === "start").reduce((sum, r) => sum + r.resultTokens, 0),
        startAnswersCovered: tasks.lookups.filter((l) => l.answer && contains(startText, l.answer)).length,
        writeResultTokens: writes.reduce((sum, r) => sum + r.resultTokens, 0),
        writesLanded: writes.filter((r) => r.writeLanded).length,
        argTokens,
        sessionTotalTokens: definitionsTokens + instructionsTokens + allResultTokens + argTokens,
        readingTokens:
          definitionsTokens +
          instructionsTokens +
          records.filter((r) => r.kind !== "write").reduce((sum, r) => sum + r.resultTokens, 0),
        quickChatTokens: Math.round(
          definitionsTokens +
            instructionsTokens +
            records.filter((r) => r.kind === "start").reduce((sum, r) => sum + r.resultTokens, 0) +
            (3 * lookups.reduce((sum, r) => sum + r.resultTokens, 0)) / Math.max(1, lookups.length),
        ),
        meanReciprocalRank: round3(
          answerable.reduce((sum, r) => sum + (r.answerRank ? 1 / r.answerRank : 0), 0) / Math.max(1, answerable.length),
        ),
      },
    };
  } finally {
    await client.close();
    await rm(base, { recursive: true, force: true });
  }
}

// The "paste everything" approach: no tools, every note in the chat once. Lookups then cost nothing extra,
// and the answer is always present if it is anywhere in the vault.
async function runFullContext(style: "keyword" | "question", tasks: Tasks, set: SetName): Promise<RunResult> {
  const FIXTURE = SETS[set].vault;
  const files = (await listMarkdown(FIXTURE)).sort();
  const parts: string[] = [];
  for (const file of files) {
    parts.push(`## ${path.relative(FIXTURE, file).split(path.sep).join("/")}\n\n${(await readFile(file, "utf8")).trim()}`);
  }
  const all = parts.join("\n\n");
  const tokens = countTokens(all);
  const answerable = tasks.lookups.filter((l) => l.answer);
  const records: TaskRecord[] = [
    { id: tasks.session_start.id, kind: "start", calls: [], resultTokens: tokens, argTokens: 0, answered: contains(all, tasks.session_start.answer), answeredBySearchAlone: null, answerRank: null },
    ...tasks.lookups.map((l) => ({
      id: l.id,
      kind: "lookup" as const,
      query: style === "keyword" ? l.keyword : l.question,
      calls: [],
      resultTokens: 0,
      argTokens: 0,
      answered: l.answer ? contains(all, l.answer) : null,
      answeredBySearchAlone: l.answer ? contains(all, l.answer) : null,
      answerRank: null,
    })),
  ];
  return {
    set,
    variant: "fullcontext",
    label: VARIANTS.fullcontext.label,
    style,
    tokenizer: "o200k_base (js-tiktoken)",
    frozenClock: new Date(FROZEN_NOW).toISOString(),
    node: process.version,
    definitions: { tools: 0, toolNames: [], modelFacingTokens: 0, fullListTokens: 0, instructionsTokens: 0, perTool: [] },
    tasks: records,
    summary: {
      lookupTasks: tasks.lookups.length,
      answerableLookups: answerable.length,
      answered: answerable.filter((l) => contains(all, l.answer!)).length,
      answeredBySearchAlone: answerable.filter((l) => contains(all, l.answer!)).length,
      lookupResultTokens: 0,
      lookupCalls: 0,
      startTokens: tokens,
      startAnswersCovered: answerable.filter((l) => contains(all, l.answer!)).length,
      writeResultTokens: 0,
      writesLanded: 0,
      argTokens: 0,
      sessionTotalTokens: tokens,
      meanReciprocalRank: 1,
      readingTokens: tokens,
      quickChatTokens: tokens,
    },
  };
}

async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function finishTask(
  head: { id: string; kind: TaskRecord["kind"]; query?: string },
  calls: (CallRecord & { text?: string })[],
  outcome: Pick<TaskRecord, "answered" | "answeredBySearchAlone" | "answerRank">,
): TaskRecord {
  const clean = calls.map(({ text: _text, ...rest }) => rest);
  return {
    ...head,
    calls: clean,
    resultTokens: clean.reduce((sum, c) => sum + c.resultTokens, 0),
    argTokens: clean.reduce((sum, c) => sum + c.argTokens, 0),
    ...outcome,
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function contains(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

// Splits a search_memory result into its individual hits, for either output format.
function splitSearchItems(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { matches?: { path: string; snippet: string }[] };
      return (parsed.matches ?? []).map((m) => `${m.path} ${m.snippet}`);
    } catch {
      return [text];
    }
  }
  return [...text.matchAll(/<note\b[^>]*>([\s\S]*?)<\/note>/g)].map((m) => m[0]);
}

// Lists the note paths a search result points to, in order, without duplicates.
function listedPaths(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(/"path":\s*"([^"]+)"|\bpath="([^"]+)"/g)) {
    const found = (match[1] ?? match[2]).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (!seen.includes(found)) {
      seen.push(found);
    }
  }
  return seen;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function freezeClock(now: number): void {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(now);
      } else {
        // @ts-expect-error forwarding constructor arguments
        super(...args);
      }
    }
    static now(): number {
      return now;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
}

function pct(after: number, before: number): string {
  if (before === 0) {
    return "n/a";
  }
  const change = ((after - before) / before) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function printSummary(results: RunResult[]): void {
  const rows = results.map((r) => [
    `${r.variant} / ${r.style}`,
    r.definitions.tools,
    r.definitions.modelFacingTokens + r.definitions.instructionsTokens,
    r.summary.startTokens,
    `${r.summary.startAnswersCovered}/${r.summary.answerableLookups}`,
    r.summary.lookupResultTokens,
    r.summary.writeResultTokens,
    r.summary.sessionTotalTokens,
    r.summary.readingTokens,
    r.summary.quickChatTokens,
    `${r.summary.answered}/${r.summary.answerableLookups}`,
    `${r.summary.answeredBySearchAlone}/${r.summary.answerableLookups}`,
    r.summary.meanReciprocalRank,
  ]);
  const header = ["run", "tools", "defs+instr", "start", "start covers", "lookups", "writes", "session total", "reading", "quick chat", "answered", "by search alone", "MRR"];
  console.log(`| ${header.join(" | ")} |`);
  console.log(`|${header.map(() => "---").join("|")}|`);
  for (const row of rows) {
    console.log(`| ${row.join(" | ")} |`);
  }

  const before = results.find((r) => r.variant === "baseline" && r.style === "keyword");
  if (before) {
    console.log("\nChange against baseline / keyword:");
    for (const r of results) {
      if (r === before) continue;
      console.log(
        `  ${r.variant} / ${r.style}: session ${pct(r.summary.sessionTotalTokens, before.summary.sessionTotalTokens)}, ` +
          `definitions ${pct(r.definitions.modelFacingTokens + r.definitions.instructionsTokens, before.definitions.modelFacingTokens + before.definitions.instructionsTokens)}, ` +
          `start ${pct(r.summary.startTokens, before.summary.startTokens)}, lookups ${pct(r.summary.lookupResultTokens, before.summary.lookupResultTokens)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : path.join(BENCH_DIR, "results", "latest.json");
  const setIndex = args.indexOf("--set");
  const set = (setIndex >= 0 ? args.splice(setIndex, 2)[1] : "dev") as SetName;
  if (!(set in SETS)) {
    throw new Error(`--set must be one of: ${Object.keys(SETS).join(", ")}`);
  }
  const names = args.length > 0 ? args : DEFAULT_VARIANTS;
  const tasks = await loadTasks(set);

  const results: RunResult[] = [];
  for (const name of names) {
    for (const style of ["keyword", "question"] as const) {
      results.push(await runVariant(name, style, tasks, set));
    }
  }

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  printSummary(results);
  console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
}

// Runs only when started as a script (npx tsx bench/run.ts), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
