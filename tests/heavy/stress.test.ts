// Stress tests: many clients at once, big and odd vaults, files changing while searching, floods of sessions
// and requests. Each test sets a limit it must stay within; the limits are generous so a slow CI machine
// passes, but a real regression (a crash, a hang, a leak, corrupted notes) fails.

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer } from "../../src/httpServer.js";
import { createObsidianMemoryMcpServer } from "../../src/mcpServer.js";
import { ensureMemoryLayout, getMemoryConfig, type MemoryConfig } from "../../src/memory.js";
import { MemoryIndex } from "../../src/retrieval/memoryIndex.js";
import { prepareNoteText } from "../../src/safety.js";

const FIXTURE = path.join(__dirname, "..", "..", "bench", "fixture-vault");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function tempVault(env: Record<string, string> = {}): Promise<MemoryConfig> {
  const base = await mkdtemp(path.join(os.tmpdir(), "stress-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const config = getMemoryConfig({ AI_MEMORY_DIR: path.join(base, "vault"), ...env });
  await ensureMemoryLayout(config);
  return config;
}

async function startServer(config: MemoryConfig, extra: Record<string, unknown> = {}): Promise<{ server: Server; url: URL }> {
  const server = await startHttpServer({ config, host: "127.0.0.1", port: 0, ...extra } as never);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`) };
}

async function httpClient(url: URL, name: string): Promise<Client> {
  const client = new Client({ name, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

function textOf(result: { content: unknown }): string {
  return (result.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
}

describe("stress: many clients at once", () => {
  it("20 clients searching and writing in parallel over HTTP: no errors, every write saved exactly once, no broken lines", async () => {
    const config = await tempVault();
    await cp(FIXTURE, config.rootDir, { recursive: true });
    const { url } = await startServer(config);

    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, c) => {
        const client = await httpClient(url, `client-${c}`);
        const texts: string[] = [];
        for (let i = 0; i < 10; i += 1) {
          texts.push(textOf(await client.callTool({ name: "search_memory", arguments: { query: ["refunds", "Postgres", "delivery fee", "Welsh launch", "queue"][i % 5] } })));
        }
        for (let d = 0; d < 3; d += 1) {
          texts.push(textOf(await client.callTool({ name: "add_decision", arguments: { decision: `Client ${c} decision ${d}`, reason: `reason ${c}-${d}` } })));
        }
        texts.push(textOf(await client.callTool({ name: "append_session_note", arguments: { model_name: `bot${c}`, title: "Load test", content: `Note from client ${c}.` } })));
        await client.close();
        return texts;
      }),
    );

    for (const texts of results) {
      expect(texts.filter((t) => t.startsWith("Saved to")).length).toBe(4);
      expect(texts.some((t) => /request failed|error/i.test(t))).toBe(false);
    }
    const decisions = await readFile(path.join(config.rootDir, "02_DECISIONS.md"), "utf8");
    for (let c = 0; c < 20; c += 1) {
      for (let d = 0; d < 3; d += 1) {
        expect(decisions.split(`- Decision: Client ${c} decision ${d} (added by AI via MCP)\n  Reason: reason ${c}-${d}\n`).length - 1).toBe(1);
      }
    }
    const sessions = await readdir(path.join(config.rootDir, "Sessions"));
    expect(sessions.filter((f) => /_bot\d+\.md$/.test(f)).length).toBe(20);
  });

  it("200 parallel searches while notes are created, edited, renamed and deleted: no crash, and a deleted note's text is gone afterwards", async () => {
    const config = await tempVault({ MCP_MAX_CALLS_PER_MINUTE: "100000" });
    await cp(FIXTURE, config.rootDir, { recursive: true });
    const index = new MemoryIndex(config);
    cleanups.push(async () => index.close());
    let stop = false;

    const churn = (async () => {
      let n = 0;
      while (!stop) {
        const file = path.join(config.rootDir, `churn-${n % 7}.md`);
        await writeFile(file, `# Churn ${n}\n\nvolatile turnip ${n}\n`).catch(() => undefined);
        if (n % 3 === 0) await rename(file, path.join(config.rootDir, `moved-${n % 5}.md`)).catch(() => undefined);
        if (n % 4 === 0) await unlink(path.join(config.rootDir, `moved-${(n + 1) % 5}.md`)).catch(() => undefined);
        n += 1;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const searches = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) => index.search(i % 2 ? "volatile turnip" : "refunds Postgres", 5)),
    );
    stop = true;
    await churn;
    expect(searches.filter((s) => s.status === "rejected")).toEqual([]);

    for (const file of await readdir(config.rootDir)) {
      if (/^(churn|moved)-/.test(file)) await unlink(path.join(config.rootDir, file));
    }
    expect(await index.search("volatile turnip", 10)).toEqual([]);
  });
});

