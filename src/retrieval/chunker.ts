// Splits a markdown note into small, self-contained chunks for retrieval.
//
// A chunk is one section of a note (the text under one heading), cut into pieces of at most
// MAX_CHUNK_CHARS. Each chunk remembers its heading path so a search hit can say where it came from.
// Small chunks are what make retrieval cheap: search returns a few relevant sections instead of whole files.

export const MAX_CHUNK_CHARS = 800;

export interface Chunk {
  ordinal: number; // position of the chunk inside its note, starting at 0
  heading: string; // deepest heading above the chunk, e.g. "Limits" or "2026-08-05"
  headingPath: string; // every heading above the chunk, e.g. "Payments (PayLoop) > Limits"
  text: string;
}

interface Section {
  headingPath: string[];
  lines: string[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function chunkMarkdown(markdown: string, maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const sections = splitSections(markdown.replace(/\r\n?/g, "\n"));
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (!body) {
      continue;
    }

    const headingPath = section.headingPath.filter(Boolean);
    for (const piece of splitBody(body, maxChars)) {
      chunks.push({
        ordinal: chunks.length,
        heading: headingPath.at(-1) ?? "",
        headingPath: headingPath.join(" > "),
        text: piece,
      });
    }
  }

  return chunks;
}

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let stack: string[] = [];
  let current: Section = { headingPath: [], lines: [] };
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    }

    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push(current);
      const level = match[1].length;
      stack = stack.slice(0, level - 1);
      while (stack.length < level - 1) {
        stack.push("");
      }
      stack.push(match[2].trim());
      current = { headingPath: [...stack], lines: [] };
      continue;
    }

    current.lines.push(line);
  }

  sections.push(current);
  return sections;
}

// Packs paragraphs into pieces of at most maxChars. A paragraph that is too long is split by lines,
// and a line that is too long is split at the last space before the limit.
function splitBody(body: string, maxChars: number): string[] {
  // Each unit keeps the separator that preceded it, so packed pieces keep the note's original line breaks.
  const units: { text: string; sep: string }[] = [];
  body.split(/\n\s*\n/).forEach((paragraph, p) => {
    const paragraphSep = p === 0 ? "" : "\n\n";
    if (paragraph.length <= maxChars) {
      units.push({ text: paragraph, sep: paragraphSep });
      return;
    }
    paragraph.split("\n").forEach((line, l) => {
      const lineSep = l === 0 ? paragraphSep : "\n";
      if (line.length <= maxChars) {
        units.push({ text: line, sep: lineSep });
        return;
      }
      hardSplit(line, maxChars).forEach((part, h) => units.push({ text: part, sep: h === 0 ? lineSep : " " }));
    });
  });

  const pieces: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!unit.text.trim()) {
      continue;
    }
    if (current && current.length + unit.sep.length + unit.text.length > maxChars) {
      pieces.push(current);
      current = unit.text;
    } else {
      current = current ? current + unit.sep + unit.text : unit.text;
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars / 2) {
      cut = maxChars;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) {
    parts.push(rest);
  }
  return parts;
}

// Passages are the units search ranks: one list item (with its indented continuation lines), one paragraph,
// one table row or one code block. Small units make ranking precise ("which bullet answers this?"); the
// section they belong to is what gets shown, so the answer keeps its context.
export const MAX_PASSAGE_CHARS = 400;

export interface Passage {
  text: string;
  context: string; // extra words that help matching but are not shown, e.g. a table's header row
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}/;

export function splitPassages(text: string, maxChars = MAX_PASSAGE_CHARS): Passage[] {
  const passages: Passage[] = [];
  let buffer: string[] = [];
  let kind: "prose" | "list" | "code" | null = null;
  let tableHeader = "";
  let inFence = false;

  const flush = () => {
    const joined = buffer.join("\n").trim();
    if (joined) {
      for (const piece of splitLong(joined, maxChars)) {
        passages.push({ text: piece, context: "" });
      }
    }
    buffer = [];
    kind = null;
  };

  for (const line of text.split("\n")) {
    if (inFence) {
      buffer.push(line);
      if (FENCE.test(line)) {
        inFence = false;
        flush();
      }
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      inFence = true;
      kind = "code";
      buffer.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      tableHeader = "";
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flush();
      if (TABLE_RULE.test(line)) {
        continue;
      }
      if (!tableHeader) {
        tableHeader = line;
      }
      passages.push({ text: line.trim(), context: line === tableHeader ? "" : tableHeader });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      kind = "list";
      buffer.push(line);
      continue;
    }
    if (kind === "list" && /^\s+\S/.test(line)) {
      buffer.push(line); // continuation of the list item above
      continue;
    }
    if (kind !== "prose") {
      flush();
      kind = "prose";
    }
    buffer.push(line);
  }
  flush();
  return passages;
}

// Splits a long passage at sentence ends, or at spaces if a sentence is itself too long.
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      pieces.push(current.trim());
      current = "";
    }
    if (sentence.length > maxChars) {
      pieces.push(...hardSplit(sentence, maxChars).map((p) => p.trim()));
      continue;
    }
    current += sentence;
  }
  if (current.trim()) {
    pieces.push(current.trim());
  }
  return pieces.filter(Boolean);
}
