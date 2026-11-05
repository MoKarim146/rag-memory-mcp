// The short version of the main context returned by read_main_context.
//
// The five main files are loaded at the start of every session, so their size is paid again and again.
// Decisions and tasks only ever grow, so instead of returning them whole:
//   - 02_DECISIONS.md: the newest decisions in full, one line each with their date, up to DECISIONS_BUDGET
//     characters; older ones as their first sentence only, up to OLDER_DECISIONS_BUDGET.
//   - 03_OPEN_TASKS.md: only open tasks ("- [ ]"); finished tasks ("- [x]") are left out.
//   - the other three files: whole, up to FILE_BUDGET characters each.
// Anything left out is still in the files and can be found with search_memory or read with read_note.

import type { MemoryFile } from "./memory.js";

export const FILE_BUDGET = 4000;
export const DECISIONS_BUDGET = 1500;
// Older decisions that do not fit are listed by their first sentence only, up to this many characters,
// so the AI knows they exist and can search for the reason.
export const OLDER_DECISIONS_BUDGET = 900;
const OLDER_DECISION_CHARS = 90;
export const TASKS_BUDGET = 2000;

export interface ContextPart {
  path: string;
  text: string;
  shown?: string; // set when part of the file was left out, says what is shown
}

export function compactMainContext(files: MemoryFile[]): ContextPart[] {
  return files.map((file) => {
    if (file.path === "02_DECISIONS.md") {
      return { path: file.path, ...newestDecisions(file.content) };
    }
    if (file.path === "03_OPEN_TASKS.md") {
      return { path: file.path, ...openTasks(file.content) };
    }
    return { path: file.path, ...truncate(file.content, FILE_BUDGET) };
  });
}

interface DecisionEntry {
  date: string;
  line: string; // the whole decision on one line: "2026-09-16: <decision> Reason: <reason>"
  first: string; // the date and the first sentence of the decision only
}

// Reads "## <date>" sections with "- Decision: ..." and "  Reason: ..." lines. Anything in a section that is
// not in that form is kept as it is, on its own line, so hand-written notes are not lost.
function parseDecisions(dated: string[]): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  for (const section of dated) {
    const newline = section.indexOf("\n");
    const date = (newline > 0 ? section.slice(3, newline) : section.slice(3)).trim();
    const body = newline > 0 ? section.slice(newline + 1) : "";
    const items = body.split(/\n(?=\s*-\s)/).map((item) => item.trim()).filter(Boolean);
    for (const item of items) {
      const decision = /^-\s*Decision:\s*([\s\S]*?)(?:\n\s*Reason:\s*([\s\S]*))?$/.exec(item);
      if (!decision) {
        const plain = item.replace(/\s*\n\s*/g, " ");
        entries.push({ date, line: `${date}: ${plain.replace(/^-\s*/, "")}`, first: `${date}: ${plain.replace(/^-\s*/, "")}` });
        continue;
      }
      const what = decision[1].replace(/\s*\n\s*/g, " ").trim();
      const why = decision[2]?.replace(/\s*\n\s*/g, " ").trim();
      const firstSentence = what.replace(/\s+\(added by AI via MCP\)$/, "").split(/(?<=\.)\s/)[0];
      const short = firstSentence.length > OLDER_DECISION_CHARS ? `${firstSentence.slice(0, OLDER_DECISION_CHARS - 1)}…` : firstSentence;
      entries.push({ date, line: `${date}: ${what}${why ? ` Reason: ${why}` : ""}`, first: `${date}: ${short}` });
    }
  }
  return entries;
}

function newestDecisions(content: string): { text: string; shown?: string } {
  const sections = content.replace(/\r\n?/g, "\n").split(/\n(?=## )/);
  const dated = sections.filter((section) => section.startsWith("## "));
  if (dated.length === 0) {
    return tail(content, DECISIONS_BUDGET);
  }

  // One line per decision (date first) instead of a heading per date: the same words in fewer tokens.
  const entries = parseDecisions(dated);
  const kept: string[] = [];
  let used = 0;
  let index = entries.length - 1;
  for (; index >= 0; index -= 1) {
    const line = `- ${entries[index].line}`;
    if (kept.length > 0 && used + line.length > DECISIONS_BUDGET) {
      break;
    }
    kept.unshift(line);
    used += line.length + 1;
  }
  if (index < 0) {
    return { text: kept.join("\n") };
  }

  // Older decisions, newest first, as their date and first sentence only, until the budget is used.
  const lines: string[] = [];
  let olderUsed = 0;
  for (let i = index; i >= 0; i -= 1) {
    const line = `- ${entries[i].first}`;
    if (olderUsed + line.length > OLDER_DECISIONS_BUDGET) {
      break;
    }
    lines.push(line);
    olderUsed += line.length + 1;
  }
  const older = lines.length > 0 ? `\nOlder, first sentence only:\n${lines.join("\n")}` : "";
  const olderNote = lines.length > 0 ? `, ${lines.length} older as one line each` : "";
  return { text: kept.join("\n") + older, shown: `newest ${kept.length} of ${entries.length} in full${olderNote}` };
}

function openTasks(content: string): { text: string; shown?: string } {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const done = lines.filter((line) => /^\s*[-*]\s+\[[xX]\]/.test(line)).length;
  const kept = lines.filter((line, index) => {
    if (/^\s*[-*]\s+\[[xX]\]/.test(line)) {
      return false;
    }
    if (index === 0 && /^#\s/.test(line)) {
      return false; // the file's own title, the path already says what it is
    }
    return true;
  });

  const { text, shown } = truncate(kept.join("\n").trim(), TASKS_BUDGET);
  const parts = [done > 0 ? `open tasks only, ${done} done hidden` : undefined, shown].filter(Boolean);
  return { text, shown: parts.length > 0 ? parts.join("; ") : undefined };
}

function truncate(content: string, budget: number): { text: string; shown?: string } {
  const text = content.trim();
  if (text.length <= budget) {
    return { text };
  }
  const cut = text.lastIndexOf("\n", budget);
  const end = cut > budget / 2 ? cut : budget;
  return { text: text.slice(0, end), shown: `first ${end} of ${text.length} characters` };
}

function tail(content: string, budget: number): { text: string; shown?: string } {
  const text = content.trim();
  if (text.length <= budget) {
    return { text };
  }
  const start = text.indexOf("\n", text.length - budget);
  const from = start >= 0 ? start + 1 : text.length - budget;
  return { text: text.slice(from), shown: `last ${text.length - from} of ${text.length} characters` };
}
