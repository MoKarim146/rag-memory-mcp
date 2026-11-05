// Scaling benchmark: how search time and output size change as the vault grows.
//
//   npx tsx bench/scale.ts            (pin to one CPU core to imitate a slow laptop:  taskset -c 0 npx tsx bench/scale.ts)
//
// The larger vaults are SYNTHETIC: copies of bench/fixture-vault placed under Archive/copy-N/, each file
// tagged with its copy number so no two files are identical, and the decision and task logs grown with
// extra entries. They test speed and output size, not answer quality. Results go to bench/results/scale.json.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEncoding } from "js-tiktoken";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(BENCH_DIR, "fixture-vault");
const encoder = getEncoding("o200k_base");
const tokens = (text: string) => encoder.encode(text).length;
const QUERIES = ["delivery", "PayLoop webhook secret rotation", "What is the contrast ratio of the Add to basket button?"];

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function buildVault(copies: number, growLogs: number): Promise<{ dir: string; notes: number; bytes: number }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "scale-"));
  const dir = path.join(base, "vault");
  await cp(FIXTURE, dir, { recursive: true });
  const files = (await listFiles(FIXTURE)).filter((f) => !/^0\d_/.test(f));
  for (let c = 1; c < copies; c += 1) {
    for (const file of files) {
      const target = path.join(dir, "Archive", `copy-${c}`, file);
      await mkdir(path.dirname(target), { recursive: true });
      const text = await readFile(path.join(FIXTURE, file), "utf8");
      await writeFile(target, `Archived copy ${c}.\n\n${text}`);
    }
  }
  if (growLogs > 1) {
    const decisions = await readFile(path.join(FIXTURE, "02_DECISIONS.md"), "utf8");
    const tasks = await readFile(path.join(FIXTURE, "03_OPEN_TASKS.md"), "utf8");
    const decisionBody = decisions.replace(/^# Decisions\n/, "");
    const doneTasks = tasks.split("\n").filter((l) => l.startsWith("- [x]")).join("\n");
    let grownDecisions = "# Decisions\n";
    let grownTasks = "# Open Tasks\n\n";
    for (let g = growLogs - 1; g >= 1; g -= 1) {
      grownDecisions += decisionBody.replace(/## 2026-/g, `## ${2026 - g}-`);
      grownTasks += `${doneTasks.replace(/2026-/g, `${2026 - g}-`)}\n`;
    }
    grownDecisions += decisionBody;
    grownTasks += tasks.replace(/^# Open Tasks\n\n/, "");
    await writeFile(path.join(dir, "02_DECISIONS.md"), grownDecisions);
    await writeFile(path.join(dir, "03_OPEN_TASKS.md"), grownTasks);
  }
  const all = await listFiles(dir);
  let bytes = 0;
  for (const f of all) bytes += (await readFile(path.join(dir, f))).length;
  return { dir, notes: all.length, bytes };
}

async function connect(serverDir: string, vault: string, env: Record<string, string> = {}) {
  const memory = await import(pathToFileURL(path.join(serverDir, "memory.ts")).href);
  const server = await import(pathToFileURL(path.join(serverDir, "mcpServer.ts")).href);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.createObsidianMemoryMcpServer(memory.getMemoryConfig({ AI_MEMORY_DIR: vault, ...env })).connect(serverTransport);
  const client = new Client({ name: "scale", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function definitionTokens(client: Client): Promise<number> {
  const { tools } = await client.listTools();
  const defs = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema })).join("");
  return tokens(defs) + tokens(client.getInstructions() ?? "");
}

async function timed(client: Client, name: string, args: Record<string, unknown>) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - start;
  const text = (result.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
  return { ms: Math.round(ms * 10) / 10, tokens: tokens(text) };
}

async function main() {
  const sizes = [
    { label: "fixture (32 notes)", copies: 1, grow: 1 },
    { label: "~500 notes, logs x5", copies: 18, grow: 5 },
    { label: "~2,000 notes, logs x10", copies: 70, grow: 10 },
    { label: "~5,000 notes, logs x20", copies: 175, grow: 20 },
  ];
  const rows = [];
  for (const size of sizes) {
    const vault = await buildVault(size.copies, size.grow);
    const row: Record<string, unknown> = { vault: size.label, notes: vault.notes, megabytes: Math.round((vault.bytes / 1e6) * 100) / 100 };
    // Pasting every note into the chat.
    let all = "";
    for (const f of (await listFiles(vault.dir)).sort()) all += `## ${f}\n\n${await readFile(path.join(vault.dir, f), "utf8")}\n\n`;
    row.pasteEverythingTokens = tokens(all);

    const before = await connect(path.join(BENCH_DIR, "baseline"), vault.dir);
    row.baselineStartTokens = (await timed(before, "read_main_context", {})).tokens;
    const baselineSearches = [];
    for (const query of QUERIES) baselineSearches.push(await timed(before, "search_memory", { query }));
    row.baselineSearch = baselineSearches;
    row.baselineDefinitionTokens = await definitionTokens(before);
    await before.close();

    const rssBefore = process.memoryUsage().rss;
    const after = await connect(path.join(BENCH_DIR, "..", "src"), vault.dir);
    row.currentStartTokens = (await timed(after, "read_main_context", {})).tokens;
    row.firstSearchMs = (await timed(after, "search_memory", { query: "warm up" })).ms; // builds the index
    const currentSearches = [];
    for (const query of QUERIES) currentSearches.push(await timed(after, "search_memory", { query }));
    row.currentSearch = currentSearches;
    row.currentDefinitionTokens = await definitionTokens(after);
    // A short chat: tool descriptions and instructions, the start summary, and the 3 example searches.
    const quick = (defs: number, start: number, searches: { tokens: number }[]) => defs + start + searches.reduce((sum, s) => sum + s.tokens, 0);
    row.quickChatPasteEverything = row.pasteEverythingTokens;
    row.quickChatOldServer = quick(row.baselineDefinitionTokens as number, row.baselineStartTokens as number, baselineSearches);
    row.quickChatThisServer = quick(row.currentDefinitionTokens as number, row.currentStartTokens as number, currentSearches);
    await writeFile(path.join(vault.dir, "Projects", "payments.md"), "# Payments\n\nChanged note, webhook secret rotation moved.\n");
    row.searchAfterOneEditMs = (await timed(after, "search_memory", { query: "webhook" })).ms;
    row.rssGrowthMB = Math.round((process.memoryUsage().rss - rssBefore) / 1e6);
    await after.close();

    rows.push(row);
    console.log(JSON.stringify(row));
    await rm(path.dirname(vault.dir), { recursive: true, force: true });
  }
  await writeFile(
    path.join(BENCH_DIR, "results", "scale.json"),
    `${JSON.stringify({ node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, queries: QUERIES, rows }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
