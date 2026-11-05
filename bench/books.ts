// Long-text benchmark: real books and an outside question set, against pasting everything into the chat.
//
//   npx tsx bench/books.ts            full run (downloads about 21 MB once into bench/.cache/books/)
//   npx tsx bench/books.ts --quick    a few hundred questions, for a fast check
//
// What it measures, per question: is the answer in what the server returns (a plain search, no follow-up read),
// is the note that holds it listed, at which rank, how many tokens the result costs and how long it takes.
// "Paste everything" always contains the answer when it fits, so it is the upper bound for quality; the cost
// is the size of the text. Nothing in this file was used to tune the search: it runs once and reports.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEncoding } from "js-tiktoken";
import { looksLikeInjection, prepareNoteText } from "../src/safety.js";
import type { SearchDiagnostics } from "../src/retrieval/memoryIndex.js";
import { quality, RunWriter, shownOf, timings, type GroupPlan, type GroupSpec, type QueryRecord, type Retrieved } from "./lib/runs.js";
import { judge } from "./lib/scoring.js";
export { containsAnswer } from "./lib/scoring.js";
import { containsAnswer } from "./lib/scoring.js";
import {
  BOOK_TITLES,
  SOURCES,
  bookToChapterNotes,
  bookToOneNote,
  fetchSources,
  narrativeQuestions,
  paragraphsOf,
  squadToNotes,
  unzip,
  type NarrativeQuestion,
  type Note,
  type SquadQuestion,
} from "./books-data.js";

process.env.TZ = "UTC"; // dates in outputs do not depend on where the benchmark runs
const BENCH = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(BENCH, ".cache", "books");
const QUICK = process.argv.includes("--quick");
// --needles-embeddings: only the planted facts in Moby Dick and Emma by chapter, keyword search against keywords
// and vectors merged (an embedding model through the Ollama API on 127.0.0.1, RAG_OLLAMA_MODEL, default all-minilm).
// Written as its own run (bench/runs/books-needles-embeddings/), so the main run is unchanged.
const NEEDLES_EMBEDDINGS = process.argv.includes("--needles-embeddings");
const SAMPLE = QUICK ? 200 : 1000;
const WINDOWS = [8_000, 32_000, 128_000, 200_000, 1_000_000];

const encoder = getEncoding("o200k_base");
const countTokens = (text: string) => encoder.encode(text).length;

// ---------------------------------------------------------------------------------------------------------
// Facts planted in a long book ("needle in a haystack"). Half of the questions keep a name from the fact, the
// way people usually ask; the other half share no word with it, the hardest case for keyword search.

export interface Needle {
  id: string;
  fact: string;
  answer: string;
  keyword: string;
  question: string;
  overlap: "name" | "none";
}

