// The search index: SQLite FTS5 keyword search with optional vectors on top.
//
// How a search works ("small-to-big" retrieval):
//   1. Every note is cut into sections (one heading's text) and every section into passages (one list item,
//      paragraph, table row or code block). Passages are what the keyword search ranks, so a single bullet
//      that answers the question can win on its own.
//   2. Matching passages are grouped back into their sections. A section's score is its best passage's score.
//   3. Weak hits are dropped: for questions of 3+ words a section must match 2 of them, and a section must
//      score at least RELATIVE_CUTOFF of the best section's score.
//   4. The best section shows its best passage with the passages around it; the others show only their
//      matching passages. If nothing passes step 3, up to 2 partial matches are returned, labelled as such.
//
// - The index lives in memory only (an in-memory SQLite database). Nothing is written to disk.
// - It is built the first time someone searches and brought up to date before every search: notes whose
//   size or modification time changed are re-read, deleted notes are dropped. No file watcher, no background job.
// - It only sees the notes read_note is allowed to read, because it lists and reads them through memory.ts.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { listNoteFiles, readNoteText, type MemoryConfig } from "../memory.js";
import { prepareNoteText } from "../safety.js";
import { chunkMarkdown, splitPassages } from "./chunker.js";
import { createEmbedder, dot, type Embedder } from "./embeddings.js";

export const DEFAULT_RESULT_LIMIT = 5;
export const MAX_RESULT_LIMIT = 10;
export const MAX_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 16;
const MAX_HITS_PER_FILE = 2;
const PASSAGE_CANDIDATES = 200;
const VECTOR_CANDIDATES = 50;
const RRF_K = 60;
const EMBED_BATCH = 16;
const EMBED_TIME_BUDGET_MS = 10_000;
// A section is kept only if its score is at least this share of the best section's score.
export const RELATIVE_CUTOFF = 0.5;
// When nothing matches well, at most this many partial matches are returned.
const PARTIAL_LIMIT = 2;

// Output size. The best hit shows up to TOP_HIT_CHARS of its best sentences; the others up to SNIPPET_CHARS.
// read_note gives the full note when needed.
export const TOP_HIT_CHARS = 450;
export const SNIPPET_CHARS = 180;
// Hits whose shown words overlap this much with an earlier hit are skipped as duplicates.
const DUPLICATE_SIMILARITY = 0.6;

function wordSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOPWORDS.has(word)));
}

// Jaccard similarity of the meaningful words: shared words divided by all distinct words of both.
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface SearchHit {
  path: string;
  heading: string;
  text: string; // the whole section
  snippet: string; // what search_memory shows
  ordinal: number;
  suspicious: boolean; // the note contains instruction-like text somewhere
  partial: boolean; // a weak match, returned only because nothing matched well
  updated: string; // the note's last modification date, YYYY-MM-DD
}

// What one search did, for benchmarks that must show their work (bench/books.ts). Only reported to an
// onSearch callback that the benchmark sets; the server never sets one, so nothing is logged in normal use.
export interface SearchDiagnostics {
  query: string;
  terms: string[];
  partial: boolean;
  hits: {
    chunk: string; // stable id: note path # section number
    path: string;
    heading: string;
    fusedRank: number; // 1-based place in the merged ranking, before the per-note limit and duplicate removal
    bm25: number | null; // best passage's BM25 score as FTS5 reports it (more negative is better), null if no word matched
    vector: number | null; // best passage's cosine similarity, null without embeddings or below the cutoff
    matchedPassages: number[]; // passage numbers inside the section that matched words
    vectorPassage: number | null; // passage number that matched by meaning
  }[];
}

interface SectionRow {
  id: number;
  path: string;
  ordinal: number;
  heading: string;
  text: string;
  suspicious: number;
  mtime: number;
}

interface PassageRow {
  id: number;
  section_id: number;
  pindex: number;
  text: string;
}

