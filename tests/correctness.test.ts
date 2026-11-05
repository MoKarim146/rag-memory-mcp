// Stage 1 correctness and isolation tests. Each "defect" test reproduced a problem on the code before its fix;
// "check" tests confirm behaviour that was inspected and found correct, so it stays that way.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createObsidianMemoryMcpServer } from "../src/mcpServer.js";
import { ensureMemoryLayout, getMemoryConfig, type MemoryConfig, updateHandoffSummary } from "../src/memory.js";
import type { Embedder } from "../src/retrieval/embeddings.js";
import { MemoryIndex } from "../src/retrieval/memoryIndex.js";

const run = promisify(execFile);
const ROOT = path.join(__dirname, "..");
const HISTORY = path.join(".history", "04_MODEL_HANDOFF.md");

async function vault(env: Record<string, string> = {}): Promise<MemoryConfig> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "correctness-"));
  const config = getMemoryConfig({ AI_MEMORY_DIR: rootDir, AI_MEMORY_WRITE_REVIEW: "off", ...env });
  await ensureMemoryLayout(config);
  return config;
}

async function client(config: MemoryConfig): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createObsidianMemoryMcpServer(config).connect(serverTransport);
  const c = new Client({ name: "correctness", version: "0" });
  await c.connect(clientTransport);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name, arguments: args });
  return { ok: !result.isError, text: (result.content as { text?: string }[]).map((p) => p.text ?? "").join("\n") };
}

// Every replaced version must appear in the history exactly once.
async function historyVersions(config: MemoryConfig): Promise<string[]> {
  const history = await readFile(path.join(config.rootDir, HISTORY), "utf8");
  return history
    .split(/^## Replaced at .*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

describe("handoff replacement", () => {
  it("defect: concurrent replacements in one process keep every intermediate version", async () => {
    const config = await vault();
    await writeFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "version 0\n");
    const writes = Array.from({ length: 12 }, (_, i) => `version ${i + 1}`);
    await Promise.all(writes.map((content) => updateHandoffSummary(config, content)));

    const final = (await readFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "utf8")).trim();
    const kept = await historyVersions(config);
    expect(kept).toHaveLength(12);
    expect(new Set([...kept, final])).toEqual(new Set(["version 0", ...writes]));
    await rm(config.rootDir, { recursive: true, force: true });
  });

  it("defect: concurrent replacements from two processes keep every intermediate version", async () => {
    const config = await vault();
    await writeFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "version 0\n");
    const writer = path.join(__dirname, "helpers", "handoff-writer.ts");
    const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    await Promise.all(["a", "b"].map((name) => run(process.execPath, [tsx, writer, config.rootDir, name, "8"], { cwd: ROOT })));

    const final = (await readFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "utf8")).trim();
    const kept = await historyVersions(config);
    const expected = ["version 0", ...["a", "b"].flatMap((n) => Array.from({ length: 8 }, (_, i) => `${n} ${i + 1}`))];
    expect(kept).toHaveLength(16);
    expect(new Set([...kept, final])).toEqual(new Set(expected));
    // No lock or temporary file is left behind.
    expect(await readdir(path.join(config.rootDir, ".history", "locks"))).toEqual([]);
    expect((await readdir(config.rootDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    await rm(config.rootDir, { recursive: true, force: true });
  }, 60_000);

  it("defect: a stale expected_version is refused, so a read-modify-write cannot overwrite a newer handoff", async () => {
    const config = await vault();
    const c = await client(config);
    const read = await call(c, "read_handoff_summary");
    const version = read.text.match(/version="([0-9a-f]+)"/)?.[1];
    expect(version).toMatch(/^[0-9a-f]{12}$/);

    expect((await call(c, "update_handoff_summary", { content: "# Handoff\n\nFirst.", expected_version: version })).ok).toBe(true);
    // The same old version again: someone else (here, the first write) changed the handoff in between.
    const stale = await call(c, "update_handoff_summary", { content: "# Handoff\n\nSecond.", expected_version: version });
    expect(stale.ok).toBe(false);
    expect(stale.text).toContain("changed since it was read");
    expect(await readFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "utf8")).toContain("First.");

    // An edit made outside the server (for example in Obsidian) also changes the version.
    const fresh = (await call(c, "read_handoff_summary")).text.match(/version="([0-9a-f]+)"/)?.[1];
    await writeFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "# Handoff\n\nEdited by hand.\n");
    expect((await call(c, "update_handoff_summary", { content: "Third.", expected_version: fresh })).ok).toBe(false);
    // Without expected_version the write still works, and the hand edit is kept in the history.
    expect((await call(c, "update_handoff_summary", { content: "# Handoff\n\nThird." })).ok).toBe(true);
    expect(await readFile(path.join(config.rootDir, HISTORY), "utf8")).toContain("Edited by hand.");
    await c.close();
    await rm(config.rootDir, { recursive: true, force: true });
  });
});