export const NEEDLES: Needle[] = [
  { id: "n01", fact: "The spare key for the boathouse padlock is taped under the third step of the cellar stairs.", answer: "third step of the cellar stairs", keyword: "boathouse padlock", question: "Where do we hide the backup way into the shed by the river?", overlap: "none" },
  { id: "n02", fact: "Doctor Ilsa Marrow's clinic in Portsmouth closes at 4:45 on Thursdays.", answer: "4:45", keyword: "Marrow clinic", question: "What time does Ilsa Marrow stop seeing patients late in the week?", overlap: "name" },
  { id: "n03", fact: "The guest network code for the Kestrel Street office is written on the back of the green kettle.", answer: "back of the green kettle", keyword: "Kestrel Street network", question: "How can visitors get online at our workplace?", overlap: "none" },
  { id: "n04", fact: "Our accountant, Bertram Quill, charges 85 pounds an hour for tax returns.", answer: "85 pounds", keyword: "Bertram Quill", question: "How much does Bertram Quill bill us for his time?", overlap: "name" },
  { id: "n05", fact: "The backup generator at Fenwick Farm runs for 31 hours on a full tank of diesel.", answer: "31 hours", keyword: "Fenwick generator", question: "How long can the emergency power unit keep going before it needs refuelling?", overlap: "none" },
  { id: "n06", fact: "Rosalind Achebe was promoted to head of logistics on 12 March.", answer: "12 March", keyword: "Rosalind Achebe", question: "When did Rosalind Achebe take charge of shipping and deliveries?", overlap: "name" },
  { id: "n07", fact: "The Vantor ticketing system must be renewed before 30 September or support lapses.", answer: "30 September", keyword: "Vantor renewal", question: "By what date do we have to pay again for the help desk software?", overlap: "none" },
  { id: "n08", fact: "The quarterly budget review moved from Monday to Wednesday at 10:30 in room Larch.", answer: "Wednesday at 10:30", keyword: "budget review Larch", question: "When is the meeting in Larch about money now held?", overlap: "name" },
  { id: "n09", fact: "Pelham, the office parrot, eats only sunflower seeds and sliced mango.", answer: "sunflower seeds", keyword: "Pelham parrot", question: "What food does the bird at work get?", overlap: "none" },
  { id: "n10", fact: "The van's tyre pressure should be 3.4 bar at the front and 3.8 bar at the back.", answer: "3.4 bar", keyword: "van tyre pressure", question: "How hard should we pump the lorry's leading wheels?", overlap: "none" },
  { id: "n11", fact: "Ottoline Brack prefers to be contacted by letter, never by telephone.", answer: "by letter", keyword: "Ottoline Brack", question: "How does Ottoline Brack want us to get in touch?", overlap: "name" },
  { id: "n12", fact: "The staging server for Project Halyard is switched off every Friday at 18:00 to save money.", answer: "every Friday at 18:00", keyword: "Halyard staging server", question: "When does Halyard's test machine get shut down?", overlap: "name" },
  { id: "n13", fact: "Grandma Wren's lemon cake needs 220 grams of caster sugar.", answer: "220 grams", keyword: "Wren lemon cake", question: "How much sweetener goes into the citrus bake from our family recipe?", overlap: "none" },
  { id: "n14", fact: "The shared car park permit number for the Elm Court building is QX-5512.", answer: "QX-5512", keyword: "Elm Court permit", question: "What is the parking pass reference for Elm Court?", overlap: "name" },
  { id: "n15", fact: "Thaddeus Okoro is allergic to peanuts and to penicillin.", answer: "penicillin", keyword: "Thaddeus Okoro allergic", question: "Which medicine must Thaddeus Okoro never be given?", overlap: "name" },
  { id: "n16", fact: "The cold store in warehouse B must stay below minus 18 degrees Celsius.", answer: "minus 18 degrees", keyword: "cold store warehouse", question: "What temperature limit applies to the freezer room?", overlap: "none" },
  { id: "n17", fact: "Membership of the Corvid Rowing Club costs 240 pounds a year, paid in January.", answer: "240 pounds", keyword: "Corvid Rowing Club", question: "What is the yearly fee for the Corvid club?", overlap: "name" },
  { id: "n18", fact: "The fire assembly point for the Saltmarsh office is the bench beside the bakery.", answer: "bench beside the bakery", keyword: "Saltmarsh assembly point", question: "Where should staff gather if the alarm goes off?", overlap: "none" },
  { id: "n19", fact: "Imogen Sallow signed the lease for the new studio on 3 June for five years.", answer: "five years", keyword: "Imogen Sallow lease", question: "How long is Imogen Sallow's rental agreement for the studio?", overlap: "name" },
  { id: "n20", fact: "The printer on the second floor jams unless you use 80 gsm paper.", answer: "80 gsm", keyword: "printer jams", question: "Which kind of sheets stop the upstairs copier from getting stuck?", overlap: "none" },
];