// Common English words that carry no meaning for search. Dropping them stops "what did we decide about X"
// from matching every note that contains "what" or "we".
const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers him his how i " +
    "if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own " +
    "same she should so some such than that the their theirs them then there these they this those through to too under " +
    "until up very was we were what when where which while who whom why will with would you your yours"
  ).split(" "),
);

export function queryTerms(query: string): string[] {
  const words = query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].filter((word) => word.length > 1 || /\d/.test(word));
  const meaningful = unique.filter((word) => !STOPWORDS.has(word));
  return (meaningful.length > 0 ? meaningful : unique).slice(0, MAX_QUERY_TERMS);
}

export function buildFtsQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return null;
  }
  // Every term is quoted, so nothing in the query can be read as FTS5 syntax (AND, NEAR, *, column filters).
  return terms.map((term) => `"${term}"`).join(" OR ");
}

// For a query with three or more words, a hit must match at least two of them. One shared word
// ("name", "file") is usually a coincidence and only adds noise.
function minimumTermsMatched(termCount: number): number {
  return termCount >= 3 ? 2 : 1;
}

export class MemoryIndex {
  private readonly db: DatabaseSync;
  private readonly vectors = new Map<string, Float32Array>(); // keyed by section text hash
  private pending: Promise<void> | undefined;
  onSearch?: (info: SearchDiagnostics) => void;

