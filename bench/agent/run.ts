// Optional end-to-end evaluation: a Claude model answers fixed questions about the made-up notes in
// bench/agent/vault through this server's MCP tools, and every request, tool call, reply and billed usage is saved
// as a run folder (bench/lib/runs.ts) that `npm run bench:verify` can recheck without calling the model again.
//
//   npm run bench:agent:dry                          free: a scripted stand-in for the model, nothing is sent
//   npx tsx bench/agent/run.ts --budget-usd 5        paid: needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)
//
// Options:
//   --model <id>            the model, pinned by its exact id (default claude-opus-5-5)
//   --repeats <n>           runs of every question, to see how much answers vary (default 3)
//   --effort <level>        low, medium, high, xhigh or max (default medium), sent as output_config.effort
//   --max-tokens <n>        max_tokens of every request (default 8000)
//   --max-tool-calls <n>    tool calls allowed per question; further calls are refused (default 6)
//   --max-requests <n>      requests to the model per question (default 8)
//   --only <id,id>          only these question ids
//   --out <folder>          where run folders go (default bench/runs; a dry run defaults to a temporary folder)
//
// A paid run stops before the next request once the billed usage, priced at list prices, reaches --budget-usd;
// the questions not run are saved as "not-run" errors, so the run is visibly incomplete. Without credentials or
// without --budget-usd it sends nothing, prints UNRUN and exits with status 0.
//
// Only the test notes in bench/agent/vault are sent to the API: there is no option to point it at another folder.
// Every conversation gets a fresh copy of them, so a write by one conversation cannot affect the next.
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEncoding } from "js-tiktoken";
import { getMemoryConfig } from "../../src/memory.js";
import { createObsidianMemoryMcpServer } from "../../src/mcpServer.js";
import { closeMemoryIndex } from "../../src/retrieval/memoryIndex.js";
import { agentCalls, RunWriter, type AgentTurn, type QueryRecord } from "../lib/runs.js";
import { judgeAgent, parseAgentReply, type AgentGold } from "../lib/scoring.js";
import { verifyRun } from "../verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const VAULT = path.join(HERE, "vault");

// List prices in US dollars per million tokens (Anthropic API, as given in the claude-api reference cached on
// 2026-10-06), used only to stop a paid run at its budget. Where a rate was not given, a higher one is used, so the
// stop comes early rather than late. The record of a run is the billed token counts, not dollars.
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.5 },
};

// Appended to the skill to make the reply checkable. It names the reply's form, not any answer.
const EVALUATION_RULES = `
## This evaluation

The user asks one question about their project. Answer it from the memory tools. End your reply with exactly
these two lines:

ANSWER: <the short answer>
SOURCES: <the note paths the answer comes from, separated by commas, or none>

Write UNKNOWN as the answer when the memory does not hold it. When notes disagree and the skill says to ask the
user, write CONFLICT as the first word of the answer, followed by both versions.
`;

interface Question extends AgentGold {
  id: string;
  case: string;
  question: string;
}

interface Settings {
  model: string;
  repeats: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  maxToolCalls: number;
  maxRequests: number;
}

