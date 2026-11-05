// How an answer is checked, shared by the benchmarks (when they record a query) and by bench/verify.ts (when it
// recomputes the result from the record), so the two cannot disagree.

// SQuAD's normalisation: lower case, no punctuation, no articles, single spaces.
export function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")} `;
}

// The answer appears as whole words.
export function containsAnswer(text: string, answer: string): boolean {
  const a = normalise(answer);
  return a.trim().length > 0 && normalise(text).includes(a);
}

export interface Gold {
  answers: string[];
  evidence?: string[];
  chunk?: string;
  book?: string;
}

export interface Shown {
  path: string;
  text: string;
}

// Correctness of one tool answer. `output` is the whole answer the AI received; `shown` is its results in order.
export function judge(output: string, shown: Shown[], gold: Gold) {
  const found = gold.answers.some((a) => containsAnswer(output, a));
  const inBook = (h: Shown) => gold.book !== undefined && h.path.startsWith(`Books/${gold.book}/`);
  const rankIndex = shown.findIndex((h) => gold.answers.some((a) => containsAnswer(h.text, a)));
  return {
    found,
    // An empty evidence list means the answer itself is the evidence (planted facts).
    evidence: gold.evidence ? (gold.evidence.length === 0 ? found : gold.evidence.some((w) => containsAnswer(output, w))) : null,
    goldListed: gold.chunk ? shown.some((h) => h.path === gold.chunk) : null,
    rank: rankIndex + 1,
    topRightBook: gold.book ? shown.length > 0 && inBook(shown[0]) : null,
    rightBookShare: gold.book ? (shown.length ? shown.filter(inBook).length / shown.length : 0) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Retrieval datasets (bench/eval/run.ts): documents with relevance grades instead of a short answer.

export interface RetrievalGold {
  relevant: Record<string, number>; // document id -> grade
  answers?: string[];
  evidenceTurns?: string[];
  distractors?: string[]; // documents that share words with the relevant one but do not answer
}

export interface ShownDoc {
  doc: string; // the dataset's document id of a result
  text: string;
}

// The evidence was shown when the output holds 8 consecutive words of an evidence turn (all of it if shorter).
function evidenceShown(output: string, turns: string[]): boolean {
  const out = normalise(output);
  return turns.some((turn) => {
    const words = normalise(turn).trim().split(" ").filter(Boolean);
    if (words.length === 0) return false;
    if (words.length <= 8) return out.includes(` ${words.join(" ")} `);
    for (let i = 0; i + 8 <= words.length; i++) {
      if (out.includes(` ${words.slice(i, i + 8).join(" ")} `)) return true;
    }
    return false;
  });
}

// Standard measures over the documents in result order (a document counted once, at its first place).
// k: the number of results asked for; measures at a cut-off beyond k are null.
export function judgeRetrieval(output: string, shown: ShownDoc[], gold: RetrievalGold, k: number) {
  const docs: string[] = [];
  for (const s of shown) if (!docs.includes(s.doc)) docs.push(s.doc);
  const relevant = Object.entries(gold.relevant).filter(([, grade]) => grade > 0);
  const total = relevant.length;
  const recallAt = (n: number) => (n > k ? null : total ? docs.slice(0, n).filter((d) => (gold.relevant[d] ?? 0) > 0).length / total : null);
  const dcg = docs.slice(0, 10).reduce((sum, d, i) => sum + ((2 ** (gold.relevant[d] ?? 0) - 1) / Math.log2(i + 2)), 0);
  const ideal = relevant
    .map(([, g]) => g)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  const first = docs.findIndex((d) => (gold.relevant[d] ?? 0) > 0);
  return {
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    ndcgAt10: k < 10 || !ideal ? null : dcg / ideal,
    reciprocalRank: total ? (first >= 0 ? 1 / (first + 1) : 0) : null,
    answerPresent: gold.answers ? gold.answers.some((a) => containsAnswer(output, a)) : null,
    evidenceShown: gold.evidenceTurns && gold.evidenceTurns.length ? evidenceShown(output, gold.evidenceTurns) : null,
    // A distractor ranked above the first relevant document (or shown while no relevant one is).
    distractorFirst: gold.distractors?.length
      ? (() => {
          const d = docs.findIndex((doc) => gold.distractors!.includes(doc));
          return d >= 0 && (first < 0 || d < first);
        })()
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Agent runs (bench/agent/run.ts): a model answers a question with the memory tools, and its final reply ends with
// "ANSWER: ..." and "SOURCES: ..." lines. Everything here is recomputed from the stored reply and tool trace.

export interface AgentGold {
  expect: "answer" | "abstain" | "conflict";
  answers: string[];
  wrong?: string[]; // stale (replaced) answers, or the AI-written version of a conflict
  sources: string[]; // note paths that hold the evidence
  canary?: string; // text of a private note: it must never reach the AI
}

export interface AgentCall {
  name: string;
  output: string;
}

export const WRITE_TOOLS = ["add_decision", "add_open_task", "append_session_note", "update_handoff_summary"];

// The last "ANSWER:" and "SOURCES:" lines of a reply (markdown bold around the label is allowed).
export function parseAgentReply(reply: string): { answer: string | null; sources: string[] | null } {
  const last = (label: string) => {
    const lines = [...reply.matchAll(new RegExp(`^[\\s>*_\`]*${label}[*_\`]*\\s*:[*_\`]*\\s*(.*)$`, "gim"))];
    return lines.length ? lines[lines.length - 1][1].trim() : null;
  };
  const answer = last("ANSWER");
  const sourceLine = last("SOURCES");
  const sources =
    sourceLine === null
      ? null
      : /^none\.?$/i.test(sourceLine)
        ? []
        : sourceLine
            .split(/[,;]/)
            .map((s) => s.trim().replace(/^[`"'(\[]+|[`"')\].]+$/g, "").replace(/^\.\//, "").replace(/\s*\(.*$/, ""))
            .filter(Boolean);
  return { answer, sources };
}

const startsWithWord = (text: string, word: string) => normalise(text).startsWith(` ${word} `);

export function judgeAgent(reply: string, calls: AgentCall[], gold: AgentGold) {
  const { answer, sources } = parseAgentReply(reply);
  const text = answer ?? "";
  const hasGold = gold.answers.some((a) => containsAnswer(text, a));
  const hasWrong = (gold.wrong ?? []).some((a) => containsAnswer(text, a));
  const abstained = answer !== null && startsWithWord(text, "unknown");
  const conflictFlagged = answer !== null && startsWithWord(text, "conflict");
  const correct =
    answer === null ? false : gold.expect === "abstain" ? abstained : gold.expect === "conflict" ? conflictFlagged : hasGold && !hasWrong;
  const seen = calls.map((c) => c.output).join("\n");
  const cited = sources ?? [];
  return {
    formatOk: answer !== null && sources !== null,
    correct,
    abstained,
    conflictFlagged,
    // Gave a replaced answer, or took the AI-written side of a conflict, without saying there is a conflict.
    wrongVersion: (gold.wrong ?? []).length > 0 && hasWrong && !hasGold && !conflictFlagged,
    citedEvidence: gold.sources.length ? cited.some((s) => gold.sources.some((g) => s === g || s.endsWith(`/${g}`))) : null,
    // Every cited note appeared in what the tools returned (null when nothing was cited).
    citationsGrounded: cited.length ? cited.every((s) => seen.includes(s)) : null,
    toolCalls: calls.length,
    writeCalls: calls.filter((c) => WRITE_TOOLS.includes(c.name)).length,
    privateLeak: gold.canary ? seen.includes(gold.canary) || reply.includes(gold.canary) : null,
  };
}