  constructor(
    private readonly config: MemoryConfig,
    private readonly embedder?: Embedder,
  ) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL, suspicious INTEGER NOT NULL);
      CREATE TABLE sections (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX sections_by_path ON sections(path);
      CREATE TABLE passages (
        id INTEGER PRIMARY KEY,
        section_id INTEGER NOT NULL,
        pindex INTEGER NOT NULL,
        text TEXT NOT NULL,
        vhash TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX passages_by_section ON passages(section_id);
      CREATE VIRTUAL TABLE passages_fts USING fts5(title, body, tokenize = 'porter unicode61 remove_diacritics 2');
    `);
  }

  // Brings the index up to date with the vault. Concurrent callers share one refresh.
  async refresh(): Promise<void> {
    if (!this.pending) {
      this.pending = this.doRefresh().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  // mode: "hybrid" uses keywords and, with an embedder, vectors; "keyword" and "dense" use one ranking only.
  // The mode is per search, not per index, because sessions with different modes share one index.
  async search(query: string, limit = DEFAULT_RESULT_LIMIT, mode: "hybrid" | "keyword" | "dense" = "hybrid"): Promise<SearchHit[]> {
    await this.refresh();

    const terms = queryTerms(query);
    const marked = new Map<number, string>(); // passage id -> text with matched words wrapped in \u0001 \u0002
    const sectionScore = new Map<number, number>(); // section id -> best (lowest) bm25 of its passages
    const sectionPassages = new Map<number, number[]>(); // section id -> its matching passage ids, best first
    let strict: number[] = [];
    let loose: number[] = [];

    if (terms.length > 0 && mode !== "dense") {
      const rows = this.db
        .prepare(
          `SELECT f.rowid AS id, p.section_id AS section, bm25(passages_fts, 2.0, 1.0) AS score,
                  highlight(passages_fts, 1, char(1), char(2)) AS marked
           FROM passages_fts f JOIN passages p ON p.id = f.rowid
           WHERE passages_fts MATCH ? ORDER BY score LIMIT ${PASSAGE_CANDIDATES}`,
        )
        .all(terms.map((term) => `"${term}"`).join(" OR ")) as { id: number; section: number; score: number; marked: string }[];

      for (const row of rows) {
        marked.set(row.id, row.marked);
        if (!sectionScore.has(row.section)) {
          sectionScore.set(row.section, row.score);
        }
        const list = sectionPassages.get(row.section) ?? [];
        list.push(row.id);
        sectionPassages.set(row.section, list);
      }

      loose = [...sectionScore.keys()]; // already in best-score order, because rows were
      // Ranking stays plain BM25 of the best passage. Weighting by the share of query words matched was
      // tried in round 3 and rejected: it lost an answer on test set 2 (RAG_RESULTS.md).
      const matchedTerms = this.termsMatchedPerSection(rows, terms);
      const needed = minimumTermsMatched(terms.length);
      const coveredList = loose.filter((id) => (matchedTerms.get(id) ?? 1) >= needed);
      const best = coveredList.length > 0 ? sectionScore.get(coveredList[0])! : 0;
      strict = coveredList.filter((id) => sectionScore.get(id)! <= best * RELATIVE_CUTOFF);
    }

    const vector = this.embedder && mode !== "keyword"
      ? await this.vectorSearch(query)
      : { sections: [], best: new Map<number, number>(), scores: new Map<number, number>() };
    let ranked = vector.sections.length > 0 ? fuse([strict, vector.sections]) : strict;
    let partial = false;
    if (ranked.length === 0 && loose.length > 0) {
      ranked = loose.slice(0, PARTIAL_LIMIT * 3);
      partial = true;
    }
    ranked = this.cleanFirst(ranked);

    const getSection = this.db.prepare(
      "SELECT s.id, s.path, s.ordinal, s.heading, s.text, f.suspicious, f.mtime FROM sections s JOIN files f ON f.path = s.path WHERE s.id = ?",
    );
    const getPassages = this.db.prepare("SELECT id, section_id, pindex, text FROM passages WHERE section_id = ? ORDER BY pindex");
    const perFile = new Map<string, number>();
    const hits: SearchHit[] = [];
    const diagnostics: SearchDiagnostics["hits"] = [];
    const shownWords: Set<string>[] = [];
    const cap = partial ? Math.min(limit, PARTIAL_LIMIT) : limit;

    for (const id of ranked) {
      const row = getSection.get(id) as SectionRow | undefined;
      if (!row) {
        continue;
      }
      const count = perFile.get(row.path) ?? 0;
      if (count >= MAX_HITS_PER_FILE) {
        continue;
      }
      perFile.set(row.path, count + 1);
      const passages = getPassages.all(id) as unknown as PassageRow[];
      const snippet = buildSnippet(passages, marked, hits.length === 0 && !partial, vector.best.get(id));
      // Skip a hit that says nearly the same as one already shown (a decision repeated in a meeting note).
      const words = wordSet(snippet);
      if (shownWords.some((other) => similarity(words, other) >= DUPLICATE_SIMILARITY)) {
        perFile.set(row.path, count);
        continue;
      }
      shownWords.push(words);
      if (this.onSearch) {
        const pindex = new Map(passages.map((p) => [p.id, p.pindex]));
        const vectorBest = vector.best.get(id);
        diagnostics.push({
          chunk: `${row.path}#${row.ordinal}`,
          path: row.path,
          heading: row.heading,
          fusedRank: ranked.indexOf(id) + 1,
          bm25: sectionScore.get(id) ?? null,
          vector: vector.scores.get(id) ?? null,
          matchedPassages: (sectionPassages.get(id) ?? []).map((p) => pindex.get(p) ?? -1),
          vectorPassage: vectorBest === undefined ? null : (pindex.get(vectorBest) ?? null),
        });
      }
      hits.push({
        path: row.path,
        heading: row.heading,
        text: row.text,
        snippet,
        ordinal: row.ordinal,
        suspicious: row.suspicious === 1,
        partial,
        updated: new Date(row.mtime).toISOString().slice(0, 10),
      });
      if (hits.length >= cap) {
        break;
      }
    }
    this.onSearch?.({ query, terms, partial, hits: diagnostics });
    return hits;
  }

  // Source scoring (OWASP LLM05): sections from notes flagged for instruction-like text are only returned
  // when no clean section matched. Ranking them last was not enough: when only one or two clean sections
  // passed the score cutoff, a planted note filled the empty places (it reached 18 of 25 test searches).
  // A flagged note can still be opened directly with read_note, and always carries a warning.
  private cleanFirst(ids: number[]): number[] {
    if (ids.length === 0) {
      return ids;
    }
    const flagged = new Set(
      (this.db
        .prepare(
          `SELECT s.id FROM sections s JOIN files f ON f.path = s.path WHERE f.suspicious = 1 AND s.id IN (${ids.join(",")})`,
        )
        .all() as { id: number }[]).map((row) => row.id),
    );
    const clean = ids.filter((id) => !flagged.has(id));
    return clean.length > 0 ? clean : ids;
  }

  // How many different query words each candidate section matches (in its passages or headings).
  private termsMatchedPerSection(rows: { id: number; section: number }[], terms: string[]): Map<number, number> {
    const counts = new Map<number, number>();
    if (rows.length === 0 || terms.length <= 1) {
      return counts;
    }
    const sectionOf = new Map(rows.map((row) => [row.id, row.section]));
    const matched = new Map<number, Set<string>>();
    const idList = rows.map((row) => row.id).join(","); // integers from the database, safe to inline
    for (const term of terms) {
      const hits = this.db
        .prepare(`SELECT rowid AS id FROM passages_fts WHERE passages_fts MATCH ? AND rowid IN (${idList})`)
        .all(`"${term}"`) as { id: number }[];
      for (const hit of hits) {
        const section = sectionOf.get(hit.id)!;
        const set = matched.get(section) ?? new Set<string>();
        set.add(term);
        matched.set(section, set);
      }
    }
    for (const [section, set] of matched) {
      counts.set(section, set.size);
    }
    return counts;
  }

  stats(): { files: number; sections: number; passages: number; vectors: number } {
    const count = (table: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { files: count("files"), sections: count("sections"), passages: count("passages"), vectors: this.vectors.size };
  }

  close(): void {
    this.db.close();
  }

  private async doRefresh(): Promise<void> {
    const files = await listNoteFiles(this.config);
    const known = new Map(
      (this.db.prepare("SELECT path, mtime, size FROM files").all() as { path: string; mtime: number; size: number }[]).map(
        (row) => [row.path, row],
      ),
    );

    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.path);
      const previous = known.get(file.path);
      if (previous && previous.mtime === file.mtimeMs && previous.size === file.size) {
        continue;
      }

      let text: string;
      try {
        text = await readNoteText(this.config, file.path);
      } catch {
        this.removeFile(file.path);
        continue;
      }
      this.replaceFile(file.path, file.mtimeMs, file.size, text);
    }

    for (const path of known.keys()) {
      if (!seen.has(path)) {
        this.removeFile(path);
      }
    }

    if (this.embedder) {
      await this.embedMissing(this.embedder);
    }
  }

  private replaceFile(path: string, mtime: number, size: number, raw: string): void {
    // Only cleaned text is indexed: hidden comments, invisible characters and secrets never enter the
    // index, so they cannot be searched for, used to push a note up the results, or sent to an embedder.
    const prepared = prepareNoteText(raw, { maskEmails: this.config.maskEmails, maskPhones: this.config.maskPhones });
    // Notes the owner marked private are kept out of the index entirely (and so out of any embedding).
    const sections = prepared.private ? [] : chunkMarkdown(prepared.text);
    const title = path.replace(/\.md$/, "").replace(/[/_-]+/g, " ");
    const insertSection = this.db.prepare(
      "INSERT INTO sections (path, ordinal, heading, text, hash) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPassage = this.db.prepare("INSERT INTO passages (section_id, pindex, text, vhash) VALUES (?, ?, ?, ?)");
    const insertFts = this.db.prepare("INSERT INTO passages_fts (rowid, title, body) VALUES (?, ?, ?)");

    this.db.exec("BEGIN");
    try {
      this.deleteFileRows(path);
      this.db
        .prepare("INSERT OR REPLACE INTO files (path, mtime, size, suspicious) VALUES (?, ?, ?, ?)")
        .run(path, mtime, size, prepared.suspicious ? 1 : 0);
      for (const section of sections) {
        const hash = createHash("sha256").update(section.text).digest("hex");
        const sectionId = Number(insertSection.run(path, section.ordinal, section.heading, section.text, hash).lastInsertRowid);
        splitPassages(section.text).forEach((passage, pindex) => {
          // With embeddings on, each passage gets its own vector, keyed by the text that is embedded.
          const vhash = this.embedder ? createHash("sha256").update(embedText(section.heading, passage.text)).digest("hex") : "";
          const passageId = Number(insertPassage.run(sectionId, pindex, passage.text, vhash).lastInsertRowid);
          insertFts.run(passageId, `${title} ${section.headingPath} ${passage.context}`, passage.text);
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private removeFile(path: string): void {
    this.db.exec("BEGIN");
    try {
      this.deleteFileRows(path);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteFileRows(path: string): void {
    const passageIds = this.db
      .prepare("SELECT p.id FROM passages p JOIN sections s ON s.id = p.section_id WHERE s.path = ?")
      .all(path) as { id: number }[];
    const deleteFts = this.db.prepare("DELETE FROM passages_fts WHERE rowid = ?");
    for (const { id } of passageIds) {
      deleteFts.run(id);
    }
    this.db.prepare("DELETE FROM passages WHERE section_id IN (SELECT id FROM sections WHERE path = ?)").run(path);
    this.db.prepare("DELETE FROM sections WHERE path = ?").run(path);
  }

  private async embedMissing(embedder: Embedder): Promise<void> {
    // One vector per passage (small-to-big, as for keywords): a one-sentence fact keeps its own vector
    // instead of being averaged into the 800 characters around it.
    const rows = (
      this.db
        .prepare(
          "SELECT p.vhash AS hash, s.heading AS heading, p.text AS text FROM passages p JOIN sections s ON s.id = p.section_id WHERE p.vhash != '' GROUP BY p.vhash",
        )
        .all() as { hash: string; heading: string; text: string }[]
    ).map((row) => ({ hash: row.hash, text: embedText(row.heading, row.text) }));
    const live = new Set(rows.map((row) => row.hash));
    for (const hash of this.vectors.keys()) {
      if (!live.has(hash)) {
        this.vectors.delete(hash);
      }
    }

    const missing = rows.filter((row) => !this.vectors.has(row.hash));
    const deadline = performance.now() + EMBED_TIME_BUDGET_MS;
    for (let i = 0; i < missing.length && performance.now() < deadline; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      try {
        const vectors = await embedder.embed(batch.map((row) => row.text));
        batch.forEach((row, j) => this.vectors.set(row.hash, vectors[j]));
      } catch {
        // Keyword search still works. Remaining sections are retried on the next search.
        logOnce("Embedding failed; search is using keywords only for now.");
        return;
      }
    }
  }

  // Ranks sections by their best passage's similarity to the query, and remembers that passage so the snippet
  // can show it: a passage found by meaning has no matched words for the snippet to pick it by.
  private async vectorSearch(
    query: string,
  ): Promise<{ sections: number[]; best: Map<number, number>; scores: Map<number, number> }> {
    const none = { sections: [], best: new Map<number, number>(), scores: new Map<number, number>() };
    if (!this.embedder || this.vectors.size === 0) {
      return none;
    }
    let queryVector: Float32Array;
    try {
      [queryVector] = await this.embedder.embed([query]);
    } catch {
      logOnce("Embedding failed; search is using keywords only for now.");
      return none;
    }

    const rows = this.db.prepare("SELECT id, section_id AS section, vhash FROM passages WHERE vhash != ''").all() as {
      id: number;
      section: number;
      vhash: string;
    }[];
    const scored: { id: number; section: number; score: number }[] = [];
    for (const row of rows) {
      const vector = this.vectors.get(row.vhash);
      if (!vector) {
        continue;
      }
      const score = dot(queryVector, vector);
      if (score >= this.embedder.minSimilarity) {
        scored.push({ id: row.id, section: row.section, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const sections: number[] = [];
    const best = new Map<number, number>();
    const scores = new Map<number, number>();
    for (const entry of scored) {
      if (best.has(entry.section)) continue;
      best.set(entry.section, entry.id);
      scores.set(entry.section, entry.score);
      sections.push(entry.section);
      if (sections.length >= VECTOR_CANDIDATES) break;
    }
    return { sections, best, scores };
  }
}

// Builds the text shown for one section hit, sentence by sentence.
// - Units: a list item (with its indented lines, so a decision keeps its "Reason:"), a table row, a code
//   block, or one sentence of a paragraph.
// - Each unit scores the number of different query words in it (FTS5 marks them, word forms included).
// - Best hit: its best unit, then other matching units, then the unit right after the best one (answers
//   often follow the sentence that matches, "Cause: ... Fix: ..."), up to TOP_HIT_CHARS.
// - Other hits: their best matching units, up to SNIPPET_CHARS.
// - No matching unit (the heading matched, or a vector hit): the first units, skipping boilerplate.
// Units that are not next to each other are separated by "…", and "…" at the end means more text exists.
interface Unit {
  text: string;
  marked: string;
  passage: number;
  score: number;
}

const BOILERPLATE = /^Model: [^\n]{1,100}$/;

function unitsOf(passages: PassageRow[], marked: Map<number, string>, vectorBest?: number): Unit[] {
  const units: Unit[] = [];
  passages.forEach((passage, p) => {
    const source = marked.get(passage.id) ?? passage.text;
    const whole = /^\s*([-*+]|\d+[.)])\s|^\s*\||^\s*(```|~~~)/.test(passage.text);
    const pieces = whole ? [source] : source.split(/(?<=[.!?][\u0002]?)\s+(?=[A-Z0-9"'(\u0001])/);
    for (const piece of pieces) {
      const text = piece.replace(/[\u0001\u0002]/g, "").trim();
      if (!text) continue;
      const words = new Set((piece.match(/\u0001[^\u0002]*\u0002/g) ?? []).map((w) => w.toLowerCase()));
      // A unit with no matched word, in the passage found by meaning, still counts (below any word match).
      units.push({ text, marked: piece, passage: p, score: words.size || (passage.id === vectorBest ? 0.5 : 0) });
    }
  });
  return units;
}

function buildSnippet(passages: PassageRow[], marked: Map<number, string>, isTop: boolean, vectorBest?: number): string {
  const units = unitsOf(passages, marked, vectorBest);
  if (units.length === 0) {
    return "";
  }
  const cap = isTop ? TOP_HIT_CHARS : SNIPPET_CHARS;
  const byScore = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.score > 0)
    .sort((a, b) => b.unit.score - a.unit.score || a.index - b.index);

  let order: number[];
  if (byScore.length === 0) {
    order = units.map((_, i) => i).filter((i) => !BOILERPLATE.test(units[i].text));
  } else {
    // Each matching unit is followed by the next unit of the same paragraph: in prose the answer often comes
    // right after the sentence that matches ("We discussed X. Agreed: Y.").
    const withNext = (i: number) => (units[i + 1]?.passage === units[i].passage ? [i, i + 1, i + 2] : [i]);
    order = byScore.flatMap((e) => withNext(e.index));
    if (isTop) {
      order.push(byScore[0].index - 1);
    }
    order = order.filter((i) => i >= 0 && i < units.length);
  }

  const chosen = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (chosen.has(i) || BOILERPLATE.test(units[i].text)) continue;
    const length = units[i].text.length + 1;
    if (chosen.size > 0 && used + length > cap) continue;
    chosen.add(i);
    used += length;
  }
  if (chosen.size === 0) {
    chosen.add(order[0] ?? 0);
  }

  const sorted = [...chosen].sort((a, b) => a - b);
  let out = sorted[0] > 0 ? "… " : "";
  sorted.forEach((i, k) => {
    const unit = units[i];
    if (k > 0) {
      const previous = sorted[k - 1];
      out += i !== previous + 1 ? "\n…\n" : unit.passage === units[previous].passage ? " " : "\n";
    }
    out += unit.text.length > cap ? clipAround(unit.marked, cap) : unit.text;
  });
  if (sorted.at(-1)! < units.length - 1) {
    out += " …";
  }
  return out;
}

// Builds the text shown for one hit from a whole chunk. Lines (list items with their continuation lines)
// that contain a matched word are kept, in order, up to cap characters. Kept for callers that work on
// whole chunks; search itself uses buildSnippet.
export function makeSnippet(text: string, marked: string | undefined, cap: number): string {
  if (text.length <= cap) {
    return text;
  }

  const units = logicalLines(marked ?? text);
  const matched = units.filter((unit) => unit.includes("\u0001"));
  const chosen = matched.length > 0 ? matched : units;

  const parts: string[] = [];
  let used = 0;
  for (const unit of chosen) {
    const plain = unit.replace(/[\u0001\u0002]/g, "");
    if (used + plain.length > cap) {
      if (parts.length === 0) {
        parts.push(clipAround(unit, cap));
      }
      break;
    }
    parts.push(plain);
    used += plain.length + 1;
  }

  const shown = parts.join("\n");
  return shown.length < text.length ? `${shown}\n…` : shown;
}

// Splits text into list items (a "- " or "1. " line plus the indented lines under it) and other lines.
function logicalLines(text: string): string[] {
  const units: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const continuation = /^\s+\S/.test(line) && !/^\s*([-*+]|\d+\.)\s/.test(line);
    if (continuation && units.length > 0) {
      units[units.length - 1] += `\n${line}`;
    } else {
      units.push(line);
    }
  }
  return units;
}

function clipAround(unit: string, cap: number): string {
  const first = Math.max(0, unit.indexOf("\u0001"));
  const plain = unit.replace(/[\u0001\u0002]/g, "");
  const start = Math.max(0, Math.min(first - Math.floor(cap / 3), plain.length - cap));
  const clipped = plain.slice(start, start + cap);
  return `${start > 0 ? "…" : ""}${clipped}${start + cap < plain.length ? "…" : ""}`;
}

// Reciprocal rank fusion: a section scores 1/(60 + rank) in each list it appears in. Sections found by both
// keyword and vector search rise to the top without having to compare BM25 scores with cosine scores.
// The text embedded for one passage: its section heading gives it context ("Super Bowl 50", a chapter title).
function embedText(heading: string, text: string): string {
  return heading ? `${heading}\n${text}` : text;
}

function fuse(lists: number[][]): number[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const logged = new Set<string>();
function logOnce(message: string): void {
  if (!logged.has(message)) {
    logged.add(message);
    console.error(message);
  }
}

const indexes = new Map<string, MemoryIndex>();

// One shared index per vault and indexing policy, reused by every MCP session with that policy. Everything that
// changes what goes into the index is part of the key: a session that masks email addresses must never be served
// text indexed by a session that does not. Indexes live as long as the process; there is one per distinct policy.
export function getMemoryIndex(config: MemoryConfig): MemoryIndex {
  const embedding = config.embeddings ?? { provider: "none" as const };
  const key = JSON.stringify([
    config.rootDir,
    embedding,
    config.maskEmails !== false,
    config.maskPhones !== false,
    config.maxNotes ?? 20_000,
  ]);
  let index = indexes.get(key);
  if (!index) {
    index = new MemoryIndex(config, config.embeddings ? createEmbedder(config.embeddings) : undefined);
    indexes.set(key, index);
  }
  return index;
}
