// Public data for the long-text benchmark (bench/books.ts).
//
// Nothing here is committed to the repository. The files are downloaded once into bench/.cache/books/ and
// checked against SHA-256 sums, so every run uses exactly the same data; if a source ever changes, the run
// stops instead of quietly giving different numbers.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export const SOURCES = {
  gutenberg: {
    url: "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/gutenberg.zip",
    sha256: "2d3c3ab548c653944310f37f536443ec85d0a0ad855fcae217a0c9efdce2d611",
    about: "18 public-domain books from Project Gutenberg, as packaged by NLTK",
  },
  squad: {
    url: "https://raw.githubusercontent.com/rajpurkar/SQuAD-explorer/master/dataset/dev-v1.1.json",
    sha256: "95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9",
    about: "SQuAD 1.1 development set: 10,570 questions on 48 Wikipedia articles (CC BY-SA 4.0)",
  },
  narrativeqaQuestions: {
    url: "https://raw.githubusercontent.com/google-deepmind/narrativeqa/master/qaps.csv",
    sha256: "990b02af0b5280de210f0e6b80f43b3fab80dc6de630c4d5059a1b7131c26e38",
    about: "NarrativeQA questions about whole books (Apache 2.0)",
  },
  narrativeqaDocuments: {
    url: "https://raw.githubusercontent.com/google-deepmind/narrativeqa/master/documents.csv",
    sha256: "6dffa4cc0b5c9963fe3a097c87f04aa7767da36627500cc7a0d69e2405e1144a",
    about: "NarrativeQA list of books",
  },
} as const;
export type SourceName = keyof typeof SOURCES;

export async function fetchSources(cacheDir: string): Promise<Record<SourceName, Buffer>> {
  await mkdir(cacheDir, { recursive: true });
  const out = {} as Record<SourceName, Buffer>;
  for (const [name, source] of Object.entries(SOURCES) as [SourceName, (typeof SOURCES)[SourceName]][]) {
    const file = path.join(cacheDir, path.basename(source.url));
    let data: Buffer;
    if (existsSync(file)) {
      data = await readFile(file);
    } else {
      console.log(`downloading ${source.url}`);
      const response = await fetch(source.url, { redirect: "error" });
      if (!response.ok) {
        throw new Error(`${source.url}: HTTP ${response.status}`);
      }
      data = Buffer.from(await response.arrayBuffer());
    }
    const sum = createHash("sha256").update(data).digest("hex");
    if (sum !== source.sha256) {
      throw new Error(`${path.basename(file)} has SHA-256 ${sum}, expected ${source.sha256}. Delete it to download again.`);
    }
    if (!existsSync(file)) {
      await writeFile(file, data);
    }
    out[name] = data;
  }
  return out;
}

// A small zip reader (stored and deflated entries), so the benchmark needs no extra package.
export function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLength);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    if (!name.endsWith("/")) {
      if (method === 0) files.set(name, Buffer.from(raw));
      else if (method === 8) files.set(name, inflateRawSync(raw));
      else throw new Error(`${name}: unsupported zip method ${method}`);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export interface Note {
  path: string;
  text: string;
}

export const BOOK_TITLES: Record<string, string> = {
  "austen-emma": "Emma",
  "austen-persuasion": "Persuasion",
  "austen-sense": "Sense and Sensibility",
  "bible-kjv": "The King James Bible",
  "blake-poems": "Poems of William Blake",
  "bryant-stories": "Stories to Tell to Children",
  "burgess-busterbrown": "The Adventures of Buster Bear",
  "carroll-alice": "Alice's Adventures in Wonderland",
  "chesterton-ball": "The Ball and the Cross",
  "chesterton-brown": "The Wisdom of Father Brown",
  "chesterton-thursday": "The Man Who Was Thursday",
  "edgeworth-parents": "The Parent's Assistant",
  "melville-moby_dick": "Moby Dick",
  "milton-paradise": "Paradise Lost",
  "shakespeare-caesar": "Julius Caesar",
  "shakespeare-hamlet": "Hamlet",
  "shakespeare-macbeth": "Macbeth",
  "whitman-leaves": "Leaves of Grass",
};

const HEADING = /^(?:CHAPTER|Chapter|BOOK|Book|STAVE|Actus|Scena|Scoena)\b[^\n]{0,60}$/;
const MAX_NOTE_CHARS = 40_000;

// Gutenberg text wraps lines at about 70 characters. A note in Obsidian has one line per paragraph, so lines
// inside a paragraph are joined.
export function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((line) => line.trim()).filter(Boolean).join(" "))
    .filter(Boolean);
}

