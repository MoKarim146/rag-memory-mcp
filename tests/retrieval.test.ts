import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { compactMainContext } from "../src/context.js";
import { createObsidianMemoryMcpServer } from "../src/mcpServer.js";
import { ensureMemoryLayout, type MemoryConfig } from "../src/memory.js";
import { chunkMarkdown, MAX_CHUNK_CHARS } from "../src/retrieval/chunker.js";
import { createNgramEmbedder, dot } from "../src/retrieval/embeddings.js";
import { buildFtsQuery, makeSnippet, MemoryIndex } from "../src/retrieval/memoryIndex.js";

async function tempVault(): Promise<MemoryConfig> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "retrieval-"));
  const config = { rootDir };
  await ensureMemoryLayout(config);
  return config;
}

describe("chunker", () => {
  it("splits by heading and remembers the heading path", () => {
    const chunks = chunkMarkdown("# Payments\n\nIntro.\n\n## Limits\n\n- 60 requests per minute\n\n## Webhooks\n\nSigned.\n");
    expect(chunks.map((c) => [c.headingPath, c.text])).toEqual([
      ["Payments", "Intro."],
      ["Payments > Limits", "- 60 requests per minute"],
      ["Payments > Webhooks", "Signed."],
    ]);
    expect(chunks[1].heading).toBe("Limits");
  });

  it("ignores headings inside code fences", () => {
    const chunks = chunkMarkdown("## Real\n\n```\n# not a heading\n```\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("# not a heading");
  });

  it("keeps every chunk under the size limit, even for one huge line", () => {
    const long = `${"word ".repeat(1000)}\n\n${"- item\n".repeat(300)}`;
    const chunks = chunkMarkdown(long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });
});

describe("query building", () => {
  it("drops stopwords and quotes every term", () => {
    expect(buildFtsQuery("Why did we choose SQLite instead of Postgres?")).toBe(
      '"choose" OR "sqlite" OR "instead" OR "postgres"',
    );
  });

  it("turns FTS5 syntax into plain quoted words", () => {
    // Punctuation and operators are dropped; "and"/"or" are stopwords and single letters are ignored.
    expect(buildFtsQuery('title:secret NEAR("a" b) AND x* OR -y ^z')).toBe('"title" OR "secret" OR "near"');
    expect(buildFtsQuery("!!! ??? ***")).toBeNull();
  });
});

describe("index", () => {
  it("picks up new, changed and deleted notes before every search", async () => {
    const config = await tempVault();
    const index = new MemoryIndex(config);
    const note = path.join(config.rootDir, "plan.md");

    await writeFile(note, "# Plan\n\nThe launch is on Tuesday.\n");
    expect((await index.search("tuesday")).map((h) => h.path)).toEqual(["plan.md"]);

    await writeFile(note, "# Plan\n\nThe launch moved to Friday.\n");
    await utimes(note, new Date(), new Date(Date.now() + 5000));
    expect(await index.search("tuesday")).toEqual([]);
    expect((await index.search("friday")).map((h) => h.path)).toEqual(["plan.md"]);

    await unlink(note);
    expect(await index.search("friday")).toEqual([]);
    index.close();
    await rm(config.rootDir, { recursive: true, force: true });
  });

  it("returns at most two hits per note and respects the limit", async () => {
    const config = await tempVault();
    // Each section says something different, so none is dropped as a duplicate of another.
    const words = ["apple orchard", "cherry jam", "grape vine", "melon seeds", "peach tree", "plum sauce"];
    const sections = Array.from({ length: 6 }, (_, i) => `## Part ${i}\n\nbanana ${words[i]} ${i}\n`).join("\n");
    await writeFile(path.join(config.rootDir, "fruit.md"), sections);
    await writeFile(path.join(config.rootDir, "other.md"), "banana bread recipe\n");
    const index = new MemoryIndex(config);

    const hits = await index.search("banana", 10);
    expect(hits.filter((h) => h.path === "fruit.md")).toHaveLength(2);
    expect(hits.map((h) => h.path)).toContain("other.md");
    expect(await index.search("banana", 1)).toHaveLength(1);
    index.close();
  });

  it("for a question of three or more words, a note sharing only one word is at most a labelled partial match", async () => {
    const config = await tempVault();
    await writeFile(path.join(config.rootDir, "menu.md"), "The name column holds the product name.\n");
    await writeFile(path.join(config.rootDir, "k8s.md"), "Our Kubernetes cluster is called orchard.\n");
    const index = new MemoryIndex(config);
    // A note matching two of the three words is a full match, and the one-word coincidence is not shown.
    const full = await index.search("What is the name of our Kubernetes cluster?");
    expect(full.map((h) => [h.path, h.partial])).toEqual([["k8s.md", false]]);
    // With no full match, one-word matches come back labelled partial, at most 2.
    await writeFile(path.join(config.rootDir, "k8s.md"), "Nothing relevant here.\n");
    await utimes(path.join(config.rootDir, "k8s.md"), new Date(), new Date(Date.now() + 5000));
    const partial = await index.search("What is the name of our Kubernetes cluster?");
    expect(partial.map((h) => [h.path, h.partial])).toEqual([["menu.md", true]]);
    expect((await index.search("name")).map((h) => [h.path, h.partial])).toEqual([["menu.md", false]]);
    index.close();
  });

  it("finds word variants through stemming", async () => {
    const config = await tempVault();
    await writeFile(path.join(config.rootDir, "deploy.md"), "Rolling back means pointing the symlink at the old release.\n");
    const index = new MemoryIndex(config);
    expect((await index.search("roll back")).map((h) => h.path)).toEqual(["deploy.md"]);
    index.close();
  });

  it("can add vector hits on top of keyword hits", async () => {
    const config = await tempVault();
    await writeFile(path.join(config.rootDir, "a11y.md"), "The accessibility audit found a contrast problem.\n");
    const keywordOnly = new MemoryIndex(config);
    const hybrid = new MemoryIndex(config, createNgramEmbedder());
    // A typo: keyword search finds nothing, character trigrams still match.
    expect(await keywordOnly.search("acessibility")).toEqual([]);
    expect((await hybrid.search("acessibility")).map((h) => h.path)).toEqual(["a11y.md"]);
    keywordOnly.close();
    hybrid.close();
  });
});

describe("snippets", () => {
  it("keeps matching list items together with their continuation lines", () => {
    const text = `- Decision: Use SQLite.\n  Reason: Litestream backups.\n- Decision: ${"x".repeat(400)}\n  Reason: other.`;
    const marked = text.replace("SQLite", "\u0001SQLite\u0002");
    expect(makeSnippet(text, marked, 120)).toBe("- Decision: Use SQLite.\n  Reason: Litestream backups.\n…");
  });

  it("returns short chunks unchanged", () => {
    expect(makeSnippet("short", undefined, 300)).toBe("short");
  });
});

describe("ngram vectors", () => {
  it("are deterministic and normalised", async () => {
    const embedder = createNgramEmbedder();
    const [a, b] = await embedder.embed(["contrast ratio", "contrast ratio"]);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(dot(a, a)).toBeCloseTo(1, 5);
  });
});

describe("main context view", () => {
  it("shows only the newest decisions and only open tasks", () => {
    const decisions = Array.from({ length: 40 }, (_, i) => `## 2026-01-${String(i + 1).padStart(2, "0")}\n\n- Decision: choice ${i}\n  Reason: because ${i}\n`).join("\n");
    const tasks = "# Open Tasks\n\n- [x] done one\n- [ ] open one\n- [X] done two\n- [ ] open two\n";
    const parts = compactMainContext([
      { path: "02_DECISIONS.md", content: `# Decisions\n\n${decisions}` },
      { path: "03_OPEN_TASKS.md", content: tasks },
    ]);
    expect(parts[0].text).toContain("- 2026-01-40: choice 39 Reason: because 39");
    // Older decisions appear as one line each (newest first) until their budget is used, without reasons.
    expect(parts[0].text).toContain("Older, first sentence only:");
    expect(parts[0].text).not.toContain("Reason: because 0");
    expect(parts[0].shown).toMatch(/^newest \d+ of 40 in full, \d+ older as one line each$/);
    expect(parts[1].text).toBe("- [ ] open one\n- [ ] open two");
    expect(parts[1].shown).toBe("open tasks only, 2 done hidden");
  });
});

describe("tool list", () => {
  it("leaves out the $schema and execution boilerplate but keeps the schemas", async () => {
    const config = await tempVault();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createObsidianMemoryMcpServer(config).connect(serverTransport);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty("$schema");
      expect(tool).not.toHaveProperty("execution");
      expect(tool.inputSchema.type).toBe("object");
    }
    const search = tools.find((tool) => tool.name === "search_memory");
    expect(search?.inputSchema.required).toEqual(["query"]);
    await client.close();
  });
});
