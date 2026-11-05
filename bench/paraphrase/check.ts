// Checks bench/paraphrase/set.json against the rules it claims, and prints one line per question.
//
//   npx tsx bench/paraphrase/check.ts       exit 1 if any rule is broken
//
// Words are compared after lower-casing, dropping the words search ignores (the server's own stopword list)
// and a rough stemming (plural, -ing, -ed, -er, -ly endings), so "visiting" and "visitors" count as shared.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryTerms } from "../../src/retrieval/memoryIndex.js";
import { containsAnswer } from "../lib/scoring.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface ParaphraseGroup {
  id: string;
  target: { path: string; text: string };
  distractor: { path: string; text: string };
  answer: string;
  queries: { id: string; kind: "lexical" | "synonym" | "low-overlap" | "negation" | "date"; text: string; answer?: string }[];
}

const stem = (w: string) =>
  w
    .replace(/'s$/, "")
    .replace(/(ies)$/, "y")
    .replace(/(ing|ings|ed|er|ers|ly|es|s)$/, "")
    .replace(/(.)\1$/, "$1");

export function contentStems(text: string): Set<string> {
  return new Set(queryTerms(text).map(stem).filter((w) => w.length > 1));
}

const NEGATION = /\b(not|no|never|cannot|can't|won't|isn't|aren't|don't|doesn't|unlike|without)\b/i;

export async function loadSet(): Promise<ParaphraseGroup[]> {
  return (JSON.parse(await readFile(path.join(HERE, "set.json"), "utf8")) as { groups: ParaphraseGroup[] }).groups;
}

export function check(groups: ParaphraseGroup[]): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const g of groups) {
    if (!containsAnswer(g.target.text, g.answer)) problems.push(`${g.id}: the answer "${g.answer}" is not in the target note`);
    if (containsAnswer(g.distractor.text, g.answer)) problems.push(`${g.id}: the distractor also contains the answer "${g.answer}"`);
    const target = contentStems(g.target.text);
    const lexical = g.queries.find((q) => q.kind === "lexical");
    const lexicalShared = lexical ? [...contentStems(lexical.text)].filter((w) => target.has(w)).length : 0;
    for (const q of g.queries) {
      if (q.answer && !containsAnswer(g.target.text, q.answer)) problems.push(`${q.id}: its answer "${q.answer}" is not in the target note`);
      if (ids.has(q.id)) problems.push(`${q.id}: repeated id`);
      ids.add(q.id);
      const shared = [...contentStems(q.text)].filter((w) => target.has(w));
      let ok = true;
      let rule = "";
      if (q.kind === "lexical") {
        rule = "shares 2 or more words with the target";
        ok = shared.length >= 2;
      } else if (q.kind === "synonym") {
        rule = "shares fewer words than the lexical question";
        ok = shared.length < lexicalShared;
      } else if (q.kind === "low-overlap") {
        rule = "shares no word with the target";
        ok = shared.length === 0;
      } else if (q.kind === "negation") {
        rule = "contains a negation, and the target or distractor does too";
        ok = NEGATION.test(q.text) && (NEGATION.test(g.target.text) || NEGATION.test(g.distractor.text));
      } else if (q.kind === "date") {
        rule = "names a date or time written differently from the target";
        const dateLike = q.text.match(/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\b(first|second|third|twenty-fifth|quarter past \w+)\b|\b\d{1,2}(st|nd|rd|th)\b/i);
        ok = Boolean(dateLike) && !g.target.text.includes(dateLike![0]);
      }
      if (!ok) problems.push(`${q.id} (${q.kind}): breaks the rule "${rule}"; shared words: ${shared.join(", ") || "none"}`);
      lines.push(`${ok ? "ok  " : "FAIL"} ${q.id.padEnd(8)} ${q.kind.padEnd(11)} shared ${String(shared.length).padStart(2)}  ${q.text}`);
    }
  }
  return { lines, problems };
}

if (process.argv[1]?.endsWith("check.ts")) {
  const { lines, problems } = check(await loadSet());
  console.log(lines.join("\n"));
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nEvery question follows its rule.");
}
