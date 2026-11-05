// The benchmark's run records: the clean/dirty check and the retrieval measures.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitState } from "../bench/lib/runs.js";
import { judgeRetrieval } from "../bench/lib/scoring.js";

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
});