// Plants needle i after the paragraph at depth i/(n-1) of the book, from the first paragraph to the last.
export function plantNeedles(raw: string, needles: Needle[] = NEEDLES): string {
  const paragraphs = paragraphsOf(raw);
  const positions = needles.map((_, i) => Math.round((i / (needles.length - 1)) * (paragraphs.length - 1)));
  for (let i = needles.length - 1; i >= 0; i--) {
    paragraphs.splice(positions[i] + 1, 0, needles[i].fact);
  }
  return paragraphs.join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------
// Turning questions into searches

const STOPWORDS = new Set(
  (
    "a an the of in on at to for from by with about as into onto over under after before during between through " +
    "and or but not no nor is are was were be been being am do does did done has have had having what which who " +
    "whom whose when where why how that this these those it its they them their there he him his she her hers we " +
    "us our you your i me my can could would should will shall may might must also than then so if any some such " +
    "many much more most other another each every all both either neither own same very just only too up down out " +
    "off again further once here"
  ).split(" "),
);

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

// What an AI that follows the skill would type: the question without question words and stopwords.
export function keywordsOf(question: string): string {
  const kept = words(question).filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return kept.join(" ") || question;
}

// The single rarest word of the question, for the old server, which searches for the exact text typed.
function rarestWord(question: string, df: Map<string, number>): string {
  const candidates = words(question).filter((w) => !STOPWORDS.has(w.toLowerCase()));
  let best = candidates[0] ?? question;
  let bestDf = Infinity;
  for (const w of candidates) {
    const f = df.get(w.toLowerCase()) ?? 0;
    if (f > 0 && (f < bestDf || (f === bestDf && w.length > best.length))) {
      best = w;
      bestDf = f;
    }
  }
  return best;
}

export function documentFrequency(notes: Note[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const note of notes) {
    for (const paragraph of note.text.split("\n\n")) {
      for (const w of new Set(words(paragraph.toLowerCase()))) df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  return df;
}

// The answer with up to four of its neighbouring words, as they appear in the source paragraph. Finding one
// of these shows the answer came from the right place, not from an unrelated mention.
function evidenceWindows(paragraph: string, answerStart: number, answer: string): string[] {
  const before = words(paragraph.slice(0, answerStart)).slice(-4).join(" ");
  const after = words(paragraph.slice(answerStart + answer.length)).slice(0, 4).join(" ");
  return [before && `${before} ${answer}`, after && `${answer} ${after}`].filter(Boolean) as string[];
}

function goldSentence(paragraph: string, answerStart: number): string {
  let start = 0;
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const index = paragraph.indexOf(sentence, start);
    if (answerStart >= index && answerStart < index + sentence.length) return sentence;
    start = index + sentence.length;
  }
  return paragraph;
}

export function seededShuffle<T>(items: T[], seed = 1): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Servers

export type System = "current" | "current-ngram" | "current-ollama" | "baseline";

interface Hit {
  path: string;
  text: string;
  line?: number; // the old server reports matching lines
  diag?: SearchDiagnostics["hits"][number];
}

export interface Server {
  search(query: string, limit?: number): Promise<{ text: string; hits: Hit[]; ms: number; error: string | null; vectorStatus?: SearchDiagnostics["vectorStatus"] }>;
  definitionTokens: number;
  startTokens: number;
  env: Record<string, string>;
  close(): Promise<void>;
}

export function systemEnv(system: System, vault: string, extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    AI_MEMORY_DIR: vault,
    // The benchmark makes thousands of calls in one session; the per-session rate limit would stop it.
    MCP_MAX_CALLS_PER_MINUTE: "1000000000",
    ...(system === "current-ngram" ? { RAG_EMBEDDINGS: "ngram" } : {}),
    // A local embedding model through the Ollama API (127.0.0.1 only), e.g. `ollama pull all-minilm`.
    ...(system === "current-ollama" ? { RAG_EMBEDDINGS: "ollama", RAG_OLLAMA_MODEL: process.env.RAG_OLLAMA_MODEL || "all-minilm" } : {}),
    ...extraEnv,
  };
}

export async function connect(system: System, vault: string, extraEnv: Record<string, string> = {}): Promise<Server> {
  const dir = system === "baseline" ? path.join(BENCH, "baseline") : path.join(BENCH, "..", "src");
  const memory = await import(pathToFileURL(path.join(dir, "memory.ts")).href);
  const server = await import(pathToFileURL(path.join(dir, "mcpServer.ts")).href);
  const env = systemEnv(system, vault, extraEnv);
  const config = memory.getMemoryConfig(env);
  // This server's index reports each search's ranks and scores to the benchmark (the old server has no index).
  let last: SearchDiagnostics | undefined;
  if (system !== "baseline") {
    const { getMemoryIndex } = await import(pathToFileURL(path.join(dir, "retrieval", "memoryIndex.ts")).href);
    getMemoryIndex(config).onSearch = (info: SearchDiagnostics) => {
      last = info;
    };
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.createObsidianMemoryMcpServer(config).connect(serverTransport);
  const client = new Client({ name: "book-benchmark", version: "1.0.0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return { text, isError: Boolean(result.isError) };
  };
  const { tools } = await client.listTools();
  const definitionTokens =
    tools.reduce((sum, t) => sum + countTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema })), 0) +
    countTokens(client.getInstructions() ?? "");
  const startTokens = countTokens((await call("read_main_context", {})).text);

  return {
    definitionTokens,
    startTokens,
    env,
    async search(query, limit) {
      last = undefined;
      const started = performance.now();
      let text = "";
      let error: string | null = null;
      try {
        const result = await call("search_memory", system === "baseline" || limit === undefined ? { query } : { query, limit });
        text = result.text;
        if (result.isError) error = result.text;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ms = performance.now() - started;
      const hits = parseHits(text);
      const diagnostics = last as SearchDiagnostics | undefined;
      if (diagnostics) hits.forEach((hit, i) => (hit.diag = diagnostics.hits[i]));
      return { text, hits, ms, error, vectorStatus: diagnostics?.vectorStatus };
    },
    close: () => client.close(),
  };
}

// The first search builds the index. With embeddings on, the server embeds for at most 10 seconds per search
// and continues on the next one, so it warms up until a search no longer has embedding work to do. Without
// embeddings one search is enough (repeating would never end on a server whose every search is slow, such as the
// old server on a large vault).
export async function warmUp(server: Server): Promise<number> {
  const started = performance.now();
  const embeds = Boolean(server.env.RAG_EMBEDDINGS);
  for (let i = 0; i < (embeds ? 1000 : 1); i++) {
    const { ms } = await server.search("index warm-up");
    if (ms < 1500) break;
  }
  return performance.now() - started;
}

function parseHits(text: string): Hit[] {
  if (text.trimStart().startsWith("{")) {
    try {
      const json = JSON.parse(text) as { matches?: { path?: string; file?: string; text?: string; snippet?: string; line?: number }[] };
      return (json.matches ?? []).map((m) => ({ path: m.path ?? m.file ?? "", text: m.text ?? m.snippet ?? JSON.stringify(m), line: m.line }));
    } catch {
      return [];
    }
  }
  return [...text.matchAll(/<note path="([^"]*)"[^>]*>([\s\S]*?)<\/note>/g)].map((m) => ({ path: m[1], text: m[2] }));
}

// ---------------------------------------------------------------------------------------------------------
// Running a question set

export interface Query {
  id: string;
  query: string;
  answers: string[];
  goldPath?: string; // the note that holds the answer
  goldBook?: string; // for book-level questions: the book folder
  evidence?: string[];
  pasteKey?: string; // "path\nparagraph" of the paragraph that holds the answer, for the paste comparison
  pasteTokenEnd?: number;
  tags: Record<string, string>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? round1((100 * part) / whole) : 0);

// Asks every query once, judges each answer with bench/lib/scoring.ts and, with a writer, records it.
export async function runQueries(server: Server, queries: Query[], limit?: number, group = "", writer?: RunWriter): Promise<QueryRecord[]> {
  const out: QueryRecord[] = [];
  for (const q of queries) {
    const { text, hits, ms, error, vectorStatus } = await server.search(q.query, limit);
    const gold = { answers: q.answers, evidence: q.evidence, chunk: q.goldPath, book: q.goldBook, pasteTokenEnd: q.pasteTokenEnd };
    let from = 0;
    const retrieved: Retrieved[] = hits.map((h, i) => {
      // Each result is stored as a span of the whole answer when it appears there verbatim (it always does for this
      // server), so the records do not hold the same text twice.
      const start = text.indexOf(h.text, from);
      if (start >= 0) from = start + h.text.length;
      return {
      rank: i + 1,
      chunk: h.diag?.chunk ?? (h.line !== undefined ? `${h.path}:${h.line}` : h.path),
      path: h.path,
      heading: h.diag?.heading,
      ...(start >= 0 ? { span: [start, start + h.text.length] as [number, number] } : { text: h.text }),
      fusedRank: h.diag?.fusedRank,
      bm25: h.diag?.bm25,
      vector: h.diag?.vector,
      matchedPassages: h.diag?.matchedPassages,
      vectorPassage: h.diag?.vectorPassage,
      };
    });
    const record: QueryRecord = {
      group,
      id: q.id,
      query: q.query,
      gold: JSON.parse(JSON.stringify(gold)),
      tags: q.tags,
      output: text,
      retrieved: JSON.parse(JSON.stringify(retrieved)),
      correct: judge(text, shownOf(text, retrieved), gold),
      tokens: countTokens(text),
      ms: round1(ms),
      error,
      ...(vectorStatus ? { vectorStatus } : {}),
    };
    writer?.record(record);
    out.push(record);
  }
  return out;
}

// Quality and times for a list of records (used by bench/books-tune.ts).
export function summarise(records: QueryRecord[]) {
  return { ...quality(records), ...timings(records) };
}

// ---------------------------------------------------------------------------------------------------------
// Pasting everything: the whole text in path order. A question is inside the first N tokens when the
// paragraph that answers it ends before token N.

interface PasteStream {
  totalTokens: number;
  paragraphEnd: Map<string, number>; // `${path}\n${paragraph}` -> token count at its end
}

function pasteStream(notes: Note[]): PasteStream {
  let total = 0;
  const paragraphEnd = new Map<string, number>();
  for (const note of [...notes].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    total += countTokens(`${note.path}\n`);
    for (const paragraph of note.text.split("\n\n")) {
      total += countTokens(`${paragraph}\n\n`);
      paragraphEnd.set(`${note.path}\n${paragraph.trim()}`, total);
    }
  }
  return { totalTokens: total, paragraphEnd };
}

// ---------------------------------------------------------------------------------------------------------

export async function writeVault(dir: string, notes: Note[]): Promise<void> {
  for (const note of notes) {
    const file = path.join(dir, note.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, note.text);
  }
}

export function needleQueries(notes: Note[], style: "keyword" | "question" | "oneword", df: Map<string, number>, needles: Needle[] = NEEDLES): Query[] {
  return needles.map((n, i) => ({
    id: n.id,
    query: style === "keyword" ? n.keyword : style === "question" ? n.question : rarestWord(n.keyword, df),
    answers: [n.answer],
    goldPath: notes.find((note) => note.text.includes(n.fact))?.path,
    evidence: [],
    pasteKey: `${notes.find((note) => note.text.includes(n.fact))?.path}\n${n.fact}`,
    tags: { overlap: n.overlap, depth: `${Math.round((100 * i) / (needles.length - 1))}%` },
  }));
}

const QUESTION_TYPES = ["what", "who", "when", "where", "why", "how", "which"];

export function squadQueries(questions: SquadQuestion[], style: "question" | "keywords" | "oneword", df: Map<string, number>): Query[] {
  return questions.map((q) => {
    const first = q.question.toLowerCase().match(/\b(what|who|when|where|why|how|which)\b/)?.[1];
    const sentence = goldSentence(q.paragraph, q.answerStart);
    const qWords = words(q.question.toLowerCase()).filter((w) => !STOPWORDS.has(w));
    const sWords = new Set(words(sentence.toLowerCase()));
    const overlap = qWords.length ? qWords.filter((w) => sWords.has(w)).length / qWords.length : 0;
    return {
      id: q.id,
      query: style === "question" ? q.question : style === "keywords" ? keywordsOf(q.question) : rarestWord(q.question, df),
      answers: q.answers,
      goldPath: q.notePath,
      evidence: evidenceWindows(q.paragraph, q.answerStart, q.answers[0]),
      pasteKey: `${q.notePath}\n${q.paragraph.trim()}`,
      tags: {
        type: first && QUESTION_TYPES.includes(first) ? first : "other",
        overlap: overlap < 1 / 3 ? "low (under 1/3 of words in the answer sentence)" : overlap < 2 / 3 ? "medium" : "high (2/3 or more)",
      },
    };
  });
}

interface PlannedGroup extends GroupPlan, GroupSpec {
  scope: string;
  system: System;
  limit?: number;
  queryList: Query[];
}

async function main(): Promise<void> {
  const started = Date.now();
  const data = await fetchSources(CACHE);
  const books = new Map<string, string>();
  for (const [name, buffer] of unzip(data.gutenberg)) {
    const id = path.basename(name, ".txt");
    if (name.endsWith(".txt") && BOOK_TITLES[id]) books.set(id, buffer.toString("latin1"));
  }
  const squad = squadToNotes(data.squad);
  const nqa = narrativeQuestions(data.narrativeqaQuestions, data.narrativeqaDocuments);

  const mobyRaw = plantNeedles(books.get("melville-moby_dick")!);
  const emmaRaw = plantNeedles(books.get("austen-emma")!);
  const mobyChapters = bookToChapterNotes("melville-moby_dick", mobyRaw);
  const emmaChapters = bookToChapterNotes("austen-emma", emmaRaw);
  const allBookChapters = [...books.entries()].flatMap(([id, raw]) =>
    id === "melville-moby_dick" ? mobyChapters : bookToChapterNotes(id, raw),
  );

  const allScopes: { name: string; about: string; notes: Note[] }[] = [
    { name: "squad", about: "48 Wikipedia articles, one note each (SQuAD 1.1 development set)", notes: squad.notes },
    { name: "moby-chapters", about: "Moby Dick, one note per chapter, 20 facts planted", notes: mobyChapters },
    { name: "moby-one-note", about: "Moby Dick as a single note, 20 facts planted", notes: [bookToOneNote("melville-moby_dick", mobyRaw)] },
    { name: "emma-chapters", about: "Emma, one note per chapter, 20 facts planted", notes: emmaChapters },
    { name: "emma-one-note", about: "Emma as a single note, 20 facts planted", notes: [bookToOneNote("austen-emma", emmaRaw)] },
    { name: "library", about: "Everything together: 18 books by chapter (facts in Moby Dick) and the 48 articles", notes: [...allBookChapters, ...squad.notes] },
  ];
  const scopes = NEEDLES_EMBEDDINGS ? allScopes.filter((sc) => sc.name === "moby-chapters" || sc.name === "emma-chapters") : allScopes;

  const sample = seededShuffle(squad.questions).slice(0, SAMPLE);
  const squadSet = QUICK ? sample : squad.questions;

  // 1. The plan: every group of queries, with its exact size, fixed before anything runs.
  const plan: PlannedGroup[] = [];
  const facts: Record<string, unknown> = {};
  const streams = new Map<string, PasteStream>();
  for (const scope of scopes) {
    const stream = pasteStream(scope.notes);
    streams.set(scope.name, stream);
    const df = documentFrequency(scope.notes);
    const add = (system: System, set: string, style: string, queries: Query[], spec: GroupSpec = {}, limit?: number, note?: string) => {
      const withEnd = queries.map((q) => ({ ...q, pasteTokenEnd: q.pasteKey ? stream.paragraphEnd.get(q.pasteKey) : undefined }));
      const name = `${scope.name}/${system}/${set}/${style}/limit-${limit ?? (system === "baseline" ? "old" : 5)}`;
      plan.push({
        name,
        queries: withEnd.length,
        about: { scope: scope.name, system, set, style, limit: limit ?? (system === "baseline" ? "old server" : 5), ...(note ? { note } : {}) },
        ...spec,
        scope: scope.name,
        system,
        limit,
        queryList: withEnd,
      });
    };
    const squadSpec: GroupSpec = { breakdowns: ["type", "overlap"], truncationWindows: WINDOWS };
    const needleSpec: GroupSpec = { breakdowns: ["overlap", "depth"], truncationWindows: WINDOWS };
    const needleSet = (style: "keyword" | "question" | "oneword") => needleQueries(scope.notes, style, df);
    const setName = QUICK ? "squad-sample" : "squad-all";
    if (NEEDLES_EMBEDDINGS) {
      for (const system of ["current", "current-ollama"] as const) {
        for (const style of ["keyword", "question"] as const) add(system, "needles", style, needleSet(style), needleSpec);
      }
    } else if (scope.name === "squad") {
      for (const style of ["keywords", "question", "oneword"] as const) add("current", setName, style, squadQueries(squadSet, style, df), squadSpec);
      // The same 1,000-question sample as the library run, so the effect of the extra books can be compared.
      // (In a quick run the main set already is the sample.)
      if (!QUICK) add("current", "squad-sample", "keywords", squadQueries(sample, "keywords", df), squadSpec);
      add("current", "squad-sample", "keywords", squadQueries(sample, "keywords", df), squadSpec, 10);
      add("current-ngram", "squad-sample", "keywords", squadQueries(sample, "keywords", df), squadSpec);
      add("current-ngram", "squad-sample", "question", squadQueries(sample, "question", df), squadSpec);
      add("baseline", setName, "oneword", squadQueries(squadSet, "oneword", df), squadSpec);
      add("baseline", "squad-sample", "question", squadQueries(sample, "question", df), squadSpec);
    } else if (scope.name === "library") {
      for (const style of ["keywords", "question"] as const) add("current", "squad-sample", style, squadQueries(sample, style, df), squadSpec);
      for (const style of ["keyword", "question"] as const) add("current", "needles", style, needleSet(style), needleSpec);
      add("baseline", "needles", "oneword", needleSet("oneword"), needleSpec);
      add("baseline", "squad-sample", "oneword", squadQueries(sample.slice(0, Math.min(300, SAMPLE)), "oneword", df), squadSpec);
      for (const style of ["keywords", "question"] as const) {
        const queries = nqa.map((q: NarrativeQuestion) => ({
          id: q.id,
          query: style === "question" ? q.question : keywordsOf(q.question),
          answers: q.answers,
          goldBook: q.book,
          tags: { book: q.book },
        }));
        add("current", "narrativeqa", style, queries, { breakdowns: ["book"] }, undefined,
          "Answer found is not meaningful here: NarrativeQA answers are free text written from plot summaries, and many are not in the book word for word. Use the right-book numbers.");
      }
    } else {
      for (const style of ["keyword", "question"] as const) add("current", "needles", style, needleSet(style), needleSpec);
      if (scope.name === "moby-chapters") {
        for (const style of ["keyword", "question"] as const) add("current-ngram", "needles", style, needleSet(style), needleSpec);
        add("baseline", "needles", "oneword", needleSet("oneword"), needleSpec);
        add("baseline", "needles", "keyword", needleSet("keyword"), needleSpec);
      }
    }
    const chars = scope.notes.reduce((sum, n) => sum + n.text.length, 0);
    facts[scope.name] = {
      about: scope.about,
      notes: scope.notes.length,
      megabytes: round1(chars / 1e6),
      largestNoteBytes: Math.max(...scope.notes.map((n) => Buffer.byteLength(n.text))),
      pasteEverythingTokens: stream.totalTokens,
      ...(scope.name === "squad"
        ? {
            // The most a whole-word check can find: some SQuAD answers are only part of a word ("four" in "fourth").
            answerCeilingPct: pct(squadSet.filter((q) => q.answers.some((a) => containsAnswer(q.paragraph, a))).length, squadSet.length),
            rightArticleTokensMean: Math.round(scope.notes.reduce((sum, n) => sum + countTokens(n.text), 0) / scope.notes.length),
          }
        : {}),
      ...(scope.name === "library"
        ? { bookTokens: Object.fromEntries([...books.entries()].map(([id, raw]) => [BOOK_TITLES[id], countTokens(paragraphsOf(raw).join("\n\n"))])) }
        : {}),
    };
  }

  const writer = await RunWriter.start(path.join(BENCH, ".."), path.join(BENCH, "runs"), NEEDLES_EMBEDDINGS ? "books-needles-embeddings" : QUICK ? "books-quick" : "books", {
    config: {
      about: "Long-text benchmark (bench/books.ts). Run once per change; nothing here is used to tune the search.",
      quick: QUICK,
      squadSampleSize: SAMPLE,
      squadSampleSeed: 1,
      pasteWindows: WINDOWS,
      defaultLimit: 5,
      tokenizer: "o200k_base",
      timeZone: process.env.TZ,
      systems: Object.fromEntries(
        ((NEEDLES_EMBEDDINGS ? ["current", "current-ollama"] : ["current", "current-ngram", "baseline"]) as System[]).map((s) => [s, systemEnv(s, "<vault>")]),
      ),
      ...(NEEDLES_EMBEDDINGS ? { embeddingModelNote: process.env.RAG_EVAL_MODEL_NOTE ?? null } : {}),
    },
    data: {
      sources: Object.fromEntries(
        Object.entries(SOURCES)
          .filter(([k]) => k !== "squadTrain")
          .map(([k, src]) => [k, { url: src.url, sha256: src.sha256, about: src.about, license: src.license }]),
      ),
      plantedFacts: NEEDLES,
    },
    plan: plan.map(({ name, queries, about, breakdowns, truncationWindows }) => ({ name, queries, about, breakdowns, truncationWindows })),
  });

  // 2. Run it, scope by scope.
  const timingFacts: Record<string, unknown> = {};
  const base = await mkdtemp(path.join(os.tmpdir(), "books-bench-"));
  try {
    for (const scope of scopes) {
      const vault = path.join(base, scope.name);
      await writeVault(vault, scope.notes);
      console.log(`\n== ${scope.name}: ${scope.notes.length} notes, ${streams.get(scope.name)!.totalTokens.toLocaleString()} tokens if pasted`);
      const servers = new Map<System, Server>();
      for (const group of plan.filter((g) => g.scope === scope.name)) {
        let server = servers.get(group.system);
        if (!server) {
          server = await connect(group.system, vault);
          servers.set(group.system, server);
          // The first search builds the index (and, with embeddings, every vector); timed on its own.
          timingFacts[`${scope.name}/${group.system}/firstSearchMs`] = round1(await warmUp(server));
          (facts[scope.name] as Record<string, unknown>)[`${group.system}DefinitionTokens`] = server.definitionTokens;
          (facts[scope.name] as Record<string, unknown>)[`${group.system}StartTokens`] = server.startTokens;
        }
        const records = await runQueries(server, group.queryList, group.limit, group.name, writer);
        const q = quality(records);
        const t = timings(records);
        console.log(
          `${group.name.padEnd(56)} found ${q.foundPct}%${q.evidencePct !== null ? ` context ${q.evidencePct}%` : ""}` +
            `${q.goldListedPct !== null ? ` listed ${q.goldListedPct}%` : ""}${q.topRightBookPct !== null ? ` top hit right book ${q.topRightBookPct}%` : ""}` +
            ` tokens ${q.tokensMean} ms ${t.msMean}${q.errors ? ` ERRORS ${q.errors}` : ""}`,
        );
      }
      for (const server of servers.values()) await server.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  // 3. What the safety filters do to real, harmless text: everything they flag here is a false alarm.
  const library = allScopes.find((sc) => sc.name === "library")!.notes;
  const safety = { notes: library.length, flaggedAsInstructions: 0, withSecretsMasked: 0, withPersonalDataMasked: 0, withHiddenTextRemoved: 0, examples: [] as { kind: string; note: string; text: string }[] };
  for (const note of library) {
    const prepared = prepareNoteText(note.text);
    if (prepared.suspicious) {
      safety.flaggedAsInstructions++;
      const paragraph = note.text.split("\n\n").find((p) => looksLikeInjection(p));
      if (paragraph && safety.examples.filter((e) => e.kind === "instructions").length < 8) {
        safety.examples.push({ kind: "instructions", note: note.path, text: paragraph.slice(0, 240) });
      }
    }
    if (prepared.secretsRemoved) safety.withSecretsMasked++;
    if (prepared.personalRemoved) safety.withPersonalDataMasked++;
    if (prepared.hiddenRemoved) safety.withHiddenTextRemoved++;
    if ((prepared.secretsRemoved || prepared.personalRemoved) && safety.examples.filter((e) => e.kind === "mask").length < 8) {
      const paragraph = note.text.split("\n\n").find((p) => {
        const c = prepareNoteText(p);
        return c.secretsRemoved || c.personalRemoved;
      });
      if (paragraph) safety.examples.push({ kind: "mask", note: note.path, text: `${paragraph.slice(0, 200)} => ${prepareNoteText(paragraph).text.slice(0, 200)}` });
    }
  }
  // An answer the masking hid: it appears as whole words in the original paragraph but not after cleaning.
  const destroyed = squad.questions.filter(
    (q) => q.answers.some((a) => containsAnswer(q.paragraph, a)) && !q.answers.some((a) => containsAnswer(prepareNoteText(q.paragraph).text, a)),
  );
  facts.safety = { ...safety, squadAnswersHiddenByMasking: destroyed.length };

  timingFacts.minutes = round1((Date.now() - started) / 60000);
  await writer.finish(facts, timingFacts);
  console.log(`\nWrote ${path.relative(process.cwd(), writer.dir)} in ${timingFacts.minutes} minutes. Check it with: npm run bench:verify -- ${path.relative(process.cwd(), writer.dir)}`);
}

// Runs only when this file is executed, not when bench/books-tune.ts imports its helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
