// Shows exactly what the model would read for one or more tool calls, on a fresh copy of the fixture vault.
//
//   npx tsx bench/show.mts search_memory '{"query":"Why did we choose SQLite?"}'
//   npx tsx bench/show.mts read_main_context
//   BENCH_SERVER=baseline npx tsx bench/show.mts search_memory '{"query":"Postgres"}'   (the old server)
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = process.env.BENCH_SERVER === "baseline" ? path.join(benchDir, "baseline") : path.join(benchDir, "..", "src");
const memory = await import(pathToFileURL(path.join(serverDir, "memory.ts")).href);
const { createObsidianMemoryMcpServer } = await import(pathToFileURL(path.join(serverDir, "mcpServer.ts")).href);

const base = await mkdtemp(path.join(os.tmpdir(), "show-"));
const vault = path.join(base, "vault");
await cp(path.join(benchDir, "fixture-vault"), vault, { recursive: true });

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await createObsidianMemoryMcpServer(memory.getMemoryConfig({ ...process.env, AI_MEMORY_DIR: vault })).connect(serverTransport);
const client = new Client({ name: "show", version: "1.0.0" });
await client.connect(clientTransport);

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const name = args[i];
  const input = args[i + 1]?.startsWith("{") ? JSON.parse(args[++i]) : {};
  const result = await client.callTool({ name, arguments: input });
  const text = (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
  console.log(`=== ${name} ${JSON.stringify(input)}\n${text}\n`);
}

await client.close();
await rm(base, { recursive: true, force: true });
