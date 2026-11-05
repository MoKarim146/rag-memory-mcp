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