describe("stress: big and odd vaults", () => {
  it("a 10,000-note vault: index built and searched within limits", async () => {
    const config = await tempVault();
    const files = (await readdir(FIXTURE, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    const texts = await Promise.all(files.map(async (e) => readFile(path.join(e.parentPath, e.name), "utf8")));
    let written = 0;
    for (let copy = 0; written < 10_000; copy += 1) {
      const dir = path.join(config.rootDir, "Archive", `copy-${copy}`);
      await mkdir(dir, { recursive: true });
      await Promise.all(
        texts.map((text, i) => writeFile(path.join(dir, `note-${i}.md`), `Archived copy ${copy}.\n\n${text}`)),
      );
      written += texts.length;
    }
    const index = new MemoryIndex(config);
    cleanups.push(async () => index.close());

    const rssBefore = process.memoryUsage().rss;
    let start = performance.now();
    await index.search("warm up");
    const buildMs = performance.now() - start;
    start = performance.now();
    const hits = await index.search("PayLoop webhook secret rotation");
    const searchMs = performance.now() - start;
    const growthMb = (process.memoryUsage().rss - rssBefore) / 1e6;

    expect(index.stats().files).toBeGreaterThanOrEqual(10_000);
    expect(hits.length).toBeGreaterThan(0);
    expect(buildMs).toBeLessThan(120_000);
    expect(searchMs).toBeLessThan(5_000);
    expect(growthMb).toBeLessThan(1_500);
  });

  it("a 1 MB one-line note, a 100,000-line note and a note with 20,000 headings: readable in pages, no crash", async () => {
    const config = await tempVault({ MCP_MAX_CALLS_PER_MINUTE: "100000" });
    await writeFile(path.join(config.rootDir, "oneline.md"), `start ${"lorem ".repeat(170_000)}end`);
    await writeFile(path.join(config.rootDir, "lines.md"), Array.from({ length: 100_000 }, (_, i) => `- line ${i}`).join("\n"));
    await writeFile(path.join(config.rootDir, "headings.md"), Array.from({ length: 20_000 }, (_, i) => `## H${i}\n\nbody ${i}`).join("\n"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createObsidianMemoryMcpServer(config).connect(serverTransport);
    const client = new Client({ name: "big", version: "0" });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());

    const start = performance.now();
    for (const note of ["oneline.md", "lines.md", "headings.md"]) {
      const first = textOf(await client.callTool({ name: "read_note", arguments: { path: note } }));
      expect(first).toMatch(/page="1 of \d+"/);
      expect(first.length).toBeLessThan(9000);
    }
    expect(textOf(await client.callTool({ name: "search_memory", arguments: { query: "body 19999" } }))).toContain("headings.md");
    expect(performance.now() - start).toBeLessThan(60_000);
  });

  it("folders nested 200 deep do not crash the walk; notes deeper than 32 levels are skipped", async () => {
    const config = await tempVault();
    let dir = config.rootDir;
    for (let i = 0; i < 200; i += 1) {
      dir = path.join(dir, "d");
      if (i === 10) await mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, "shallow.md"), "# S\n\nshallow parsnip\n"));
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "deep.md"), "# D\n\ndeep parsnip\n");
    const index = new MemoryIndex(config);
    cleanups.push(async () => index.close());
    const hits = await index.search("parsnip", 10);
    expect(hits.map((h) => h.path.split("/").at(-1))).toEqual(["shallow.md"]);
  });
});

describe("stress: floods", () => {
  it("200 sessions opened at once: at most 32 stay open, the rest are refused, nothing crashes", async () => {
    const config = await tempVault();
    const { url } = await startServer(config);
    const statuses = await Promise.all(
      Array.from({ length: 200 }, async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f", version: "0" } } }),
        });
        await res.text();
        return res.status;
      }),
    );
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(32);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    const health = await fetch(new URL("/health", url));
    expect(health.status).toBe(200);
  });

  it("500 calls fired at once in one session: at most 120 run, the rest are told to slow down", async () => {
    const config = await tempVault();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createObsidianMemoryMcpServer(config).connect(serverTransport);
    const client = new Client({ name: "flood", version: "0" });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());
    const results = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const r = await client.callTool({ name: "search_memory", arguments: { query: `beans ${i}` } });
        return r.isError ? textOf(r) : "ok";
      }),
    );
    expect(results.filter((r) => r === "ok").length).toBe(120);
    expect(results.filter((r) => /Too many requests/.test(r)).length).toBe(380);
  });

  it("20 random 200 KB strings of markup characters are each cleaned in under 2 seconds", () => {
    const alphabet = ["<", ">", "!", "-", "%", "[", "]", "(", ")", "#", "/", "@", ":", "=", "\"", "'", " ", "\n", "a", "1", "span", "hidden", "script", "http", "//", "password", "sk-", "<!--", "%%"];
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 20; n += 1) {
      let text = "";
      while (text.length < 200_000) text += alphabet[Math.floor(random() * alphabet.length)];
      const start = performance.now();
      prepareNoteText(text);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});
