// Quality gate. Runs the benchmark's scripted agent on test sets 1 and 2 (the sets the search was tuned on)
// and fails if a change makes search answer fewer questions, or costs clearly more tokens, than the numbers
// in RAG_RESULTS.md. Test set 3 is kept out of this on purpose: it is only for one-off honest measurements.

import { describe, expect, it } from "vitest";
import { loadTasks, runVariant, type SetName } from "../bench/run.js";

// [set, style, minimum answered, minimum answered by search alone, maximum lookup tokens]
// Token limits are the round 3 results plus 5%.
const GATES: [SetName, "keyword" | "question", number, number, number][] = [
  ["dev", "keyword", 24, 21, Math.round(5430 * 1.05)],
  ["dev", "question", 23, 21, Math.round(5227 * 1.05)],
  ["holdout", "keyword", 31, 30, Math.round(5657 * 1.05)],
  ["holdout", "question", 29, 26, Math.round(7400 * 1.05)],
];

describe("quality gate", () => {
  it.each(GATES)("set %s, %s searches: answers and token cost stay within the recorded results", async (set, style, answered, bySearch, maxLookupTokens) => {
    const result = await runVariant("current", style, await loadTasks(set), set);
    expect(result.summary.answered).toBeGreaterThanOrEqual(answered);
    expect(result.summary.answeredBySearchAlone).toBeGreaterThanOrEqual(bySearch);
    expect(result.summary.lookupResultTokens).toBeLessThanOrEqual(maxLookupTokens);
    expect(result.summary.writesLanded).toBe(4);
  }, 120_000);
});
