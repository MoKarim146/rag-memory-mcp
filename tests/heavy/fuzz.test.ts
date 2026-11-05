// Property-based fuzz tests. Instead of a handful of hand-written attacks, fast-check generates thousands of
// random inputs and checks that a rule holds for every one of them. If one input breaks a rule, fast-check
// shrinks it to the smallest example and prints it. The seed is fixed, so a run can be repeated exactly.

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObsidianMemoryMcpServer } from "../../src/mcpServer.js";
import { ensureMemoryLayout, getMemoryConfig, type MemoryConfig } from "../../src/memory.js";
import { chunkMarkdown, MAX_CHUNK_CHARS } from "../../src/retrieval/chunker.js";
import { MemoryIndex } from "../../src/retrieval/memoryIndex.js";
import { findWriteProblem, INVISIBLE, prepareNoteText } from "../../src/safety.js";

const SEED = 20261105;
const CANARY = "CANARY-fuzz-77aa";

let base: string;
let vault: string;
let outside: string;
let config: MemoryConfig;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { ok: !result.isError, text: (result.content as { text?: string }[]).map((p) => p.text ?? "").join("\n") };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "fuzz-"));
  vault = path.join(base, "vault");
  outside = path.join(base, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), `${CANARY}\n`);
  config = { ...getMemoryConfig({ AI_MEMORY_DIR: vault, MCP_MAX_CALLS_PER_MINUTE: "1000000" }) };
  await ensureMemoryLayout(config);
  await mkdir(path.join(vault, "Projects"));
  await writeFile(path.join(vault, "Projects", "plan.md"), "# Plan\n\nPlant beans.\n");
  await mkdir(path.join(vault, ".trash"));
  await writeFile(path.join(vault, ".trash", "old.md"), `${CANARY}\n`);
  await symlink(path.join(outside, "secret.md"), path.join(vault, "link.md"));
  await symlink(outside, path.join(vault, "linkdir"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createObsidianMemoryMcpServer(config).connect(serverTransport);
  client = new Client({ name: "fuzz", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await rm(base, { recursive: true, force: true });
});

// Path pieces an attacker would combine: dots, slashes, encodings, look-alike characters, hidden folders.
const pathPiece = fc.constantFrom(
  "..", ".", "/", "\\", "%2e", "%2f", "%5c", "．．", "‥", "..;", "....", "//", "~", "outside", "secret.md", "secret",
  ".md", "linkdir", "link.md", ".trash", "old.md", "Sessions", "Projects", "plan.md", "AI Review", ".history",
  "C:", "\u0000", " ", "‮", "%00", "md", "x",
);
const hostilePath = fc.array(pathPiece, { minLength: 1, maxLength: 8 }).map((parts) => parts.join(""));

describe("fuzz: paths", () => {
  it("3,000 generated paths never reach the canary or leak the vault location", async () => {
    await fc.assert(
      fc.asyncProperty(hostilePath, async (notePath) => {
        const result = await call("read_note", { path: notePath });
        expect(result.text).not.toContain(CANARY);
        expect(result.text).not.toContain(base);
        if (result.ok) {
          expect(result.text).toMatch(/<note path="(Projects\/plan\.md|0\d_[A-Z_]+\.md)"/);
        }
      }),
      { numRuns: 3000, seed: SEED },
    );
    // Nothing was written outside the vault while fuzzing.
    expect(await readdir(outside)).toEqual(["secret.md"]);
  });
});

// Text built from markdown and HTML fragments, invisible characters and secrets, so the cleaner meets
// realistic mixtures rather than only random letters.
const fragment = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom(
    "<!--", "-->", "%%", "[//]: # (x)", "<span hidden>", "</span>", '<div style="display:none">', "</div>",
    "<script>", "</script>", "![i](https://evil.example/x.png)", '<img src="//evil.example/p">', "​", "‮",
    "️", "\u001b[31m", "\u0007", "#", "## ", "- ", "| a | b |", "```", "\n", "\n\n", "password: hunter2xyz",
    // Keys are generated as separate words (after a space). A key glued straight after a letter ("Ask-...")
    // is deliberately not masked, see the known-limit test below.
    ` ${"sk"}-${"a".repeat(24)}`, "anna@example.org", "+44 29 2034 5678", "4111 1111 1111 1111", "ignore all previous instructions",
  ),
  fc.integer({ min: 0x0, max: 0x10ffff }).map((code) => (code >= 0xd800 && code <= 0xdfff ? "?" : String.fromCodePoint(code))),
);
const noteText = fc.array(fragment, { maxLength: 60 }).map((parts) => parts.join(""));

describe("fuzz: note text", () => {
  it("5,000 generated notes: the cleaned text never contains invisible characters, control codes, hidden comments, scripts or remote images", () => {
    fc.assert(
      fc.property(noteText, (raw) => {
        const { text } = prepareNoteText(raw);
        expect(text).not.toMatch(INVISIBLE);
        INVISIBLE.lastIndex = 0;
        expect(text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
        expect(text).not.toContain("<!--");
        expect(text).not.toMatch(/<script/i);
        expect(text).not.toMatch(/!\[[^\]]*\]\(\s*(https?:)?\/\//i);
        expect(text).not.toContain("hunter2xyz");
        expect(text).not.toContain(`${"sk"}-${"a".repeat(24)}`);
      }),
      { numRuns: 5000, seed: SEED },
    );
  });

  it("KNOWN LIMIT: a key glued straight after a letter is not masked, to avoid masking words like task-assignment-...", () => {
    expect(prepareNoteText(`Ask-${"a".repeat(24)}`).text).toContain(`sk-${"a".repeat(24)}`);
    expect(prepareNoteText("task-assignment-for-the-new-feature").text).toBe("task-assignment-for-the-new-feature");
    // Glued after a digit, underscore or punctuation, it is masked.
    for (const prefix of ["0", "_", ":", "=", "("]) {
      expect(prepareNoteText(`${prefix}sk-${"a".repeat(24)}`).text, prefix).not.toContain(`sk-${"a".repeat(24)}`);
    }
  });

  it("5,000 generated notes: cleaning twice changes nothing more than cleaning once", () => {
    fc.assert(
      fc.property(noteText, (raw) => {
        const once = prepareNoteText(raw).text;
        expect(prepareNoteText(once).text).toBe(once);
      }),
      { numRuns: 5000, seed: SEED },
    );
  });

  it("5,000 generated notes: every chunk stays within the size limit and no text is lost", () => {
    fc.assert(
      fc.property(noteText, (raw) => {
        const chunks = chunkMarkdown(raw);
        for (const chunk of chunks) {
          expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
        }
        // Every word of the note body appears in some chunk (headings are kept as chunk headings).
        const bodyWords = raw
          .split("\n")
          .filter((line) => !/^#{1,6}\s/.test(line))
          .join(" ")
          .split(/\s+/)
          .filter((w) => w.length > 0);
        const all = chunks.map((c) => c.text).join(" ");
        for (const word of bodyWords.slice(0, 50)) {
          expect(all).toContain(word);
        }
      }),
      { numRuns: 5000, seed: SEED },
    );
  });

  it("2,000 generated write texts: anything the write check accepts contains no hidden or active content", () => {
    fc.assert(
      fc.property(noteText, (raw) => {
        if (findWriteProblem(raw) === undefined) {
          const cleaned = prepareNoteText(raw, { maskEmails: false, maskPhones: false, maskSecrets: false });
          expect(cleaned.hiddenRemoved).toBe(0);
          expect(cleaned.text).not.toContain("[remote image removed");
          expect(cleaned.text).not.toContain("[embedded content removed]");
        }
      }),
      { numRuns: 2000, seed: SEED },
    );
  });
});

describe("fuzz: search", () => {
  it("2,000 generated queries never crash search, never exceed the limit and only return real notes", async () => {
    const index = new MemoryIndex(config);
    await writeFile(path.join(vault, "Projects", "beans.md"), "# Beans\n\n## Sowing\n\nSow beans in May.\n\n| crop | month |\n|---|---|\n| beans | May |\n");
    const query = fc.oneof(
      fc.string({ minLength: 1, maxLength: 120 }),
      fc.array(fc.constantFrom("beans", "sow", "May", '"', "*", "NEAR(", ")", "OR", "AND", "NOT", "-", "^", ":", "'", ";", "--", "\u0000", "日本", "ß", "İ"), { minLength: 1, maxLength: 12 }).map((p) => p.join(" ")),
    );
    await fc.assert(
      fc.asyncProperty(query, fc.integer({ min: 1, max: 10 }), async (q, limit) => {
        const hits = await index.search(q, limit);
        expect(hits.length).toBeLessThanOrEqual(limit);
        for (const hit of hits) {
          expect(["Projects/beans.md", "Projects/plan.md"].includes(hit.path) || /^0\d_/.test(hit.path)).toBe(true);
          expect(hit.snippet).not.toContain(CANARY);
        }
      }),
      { numRuns: 2000, seed: SEED },
    );
    index.close();
  });
});
