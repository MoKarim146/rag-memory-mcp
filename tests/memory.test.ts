import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addDecision,
  addOpenTask,
  appendSessionNote,
  ensureMemoryLayout,
  type MemoryConfig,
  readMainContext,
  readNote,
  searchMemory,
  updateHandoffSummary,
} from "../src/memory.js";

async function tempConfig(): Promise<MemoryConfig> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-memory-mcp-"));
  return { rootDir };
}

describe("memory backend", () => {
  it("creates the required vault layout", async () => {
    const config = await tempConfig();
    await ensureMemoryLayout(config);

    await expect(readFile(path.join(config.rootDir, "00_MAIN_CONTEXT.md"), "utf8")).resolves.toContain(
      "# MAIN CONTEXT",
    );
    await expect(readFile(path.join(config.rootDir, "04_MODEL_HANDOFF.md"), "utf8")).resolves.toContain(
      "# MODEL HANDOFF",
    );
  });

  it("reads and updates handoff content", async () => {
    const config = await tempConfig();
    await updateHandoffSummary(config, "# Handoff\n\nCurrent state.");

    const files = await readMainContext(config);
    const handoff = files.find((file) => file.path === "04_MODEL_HANDOFF.md");

    expect(handoff?.content).toContain("Current state.");
  });

  it("appends session notes, decisions, and tasks", async () => {
    const config = await tempConfig();
    const now = new Date("2026-05-30T10:15:00.000Z");

    const session = await appendSessionNote(config, "ChatGPT Developer Mode", "Summary", "Implemented MCP.", now);
    const decision = await addDecision(config, "Use Streamable HTTP", "ChatGPT supports it.", now);
    const task = await addOpenTask(config, "Verify connector in ChatGPT", "high", "memory", now);

    expect(session.path).toBe("Sessions/2026-05-30_ChatGPT-Developer-Mode.md");
    expect(session.content).toContain("Implemented MCP.");
    expect(decision.content).toContain("Use Streamable HTTP");
    expect(task.content).toContain("[high] (memory) Verify connector in ChatGPT");
  });

  it("searches markdown notes and reads relative markdown paths", async () => {
    const config = await tempConfig();
    await ensureMemoryLayout(config);
    await writeFile(path.join(config.rootDir, "extra.md"), "Alpha\nNeedle appears here\nOmega\n", "utf8");

    const search = await searchMemory(config, "needle");
    const note = await readNote(config, "extra.md");

    expect(search.matches).toEqual([
      {
        path: "extra.md",
        line: 2,
        snippet: "Needle appears here",
      },
    ]);
    expect(note.content).toContain("Alpha");
  });

  it("rejects path traversal and absolute paths", async () => {
    const config = await tempConfig();
    await ensureMemoryLayout(config);

    await expect(readNote(config, "../secret.md")).rejects.toThrow("Path traversal");
    await expect(readNote(config, "/tmp/secret.md")).rejects.toThrow("Absolute paths");
  });
});
