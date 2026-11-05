// The short version of the main context returned by read_main_context.
//
// The five main files are loaded at the start of every session, so their size is paid again and again.
// Decisions and tasks only ever grow, so instead of returning them whole:
//   - 02_DECISIONS.md: only the newest dated sections that fit in DECISIONS_BUDGET characters.
//   - 03_OPEN_TASKS.md: only open tasks ("- [ ]"); finished tasks ("- [x]") are left out.
//   - the other three files: whole, up to FILE_BUDGET characters each.
// Anything left out is still in the files and can be found with search_memory or read with read_note.

import type { MemoryFile } from "./memory.js";

export const FILE_BUDGET = 4000;
export const DECISIONS_BUDGET = 1500;
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

function newestDecisions(content: string): { text: string; shown?: string } {
  const sections = content.replace(/\r\n?/g, "\n").split(/\n(?=## )/);
  const dated = sections.filter((section) => section.startsWith("## "));
  if (dated.length === 0) {
    return tail(content, DECISIONS_BUDGET);
  }

  const kept: string[] = [];
  let used = 0;
  for (let i = dated.length - 1; i >= 0; i -= 1) {
    const section = dated[i].trim();
    if (kept.length > 0 && used + section.length > DECISIONS_BUDGET) {
      break;
    }
    kept.unshift(section);
    used += section.length + 2;
  }

  const countDecisions = (text: string) => (text.match(/^\s*-\s*Decision:/gm) ?? []).length;
  const total = countDecisions(content);
  const shownCount = countDecisions(kept.join("\n"));
  const text = kept.join("\n\n");
  if (kept.length === dated.length) {
    return { text };
  }
  return { text, shown: `newest ${shownCount} of ${total} decisions` };
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
