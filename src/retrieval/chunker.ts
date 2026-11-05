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