// One note per chapter (or act, scene or book of a poem), the way someone would keep a book in Obsidian.
// Long parts without headings (the Bible, poem collections) are cut into notes of at most 40,000 characters.
export function bookToChapterNotes(id: string, raw: string): Note[] {
  const title = BOOK_TITLES[id] ?? id;
  const sections: { heading: string; paragraphs: string[] }[] = [{ heading: "Opening", paragraphs: [] }];
  for (const paragraph of paragraphsOf(raw)) {
    if (HEADING.test(paragraph)) sections.push({ heading: paragraph, paragraphs: [] });
    else sections[sections.length - 1].paragraphs.push(paragraph);
  }
  const notes: Note[] = [];
  for (const section of sections) {
    let part: string[] = [];
    let size = 0;
    const flush = () => {
      if (part.length === 0) return;
      const n = String(notes.length + 1).padStart(3, "0");
      notes.push({ path: `Books/${title}/${n}.md`, text: `# ${title}: ${section.heading}\n\n${part.join("\n\n")}\n` });
      part = [];
      size = 0;
    };
    for (const paragraph of section.paragraphs) {
      if (size + paragraph.length > MAX_NOTE_CHARS) flush();
      part.push(paragraph);
      size += paragraph.length + 2;
    }
    flush();
  }
  return notes;
}

// The whole book in one note.
export function bookToOneNote(id: string, raw: string): Note {
  const title = BOOK_TITLES[id] ?? id;
  return { path: `Books/${title}.md`, text: `# ${title}\n\n${paragraphsOf(raw).join("\n\n")}\n` };
}

export interface SquadQuestion {
  id: string;
  question: string;
  answers: string[];
  title: string;
  notePath: string;
  paragraph: string;
  answerStart: number; // character offset of the first answer in its paragraph
}

interface SquadFile {
  data: { title: string; paragraphs: { context: string; qas: { id: string; question: string; answers: { text: string; answer_start: number }[] }[] }[] }[];
}

// One note per Wikipedia article: its title as a heading, then its paragraphs.
export function squadToNotes(json: Buffer): { notes: Note[]; questions: SquadQuestion[] } {
  const squad = JSON.parse(json.toString("utf8")) as SquadFile;
  const notes: Note[] = [];
  const questions: SquadQuestion[] = [];
  for (const article of squad.data) {
    const title = article.title.replace(/_/g, " ");
    const notePath = `Wikipedia/${title.replace(/[\\/:*?"<>|%]/g, "-")}.md`;
    notes.push({ path: notePath, text: `# ${title}\n\n${article.paragraphs.map((p) => p.context.trim()).join("\n\n")}\n` });
    for (const paragraph of article.paragraphs) {
      for (const qa of paragraph.qas) {
        questions.push({
          id: qa.id,
          question: qa.question.trim(),
          answers: [...new Set(qa.answers.map((a) => a.text.trim()))],
          title,
          notePath,
          paragraph: paragraph.context,
          answerStart: qa.answers[0].answer_start,
        });
      }
    }
  }
  return { notes, questions };
}

export interface NarrativeQuestion {
  id: string;
  book: string; // BOOK_TITLES value
  question: string;
  answers: string[];
}

const NARRATIVEQA_BOOKS: Record<string, string> = {
  "Persuasion (novel)": "Persuasion",
  "Emma (novel)": "Emma",
  "Sense and Sensibility": "Sense and Sensibility",
  "The Man Who Was Thursday": "The Man Who Was Thursday",
  "Paradise Lost": "Paradise Lost",
};

// The NarrativeQA questions about the books that are also in the NLTK set.
export function narrativeQuestions(questionsCsv: Buffer, documentsCsv: Buffer): NarrativeQuestion[] {
  const documents = new Map(parseCsv(documentsCsv.toString("utf8")).map((d) => [d.document_id, d]));
  const out: NarrativeQuestion[] = [];
  for (const q of parseCsv(questionsCsv.toString("utf8"))) {
    const document = documents.get(q.document_id);
    const book = document && document.kind === "gutenberg" ? NARRATIVEQA_BOOKS[document.wiki_title] : undefined;
    if (book) {
      out.push({ id: `nqa-${out.length + 1}`, book, question: q.question.trim(), answers: [q.answer1.trim(), q.answer2.trim()] });
    }
  }
  return out;
}