// A fake embedding model: texts about the kettle or getting online point one way, everything else another.
function fakeEmbedder(): Embedder {
  const near = /kettle|online|guest network/i;
  return {
    id: "fake",
    minSimilarity: 0.5,
    embed: async (texts) => texts.map((t) => Float32Array.from(near.test(t) ? [1, 0] : [0, 1])),
  };
}

describe("vector-only retrieval", () => {
  it("defect: a section found by meaning shows the passage that matched, not just its first sentences", async () => {
    const config = await vault();
    const filler = [
      "The office on Kestrel Street opened in 2019 after the move from the old warehouse.",
      "It has two meeting rooms, a small library and a quiet room on the first floor.",
      "Desks are booked through the shared calendar at least one day ahead.",
      "Cleaning happens on Tuesday and Friday evenings after six.",
      "Post arrives at about eleven and is sorted into trays by the door.",
      "The heating is controlled from the panel next to reception.",
    ].join(" ");
    await writeFile(
      path.join(config.rootDir, "Office.md"),
      `# Office\n\n${filler}\n\nThe guest network code is written on the back of the green kettle.\n`,
    );
    const index = new MemoryIndex(config, fakeEmbedder());
    const hits = await index.search("How can visitors get online?", 5);
    expect(hits[0]?.path).toBe("Office.md");
    expect(hits[0]?.snippet).toContain("back of the green kettle");
    index.close();
    await rm(config.rootDir, { recursive: true, force: true });
  });
});

describe("index isolation and lifecycle", () => {
  it("defect: sessions with different masking settings on the same vault do not share an index", async () => {
    const plain = await vault({ MASK_EMAILS: "false" });
    const masked = getMemoryConfig({ AI_MEMORY_DIR: plain.rootDir, MASK_EMAILS: "true" });
    await writeFile(path.join(plain.rootDir, "Badges.md"), "# Badges\n\nAsk jane.doe@example.com about the badge printer.\n");
    const a = await client(plain);
    expect((await call(a, "search_memory", { query: "badge printer" })).text).toContain("jane.doe@example.com");
    const b = await client(masked);
    const text = (await call(b, "search_memory", { query: "badge printer" })).text;
    expect(text).toContain("badge printer");
    expect(text).not.toContain("jane.doe@example.com");
    await a.close();
    await b.close();
    await rm(plain.rootDir, { recursive: true, force: true });
  });

  it("check: a note made private or deleted leaves the index and its vectors", async () => {
    const config = await vault();
    const note = path.join(config.rootDir, "Wifi.md");
    await writeFile(note, "# Wifi\n\nThe guest network code is on the kettle.\n");
    const index = new MemoryIndex(config, fakeEmbedder());
    expect((await index.search("guest network", 5)).map((h) => h.path)).toContain("Wifi.md");
    const withVectors = index.stats().vectors;
    expect(withVectors).toBeGreaterThan(0);

    await writeFile(note, "---\nai_private: true\n---\n\n# Wifi\n\nThe guest network code is on the kettle.\n");
    expect((await index.search("guest network", 5)).map((h) => h.path)).not.toContain("Wifi.md");
    expect(index.stats().vectors).toBeLessThan(withVectors);

    await writeFile(note, "# Wifi\n\nThe guest network code is on the kettle.\n");
    expect((await index.search("guest network", 5)).map((h) => h.path)).toContain("Wifi.md");
    await unlink(note);
    expect(await index.search("guest network", 5)).toEqual([]);
    index.close();
    await rm(config.rootDir, { recursive: true, force: true });
  });

  it("defect: the server does not reach into private SDK fields", async () => {
    for (const file of ["mcpServer.ts", "httpServer.ts", "memory.ts", "index.ts"]) {
      expect(await readFile(path.join(ROOT, "src", file), "utf8"), file).not.toMatch(/\b_requestHandlers\b|\b_registeredTools\b/);
    }
  });

  it("check: the tool list keeps its shape: no $schema, the same tools and required fields", async () => {
    const c = await client(await vault());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "read_main_context",
      "read_handoff_summary",
      "search_memory",
      "read_note",
      "update_handoff_summary",
      "append_session_note",
      "add_decision",
      "add_open_task",
    ]);
    for (const tool of tools) {
      expect(JSON.stringify(tool)).not.toContain("$schema");
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(tools.find((t) => t.name === "update_handoff_summary")?.inputSchema.required).toEqual(["content"]);
    await c.close();
  });
});
