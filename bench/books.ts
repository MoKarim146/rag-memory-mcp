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

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(BENCH, ".cache", "books");
const QUICK = process.argv.includes("--quick");
const SAMPLE = QUICK ? 200 : 1000;
const WINDOWS = [8_000, 32_000, 128_000, 200_000, 1_000_000];

const encoder = getEncoding("o200k_base");
const countTokens = (text: string) => encoder.encode(text).length;

// ---------------------------------------------------------------------------------------------------------
// Facts planted in a long book ("needle in a haystack"). Half of the questions keep a name from the fact, the
// way people usually ask; the other half share no word with it, the hardest case for keyword search.

interface Needle {
  id: string;
  fact: string;
  answer: string;
  keyword: string;
  question: string;
  overlap: "name" | "none";
}

const NEEDLES: Needle[] = [
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
function plantNeedles(raw: string): string {
  const paragraphs = paragraphsOf(raw);
  const positions = NEEDLES.map((_, i) => Math.round((i / (NEEDLES.length - 1)) * (paragraphs.length - 1)));
  for (let i = NEEDLES.length - 1; i >= 0; i--) {
    paragraphs.splice(positions[i] + 1, 0, NEEDLES[i].fact);
  }
  return paragraphs.join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------
// Text checks, the same normalisation SQuAD uses: lower case, no punctuation, no articles.

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")} `;
}

function containsAnswer(text: string, answer: string): boolean {
  const a = normalise(answer);
  return a.trim().length > 0 && normalise(text).includes(a);
}

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
function keywordsOf(question: string): string {
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

function documentFrequency(notes: Note[]): Map<string, number> {
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

function seededShuffle<T>(items: T[], seed = 1): T[] {
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

type System = "current" | "current-ngram" | "baseline";

interface Hit {
  path: string;
  text: string;
}

interface Server {
  search(query: string, limit?: number): Promise<{ text: string; hits: Hit[]; ms: number }>;
  definitionTokens: number;
  startTokens: number;
  close(): Promise<void>;
}

async function connect(system: System, vault: string): Promise<Server> {
  const dir = system === "baseline" ? path.join(BENCH, "baseline") : path.join(BENCH, "..", "src");
  const memory = await import(pathToFileURL(path.join(dir, "memory.ts")).href);
  const server = await import(pathToFileURL(path.join(dir, "mcpServer.ts")).href);
  const config = memory.getMemoryConfig({
    AI_MEMORY_DIR: vault,
    // The benchmark makes thousands of calls in one session; the per-session rate limit would stop it.
    MCP_MAX_CALLS_PER_MINUTE: "1000000000",
    ...(system === "current-ngram" ? { RAG_EMBEDDINGS: "ngram" } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.createObsidianMemoryMcpServer(config).connect(serverTransport);
  const client = new Client({ name: "book-benchmark", version: "1.0.0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { type: string; text?: string }[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  };
  const { tools } = await client.listTools();
  const definitionTokens =
    tools.reduce((sum, t) => sum + countTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema })), 0) +
    countTokens(client.getInstructions() ?? "");
  const startTokens = countTokens(await call("read_main_context", {}));

  return {
    definitionTokens,
    startTokens,
    async search(query, limit) {
      const started = performance.now();
      const text = await call("search_memory", system === "baseline" || limit === undefined ? { query } : { query, limit });
      const ms = performance.now() - started;
      return { text, hits: parseHits(text), ms };
    },
    close: () => client.close(),
  };
}

function parseHits(text: string): Hit[] {
  if (text.trimStart().startsWith("{")) {
    try {
      const json = JSON.parse(text) as { matches?: { path?: string; file?: string; text?: string; snippet?: string; line?: string }[] };
      return (json.matches ?? []).map((m) => ({ path: m.path ?? m.file ?? "", text: m.text ?? m.snippet ?? m.line ?? JSON.stringify(m) }));
    } catch {
      return [];
    }
  }
  return [...text.matchAll(/<note path="([^"]*)"[^>]*>([\s\S]*?)<\/note>/g)].map((m) => ({ path: m[1], text: m[2] }));
}

// ---------------------------------------------------------------------------------------------------------
// Running a question set

interface Query {
  id: string;
  query: string;
  answers: string[];
  goldPath?: string; // the note that holds the answer
  goldBook?: string; // for book-level questions: the book folder
  evidence?: string[];
  tags: Record<string, string>;
}

interface QueryResult {
  id: string;
  found: boolean;
  evidence: boolean | null;
  goldListed: boolean | null;
  rightBookShare: number | null;
  topRightBook: boolean | null;
  rank: number;
  tokens: number;
  ms: number;
  tags: Record<string, string>;
}

async function runQueries(server: Server, queries: Query[], limit?: number): Promise<QueryResult[]> {
  const out: QueryResult[] = [];
  for (const q of queries) {
    const { text, hits, ms } = await server.search(q.query, limit);
    const found = q.answers.some((a) => containsAnswer(text, a));
    const rankIndex = hits.findIndex((h) => q.answers.some((a) => containsAnswer(h.text, a)));
    const inBook = (h: Hit) => q.goldBook !== undefined && h.path.startsWith(`Books/${q.goldBook}/`);
    out.push({
      id: q.id,
      found,
      evidence: q.evidence ? q.evidence.some((w) => containsAnswer(text, w)) || (q.evidence.length === 0 && found) : null,
      goldListed: q.goldPath ? hits.some((h) => h.path === q.goldPath) : null,
      rightBookShare: q.goldBook ? (hits.length ? hits.filter(inBook).length / hits.length : 0) : null,
      topRightBook: q.goldBook ? hits.length > 0 && inBook(hits[0]) : null,
      rank: rankIndex + 1,
      tokens: countTokens(text),
      ms,
      tags: q.tags,
    });
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? round1((100 * part) / whole) : 0);

function summarise(results: QueryResult[]) {
  const n = results.length;
  const count = (f: (r: QueryResult) => boolean | null) => results.filter((r) => f(r) === true).length;
  const has = (f: (r: QueryResult) => unknown) => results.some((r) => f(r) !== null);
  return {
    questions: n,
    found: count((r) => r.found),
    foundPct: pct(count((r) => r.found), n),
    evidencePct: has((r) => r.evidence) ? pct(count((r) => r.evidence), n) : undefined,
    goldListedPct: has((r) => r.goldListed) ? pct(count((r) => r.goldListed), n) : undefined,
    rightBookSharePct: has((r) => r.rightBookShare)
      ? round1((100 * results.reduce((s, r) => s + (r.rightBookShare ?? 0), 0)) / n)
      : undefined,
    topRightBookPct: has((r) => r.topRightBook) ? pct(count((r) => r.topRightBook), n) : undefined,
    mrr: Math.round((1000 * results.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0)) / Math.max(1, n)) / 1000,
    tokensMean: Math.round(results.reduce((s, r) => s + r.tokens, 0) / Math.max(1, n)),
    tokensMedian: percentile(results.map((r) => r.tokens), 50),
    tokensP90: percentile(results.map((r) => r.tokens), 90),
    msMean: round1(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, n)),
    msP95: round1(percentile(results.map((r) => r.ms), 95)),
  };
}

function breakdown(results: QueryResult[], tag: string) {
  const groups = new Map<string, QueryResult[]>();
  for (const r of results) {
    const key = r.tags[tag] ?? "other";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return Object.fromEntries(
    [...groups.entries()].sort().map(([key, rs]) => [key, { questions: rs.length, foundPct: summarise(rs).foundPct, evidencePct: summarise(rs).evidencePct }]),
  );
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

function truncationRecall(stream: PasteStream, keys: string[]) {
  return WINDOWS.map((window) => ({
    window,
    pct: pct(keys.filter((k) => (stream.paragraphEnd.get(k) ?? Infinity) <= window).length, keys.length),
  }));
}

// ---------------------------------------------------------------------------------------------------------

async function writeVault(dir: string, notes: Note[]): Promise<void> {
  for (const note of notes) {
    const file = path.join(dir, note.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, note.text);
  }
}

function needleQueries(notes: Note[], style: "keyword" | "question" | "oneword", df: Map<string, number>): Query[] {
  return NEEDLES.map((n, i) => ({
    id: n.id,
    query: style === "keyword" ? n.keyword : style === "question" ? n.question : rarestWord(n.keyword, df),
    answers: [n.answer],
    goldPath: notes.find((note) => note.text.includes(n.fact))?.path,
    evidence: [],
    tags: { overlap: n.overlap, depth: `${Math.round((100 * i) / (NEEDLES.length - 1))}%` },
  }));
}

function needleKeys(notes: Note[]): string[] {
  return NEEDLES.map((n) => {
    const note = notes.find((x) => x.text.includes(n.fact));
    return note ? `${note.path}\n${n.fact}` : "";
  });
}

const QUESTION_TYPES = ["what", "who", "when", "where", "why", "how", "which"];

function squadQueries(questions: SquadQuestion[], style: "question" | "keywords" | "oneword", df: Map<string, number>): Query[] {
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
      tags: {
        type: first && QUESTION_TYPES.includes(first) ? first : "other",
        overlap: overlap < 1 / 3 ? "low (under 1/3 of words in the answer sentence)" : overlap < 2 / 3 ? "medium" : "high (2/3 or more)",
      },
    };
  });
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

  const scopes: { name: string; about: string; notes: Note[] }[] = [
    { name: "squad", about: "48 Wikipedia articles, one note each (SQuAD 1.1 development set)", notes: squad.notes },
    { name: "moby-chapters", about: "Moby Dick, one note per chapter, 20 facts planted", notes: mobyChapters },
    { name: "moby-one-note", about: "Moby Dick as a single note, 20 facts planted", notes: [bookToOneNote("melville-moby_dick", mobyRaw)] },
    { name: "emma-chapters", about: "Emma, one note per chapter, 20 facts planted", notes: emmaChapters },
    { name: "emma-one-note", about: "Emma as a single note, 20 facts planted", notes: [bookToOneNote("austen-emma", emmaRaw)] },
    { name: "library", about: "Everything together: 18 books by chapter (facts in Moby Dick) and the 48 articles", notes: [...allBookChapters, ...squad.notes] },
  ];

  const sample = seededShuffle(squad.questions).slice(0, SAMPLE);
  const squadSet = QUICK ? sample : squad.questions;
  const base = await mkdtemp(path.join(os.tmpdir(), "books-bench-"));
  const report: Record<string, unknown> = {
    about: "Long-text benchmark (bench/books.ts). Run once; nothing here was used to tune the search.",
    quick: QUICK,
    node: process.version,
    cpuModel: os.cpus()[0]?.model,
    tokenizer: "o200k_base",
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { url: s.url, sha256: s.sha256, about: s.about }])),
    sample: { squadSampleSize: SAMPLE, seed: 1 },
    scopes: [] as unknown[],
  };

  try {
    for (const scope of scopes) {
      const vault = path.join(base, scope.name);
      await writeVault(vault, scope.notes);
      const stream = pasteStream(scope.notes);
      const df = documentFrequency(scope.notes);
      const chars = scope.notes.reduce((s, n) => s + n.text.length, 0);
      const largestNoteBytes = Math.max(...scope.notes.map((n) => Buffer.byteLength(n.text)));
      console.log(`\n== ${scope.name}: ${scope.notes.length} notes, ${stream.totalTokens.toLocaleString()} tokens if pasted`);

      const entry: Record<string, unknown> = {
        name: scope.name,
        about: scope.about,
        notes: scope.notes.length,
        megabytes: round1(chars / 1e6),
        largestNoteBytes,
        pasteEverythingTokens: stream.totalTokens,
        runs: [] as unknown[],
      };
      const runs = entry.runs as unknown[];

      const plan: { system: System; set: string; style: string; limit?: number; queries: Query[]; keys?: string[] }[] = [];
      const needleSet = (style: "keyword" | "question" | "oneword") => needleQueries(scope.notes, style, df);
      if (scope.name === "squad") {
        for (const style of ["keywords", "question", "oneword"] as const) {
          plan.push({ system: "current", set: QUICK ? "squad-sample" : "squad-all", style, queries: squadQueries(squadSet, style, df) });
        }
        // The same 1,000-question sample as the library run, so the effect of the extra books can be compared.
        plan.push({ system: "current", set: "squad-sample", style: "keywords", queries: squadQueries(sample, "keywords", df) });
        plan.push({ system: "current", set: "squad-sample", style: "keywords", limit: 10, queries: squadQueries(sample, "keywords", df) });
        plan.push({ system: "current-ngram", set: "squad-sample", style: "keywords", queries: squadQueries(sample, "keywords", df) });
        plan.push({ system: "current-ngram", set: "squad-sample", style: "question", queries: squadQueries(sample, "question", df) });
        plan.push({ system: "baseline", set: QUICK ? "squad-sample" : "squad-all", style: "oneword", queries: squadQueries(squadSet, "oneword", df) });
        plan.push({ system: "baseline", set: "squad-sample", style: "question", queries: squadQueries(sample, "question", df) });
        entry.truncation = truncationRecall(stream, squadSet.map((q) => `${q.notePath}\n${q.paragraph.trim()}`));
        // The most a whole-word check can find: some SQuAD answers are only part of a word ("four" in "fourth").
        entry.answerCeilingPct = pct(squadSet.filter((q) => q.answers.some((a) => containsAnswer(q.paragraph, a))).length, squadSet.length);
        entry.rightArticleTokensMean = Math.round(scope.notes.reduce((s, n) => s + countTokens(n.text), 0) / scope.notes.length);
      } else if (scope.name === "library") {
        for (const style of ["keywords", "question"] as const) {
          plan.push({ system: "current", set: "squad-sample", style, queries: squadQueries(sample, style, df) });
        }
        for (const style of ["keyword", "question"] as const) plan.push({ system: "current", set: "needles", style, queries: needleSet(style) });
        plan.push({ system: "baseline", set: "needles", style: "oneword", queries: needleSet("oneword") });
        plan.push({ system: "baseline", set: "squad-sample", style: "oneword", queries: squadQueries(sample.slice(0, Math.min(300, SAMPLE)), "oneword", df) });
        for (const style of ["keywords", "question"] as const) {
          plan.push({
            system: "current",
            set: "narrativeqa",
            style,
            queries: nqa.map((q: NarrativeQuestion) => ({
              id: q.id,
              query: style === "question" ? q.question : keywordsOf(q.question),
              answers: q.answers,
              goldBook: q.book,
              tags: { book: q.book },
            })),
          });
        }
        entry.truncation = truncationRecall(stream, [...sample.map((q) => `${q.notePath}\n${q.paragraph.trim()}`)]);
        entry.needleTruncation = truncationRecall(stream, needleKeys(scope.notes));
        entry.bookTokens = Object.fromEntries(
          [...books.entries()].map(([id, raw]) => [BOOK_TITLES[id], countTokens(paragraphsOf(raw).join("\n\n"))]),
        );
      } else {
        for (const style of ["keyword", "question"] as const) plan.push({ system: "current", set: "needles", style, queries: needleSet(style) });
        if (scope.name === "moby-chapters") {
          for (const style of ["keyword", "question"] as const) plan.push({ system: "current-ngram", set: "needles", style, queries: needleSet(style) });
          plan.push({ system: "baseline", set: "needles", style: "oneword", queries: needleSet("oneword") });
          plan.push({ system: "baseline", set: "needles", style: "keyword", queries: needleSet("keyword") });
        }
        entry.needleTruncation = truncationRecall(stream, needleKeys(scope.notes));
      }

      const servers = new Map<System, Server>();
      for (const run of plan) {
        let server = servers.get(run.system);
        if (!server) {
          server = await connect(run.system, vault);
          servers.set(run.system, server);
          // The first search builds the index; time it on its own.
          const first = await server.search("index warm-up");
          entry[`${run.system}FirstSearchMs`] = round1(first.ms);
          entry[`${run.system}DefinitionTokens`] = server.definitionTokens;
          entry[`${run.system}StartTokens`] = server.startTokens;
        }
        const results = await runQueries(server, run.queries, run.limit);
        const summary = summarise(results);
        const record: Record<string, unknown> = { system: run.system, set: run.set, style: run.style, limit: run.limit ?? (run.system === "baseline" ? "old server" : 5), ...summary };
        if (run.set.startsWith("squad") && run.system === "current") {
          record.byType = breakdown(results, "type");
          record.byOverlap = breakdown(results, "overlap");
        }
        if (run.set === "needles") {
          record.byOverlap = breakdown(results, "overlap");
          record.perNeedle = results.map((r) => ({ id: r.id, found: r.found, listed: r.goldListed, rank: r.rank, tokens: r.tokens }));
        }
        if (run.set === "narrativeqa") {
          record.byBook = breakdown(results, "book");
          record.note = "found is not meaningful here: NarrativeQA answers are free text written from plot summaries, and many are not in the book word for word. Use topRightBookPct.";
        }
        if (run.set.startsWith("squad") && run.system === "current" && run.style === "keywords" && run.limit === undefined) {
          record.missedExamples = results
            .filter((r) => !r.found)
            .slice(0, 12)
            .map((r) => {
              const q = squad.questions.find((x) => x.id === r.id)!;
              return { question: q.question, answer: q.answers[0], query: keywordsOf(q.question), article: q.title };
            });
        }
        runs.push(record);
        console.log(
          `${run.system.padEnd(13)} ${run.set.padEnd(12)} ${run.style.padEnd(9)} limit ${String(record.limit).padEnd(10)} found ${summary.foundPct}%` +
            `${summary.evidencePct !== undefined ? ` evidence ${summary.evidencePct}%` : ""}${summary.goldListedPct !== undefined ? ` listed ${summary.goldListedPct}%` : ""}` +
            `${summary.topRightBookPct !== undefined ? ` top hit right book ${summary.topRightBookPct}%` : ""} tokens ${summary.tokensMean} ms ${summary.msMean}`,
        );
      }
      for (const server of servers.values()) await server.close();
      (report.scopes as unknown[]).push(entry);
    }

    // What the safety filters do to real, harmless text: everything they flag here is a false alarm.
    const library = scopes.find((s) => s.name === "library")!.notes;
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
      (q) =>
        q.answers.some((a) => containsAnswer(q.paragraph, a)) &&
        !q.answers.some((a) => containsAnswer(prepareNoteText(q.paragraph).text, a)),
    );
    report.safety = {
      ...safety,
      squadAnswersHiddenByMasking: destroyed.length,
      squadAnswersHiddenExamples: destroyed.slice(0, 8).map((q) => ({ question: q.question, answer: q.answers[0] })),
    };
    console.log(`\nsafety on real text: ${JSON.stringify({ ...safety, examples: undefined })}, SQuAD answers hidden by masking: ${destroyed.length}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  report.minutes = round1((Date.now() - started) / 60000);
  const file = path.join(BENCH, "results", QUICK ? "books-quick.json" : "books.json");
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), file)} in ${report.minutes} minutes`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
