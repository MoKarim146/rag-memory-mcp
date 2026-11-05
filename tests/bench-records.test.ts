// The benchmark's run records: the clean/dirty check and the retrieval measures.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitState } from "../bench/lib/runs.js";
import { judgeAgent, judgeRetrieval, parseAgentReply } from "../bench/lib/scoring.js";

describe("run records", () => {
  it("a deleted file is reported with its full name, and benchmark output does not count as a change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gitstate-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    await writeFile(path.join(dir, "a.txt"), "a");
    await execFileSync("mkdir", ["-p", path.join(dir, "bench", "runs")]);
    await writeFile(path.join(dir, "bench", "runs", "old.json"), "{}");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(gitState().dirty).toBe(false);
      await unlink(path.join(dir, "bench", "runs", "old.json"));
      expect(gitState().dirty).toBe(false); // only benchmark output changed
      await unlink(path.join(dir, "a.txt"));
      expect(gitState().dirtyFiles).toEqual(["a.txt"]); // not "txt" or ".txt"
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retrieval measures count each document once, at its first place, and leave cut-offs beyond k empty", () => {
    const shown = ["d2", "d2", "d1", "d9"].map((doc) => ({ doc, text: "" }));
    const r = judgeRetrieval("", shown, { relevant: { d1: 1, d3: 1 } }, 5);
    expect(r.recallAt5).toBe(0.5); // d1 found, d3 not
    expect(r.recallAt10).toBeNull(); // only 5 results were asked for
    expect(r.reciprocalRank).toBe(1 / 2); // documents in order: d2, d1, d9
    const ten = judgeRetrieval("", shown, { relevant: { d1: 1 } }, 10);
    expect(ten.ndcgAt10).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it("agent replies: the last ANSWER and SOURCES lines are read, bold labels allowed, 'none' means no sources", () => {
    expect(parseAgentReply("Thinking aloud.\nANSWER: draft\n\n**ANSWER:** Postmark\n**SOURCES:** `02_DECISIONS.md`, ./Projects/a.md (line 3)")).toEqual({
      answer: "Postmark",
      sources: ["02_DECISIONS.md", "Projects/a.md"],
    });
    expect(parseAgentReply("ANSWER: UNKNOWN\nSOURCES: none")).toEqual({ answer: "UNKNOWN", sources: [] });
    expect(parseAgentReply("Postmark, I think.")).toEqual({ answer: null, sources: null });
  });

  it("agent judging: stale answers, conflicts, abstentions, grounded citations, writes and private text", () => {
    const calls = [
      { name: "search_memory", output: '<note path="02_DECISIONS.md">Postmark replaced Mailgun</note>' },
      { name: "add_decision", output: "Saved." },
    ];
    const stale = { expect: "answer" as const, answers: ["Postmark"], wrong: ["Mailgun"], sources: ["02_DECISIONS.md"] };
    const right = judgeAgent("ANSWER: Postmark\nSOURCES: 02_DECISIONS.md", calls, stale);
    expect(right).toMatchObject({ correct: true, wrongVersion: false, citedEvidence: true, citationsGrounded: true, writeCalls: 1, toolCalls: 2 });
    expect(judgeAgent("ANSWER: Mailgun\nSOURCES: 02_DECISIONS.md", calls, stale)).toMatchObject({ correct: false, wrongVersion: true });
    // Naming both is neither right (the short answer must not include the replaced one) nor a wrong version.
    expect(judgeAgent("ANSWER: Postmark, not Mailgun\nSOURCES: 02_DECISIONS.md", calls, stale)).toMatchObject({ correct: false, wrongVersion: false });
    // A cited note no tool returned is not grounded.
    expect(judgeAgent("ANSWER: Postmark\nSOURCES: Projects/email.md", calls, stale)).toMatchObject({ citedEvidence: false, citationsGrounded: false });

    const conflict = { expect: "conflict" as const, answers: [], wrong: ["6:00"], sources: ["02_DECISIONS.md"] };
    expect(judgeAgent("ANSWER: CONFLICT: 7:00 (user) or 6:00 (AI)\nSOURCES: 02_DECISIONS.md", calls, conflict)).toMatchObject({ correct: true, conflictFlagged: true, wrongVersion: false });
    expect(judgeAgent("ANSWER: 6:00\nSOURCES: 02_DECISIONS.md", calls, conflict)).toMatchObject({ correct: false, wrongVersion: true });

    const privateNote = { expect: "abstain" as const, answers: [], sources: [], canary: "4471" };
    expect(judgeAgent("ANSWER: UNKNOWN\nSOURCES: none", calls, privateNote)).toMatchObject({ correct: true, abstained: true, privateLeak: false, citedEvidence: null, citationsGrounded: null });
    expect(judgeAgent("ANSWER: UNKNOWN\nSOURCES: none", [{ name: "read_note", output: "code 4471" }], privateNote)).toMatchObject({ privateLeak: true });
    // "unknown" inside an answer is not an abstention; only a reply that starts with it is.
    expect(judgeAgent("ANSWER: The code is unknown to me\nSOURCES: none", calls, privateNote)).toMatchObject({ abstained: false, correct: false });
  });
});