interface ModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positive(name: string, fallback: number): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number above 0`);
  return n;
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

async function treeHash(dir: string): Promise<string> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  const lines = await Promise.all(files.sort().map(async (f) => `${path.relative(dir, f)}\0${sha256(await readFile(f))}`));
  return sha256(lines.join("\n"));
}

// The skill as shipped (without its front matter), then the evaluation's reply format.
async function systemPrompt(): Promise<string> {
  const skill = await readFile(path.join(ROOT, "skills", "rag-memory", "SKILL.md"), "utf8");
  return `${skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}\n${EVALUATION_RULES}`;
}

// ---------------------------------------------------------------------------------------------------------
// The stand-in model for dry runs: it searches with the question, then answers with the first sentence of the
// first result. It exercises the tools, the trace, the judging and the run folder; its answers say nothing about
// any real model.

function scriptedModel(): ModelClient {
  let n = 0;
  const message = (content: Anthropic.ContentBlock[], stop: Anthropic.StopReason): Anthropic.Message => ({
    id: `dry-run-${++n}`,
    type: "message",
    role: "assistant",
    model: "dry-run",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  });
  return {
    async create(params) {
      const first = params.messages[0].content;
      const question = typeof first === "string" ? first : "";
      const last = params.messages[params.messages.length - 1].content;
      const result = (Array.isArray(last) ? last.find((b) => b.type === "tool_result") : undefined) as Anthropic.ToolResultBlockParam | undefined;
      if (!result) {
        return message([{ type: "tool_use", id: `toolu_dry_${n}`, name: "search_memory", input: { query: question }, caller: { type: "direct" } }], "tool_use");
      }
      const text = typeof result.content === "string" ? result.content : (result.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const hit = /<note path="([^"]+)"[^>]*>([\s\S]*?)<\/note>/.exec(text);
      const sentence = hit ? hit[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] : "";
      const reply = hit && sentence ? `ANSWER: ${sentence}\nSOURCES: ${hit[1]}` : "ANSWER: UNKNOWN\nSOURCES: none";
      return message([{ type: "text", text: reply, citations: null }], "end_turn");
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// One conversation: a fresh copy of the notes, the real server over an in-memory MCP connection, and the
// request, tool call, tool result loop until the model answers or a limit is reached.

interface Conversation {
  reply: string;
  trace: AgentTurn[];
  stop: NonNullable<QueryRecord["stop"]>;
  error: string | null;
  toolsSha256: string;
  fatal?: boolean; // credentials rejected: no later conversation can work either
}

const cost = (model: string, u: AgentTurn["usage"]) => {
  const p = PRICES[model];
  return p ? (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6 : 0;
};

async function converse(model: ModelClient, q: Question, settings: Settings, system: string, overBudget: () => boolean, spend: (usd: number) => void): Promise<Conversation> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "rag-agent-"));
  await cp(VAULT, vault, { recursive: true });
  const env: Record<string, string> = { AI_MEMORY_DIR: vault, MCP_MAX_CALLS_PER_MINUTE: "1000" };
  for (const name of ["RAG_EMBEDDINGS", "RAG_OLLAMA_MODEL", "RAG_RETRIEVAL"]) if (process.env[name]) env[name] = process.env[name]!;
  const config = getMemoryConfig(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createObsidianMemoryMcpServer(config).connect(serverTransport);
  const client = new Client({ name: "agent-evaluation", version: "1.0.0" });
  await client.connect(clientTransport);
  const trace: AgentTurn[] = [];
  try {
    const listed = (await client.listTools()).tools;
    const tools: Anthropic.Tool[] = listed.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
    const toolsSha256 = sha256(JSON.stringify(tools));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: q.question }];
    let toolCalls = 0;
    for (let request = 0; request < settings.maxRequests; request++) {
      if (overBudget()) return { reply: "", trace, stop: "not-run", error: "budget reached during this question", toolsSha256 };
      const started = performance.now();
      let response: Anthropic.Message;
      try {
        response = await model.create({
          model: settings.model,
          max_tokens: settings.maxTokens,
          system,
          tools,
          messages,
          output_config: { effort: settings.effort },
          cache_control: { type: "ephemeral" },
        });
      } catch (e) {
        const fatal = e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError;
        const message = e instanceof Anthropic.APIError ? `${e.status ?? ""} ${e.message}`.trim() : e instanceof Error ? e.message : String(e);
        return { reply: "", trace, stop: "error", error: message, toolsSha256, fatal };
      }
      const u = response.usage;
      const turn: AgentTurn = {
        model: response.model,
        stopReason: response.stop_reason,
        usage: {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? null,
        },
        blocks: response.content.map((b) =>
          b.type === "text" ? { type: "text", text: b.text } : b.type === "thinking" ? { type: "thinking", chars: b.thinking.length } : { type: b.type },
        ),
        toolCalls: [],
        ms: 0,
      };
      trace.push(turn);
      spend(cost(settings.model, turn.usage));
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (response.stop_reason === "refusal") return { reply: text, trace, stop: "refusal", error: null, toolsSha256 };
      if (response.stop_reason === "max_tokens") return { reply: text, trace, stop: "max-tokens", error: null, toolsSha256 };
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        turn.ms = Math.round(performance.now() - started);
        continue;
      }
      if (uses.length === 0) {
        turn.ms = Math.round(performance.now() - started);
        return { reply: text, trace, stop: "answered", error: null, toolsSha256 };
      }
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const callStarted = performance.now();
        let output: string;
        let isError: boolean;
        let refused: string | undefined;
        if (toolCalls >= settings.maxToolCalls) {
          refused = "tool budget";
          output = `Not run: the tool budget for this question (${settings.maxToolCalls} calls) is used up. Answer now from what you have.`;
          isError = true;
        } else {
          const result = await client.callTool({ name: use.name, arguments: use.input as Record<string, unknown> });
          output = (result.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
          isError = Boolean(result.isError);
        }
        toolCalls++;
        turn.toolCalls.push({ id: use.id, name: use.name, input: use.input, output, isError, ms: Math.round(performance.now() - callStarted), ...(refused ? { refused } : {}) });
        results.push({ type: "tool_result", tool_use_id: use.id, content: output, ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      turn.ms = Math.round(performance.now() - started);
    }
    return { reply: "", trace, stop: "request-limit", error: null, toolsSha256 };
  } finally {
    await client.close();
    closeMemoryIndex(config);
    await rm(vault, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const settings: Settings = {
    model: dry ? "dry-run" : (option("model") ?? "claude-opus-5-5"),
    repeats: positive("repeats", dry ? 1 : 3),
    effort: (option("effort") ?? "medium") as Settings["effort"],
    maxTokens: positive("max-tokens", 8000),
    maxToolCalls: positive("max-tool-calls", 6),
    maxRequests: positive("max-requests", 8),
  };
  if (!["low", "medium", "high", "xhigh", "max"].includes(settings.effort)) throw new Error("--effort must be low, medium, high, xhigh or max");
  const set = JSON.parse(await readFile(path.join(HERE, "questions.json"), "utf8")) as { version: string; questions: Question[] };
  const only = option("only")?.split(",");
  const questions = set.questions.filter((q) => !only || only.includes(q.id));
  if (questions.length === 0) throw new Error("no questions selected");
  const conversations = questions.length * settings.repeats;

  let budgetUsd = Infinity;
  let model: ModelClient;
  if (dry) {
    model = scriptedModel();
  } else {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.log("UNRUN: no Anthropic credentials (set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN). Nothing was sent.");
      console.log("The free check of the same plumbing: npm run bench:agent:dry");
      return;
    }
    if (!PRICES[settings.model]) throw new Error(`no list price recorded for ${settings.model}; add it to PRICES in bench/agent/run.ts so the budget can be enforced`);
    const given = option("budget-usd");
    if (given === undefined || !(Number(given) > 0)) {
      console.log(`UNRUN: no approved budget. Pass --budget-usd <dollars> to run ${conversations} conversations on ${settings.model}.`);
      console.log("Nothing was sent.");
      return;
    }
    budgetUsd = Number(given);
    const anthropic = new Anthropic({ maxRetries: 2, timeout: 120_000 });
    model = { create: (params) => anthropic.messages.create(params) };
  }

  const system = await systemPrompt();
  const benchmark = dry ? "agent-dry-run" : "agent";
  const base = path.resolve(option("out") ?? (dry ? path.join(os.tmpdir(), "rag-memory-agent-runs") : path.join(ROOT, "bench", "runs")));
  const sdkVersion = JSON.parse(await readFile(path.join(ROOT, "node_modules", "@anthropic-ai", "sdk", "package.json"), "utf8")).version as string;
  const group = settings.model;
  const writer = await RunWriter.start(ROOT, base, benchmark, {
    config: {
      ...settings,
      budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
      pricesUsdPerMillionTokens: dry ? null : PRICES[settings.model],
      thinking: "not set: the model's default",
      sampling: "not set: no temperature or seed (the API takes none on current models), so repeats show run-to-run variation",
      promptCaching: "automatic (top-level cache_control ephemeral)",
      serverFallbacks: "off: a refusal is recorded, not answered by another model",
      sdk: `@anthropic-ai/sdk ${sdkVersion}, maxRetries 2, timeout 120 s`,
      retrieval: process.env.RAG_EMBEDDINGS ? `${process.env.RAG_RETRIEVAL ?? "hybrid"} with ${process.env.RAG_EMBEDDINGS} ${process.env.RAG_OLLAMA_MODEL ?? ""}`.trim() : "keyword (no embedding model)",
      systemPromptSha256: sha256(system),
      systemPrompt: system,
    },
    data: {
      questions: { file: "bench/agent/questions.json", version: set.version, sha256: sha256(await readFile(path.join(HERE, "questions.json"))), ids: questions.map((q) => q.id) },
      notes: { folder: "bench/agent/vault", treeSha256: await treeHash(VAULT), license: "made up for this repository (MIT)" },
    },
    plan: [{ name: group, queries: conversations, about: { model: settings.model, repeats: settings.repeats }, breakdowns: ["case"] }],
  });

  const encoder = getEncoding("o200k_base");
  let spent = 0;
  let stopAll: string | null = null;
  let toolsSha256: string | null = null;
  for (let repeat = 1; repeat <= settings.repeats; repeat++) {
    for (const q of questions) {
      const gold: AgentGold = { expect: q.expect, answers: q.answers, wrong: q.wrong, sources: q.sources, canary: q.canary };
      const started = performance.now();
      const c: Conversation = stopAll
        ? { reply: "", trace: [], stop: "not-run", error: `not run: ${stopAll}`, toolsSha256: toolsSha256 ?? "" }
        : await converse(model, q, settings, system, () => spent >= budgetUsd, (usd) => (spent += usd));
      if (c.fatal) stopAll = c.error;
      if (!stopAll && spent >= budgetUsd) stopAll = `budget of $${budgetUsd} reached`;
      if (toolsSha256 && c.toolsSha256 && c.toolsSha256 !== toolsSha256) throw new Error("the tool definitions changed between conversations");
      toolsSha256 ??= c.toolsSha256 || null;
      const record: QueryRecord = {
        kind: "agent",
        group,
        id: `${q.id}#r${repeat}`,
        query: q.question,
        gold: { expect: q.expect, answers: q.answers, wrong: q.wrong, sources: q.sources, canary: q.canary },
        tags: { case: q.case, expect: q.expect },
        output: c.reply,
        retrieved: [],
        correct: {},
        tokens: 0,
        ms: Math.round(performance.now() - started),
        error: c.error,
        repeat,
        trace: c.trace,
        stop: c.stop,
      };
      record.correct = judgeAgent(record.output, agentCalls(record), gold);
      record.tokens = agentCalls(record).reduce((sum, call) => sum + encoder.encode(call.output).length, 0);
      writer.record(record);
      const judged = record.correct;
      console.log(
        `${record.id.padEnd(26)} ${String(c.stop).padEnd(13)} ${judged.correct ? "right" : "wrong"}  tools ${judged.toolCalls}  writes ${judged.writeCalls}  answer: ${parseAgentReply(c.reply).answer ?? "(no ANSWER line)"}${c.error ? `  error: ${c.error}` : ""}`,
      );
    }
  }
  const definitionTokens = encoder.encode(system).length;
  await writer.finish({ systemPromptTokens: definitionTokens, toolDefinitionsSha256: toolsSha256, spentUsdAtListPrices: dry ? 0 : Math.round(spent * 10_000) / 10_000 });
  console.log(`\nWrote ${path.relative(process.cwd(), writer.dir)}`);

  const problems = await verifyRun(writer.dir, true);
  if (problems.length) {
    console.log(`Verification failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Verified: the summary and tables match the records.");
  if (dry) {
    // The plumbing check: every conversation ran, used a tool, ended with the reply format, and no private text
    // reached the model. The stand-in's right/wrong numbers are not a result.
    const { readRecords } = await import("../lib/runs.js");
    const failures = (await readRecords(writer.dir)).filter(
      (r) => r.error !== null || r.stop !== "answered" || (r.correct.toolCalls as number) < 1 || r.correct.formatOk !== true || r.correct.privateLeak === true,
    );
    if (failures.length) {
      console.log(`Dry run failed for: ${failures.map((r) => r.id).join(", ")}`);
      process.exit(1);
    }
    console.log(`Dry run passed: ${conversations} conversations through the real MCP tools, records verified. (Stand-in model: its answers are not a result.)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
