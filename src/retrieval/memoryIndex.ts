// The search index: SQLite FTS5 keyword search over note chunks, with optional vectors on top.
//
// - The index lives in memory only (an in-memory SQLite database). Nothing is written to disk.
// - It is built the first time someone searches, and brought up to date before every search: notes whose
//   size or modification time changed are re-read, deleted notes are dropped. There is no file watcher
//   and no background job.
// - It only sees the notes that read_note is allowed to read, because it lists and reads them through the
//   same functions in memory.ts.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { listNoteFiles, readNoteText, type MemoryConfig } from "../memory.js";
import { prepareNoteText } from "../safety.js";
import { chunkMarkdown, MAX_CHUNK_CHARS } from "./chunker.js";
import { createEmbedder, dot, type Embedder } from "./embeddings.js";

export const DEFAULT_RESULT_LIMIT = 5;
export const MAX_RESULT_LIMIT = 10;
export const MAX_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 16;
const MAX_HITS_PER_FILE = 2;
const CANDIDATES = 50;
const RRF_K = 60;
const EMBED_BATCH = 16;
const EMBED_TIME_BUDGET_MS = 10_000;

export interface SearchHit {
  path: string;
  heading: string;
  text: string; // the whole chunk
  snippet: string; // what search_memory shows: the matching lines of the chunk
  ordinal: number;
  suspicious: boolean; // the note contains instruction-like text somewhere
}

// Search output size. The best hit shows its whole section (up to MAX_CHUNK_CHARS); the others show only
// the lines that match the query, up to SNIPPET_CHARS each. read_note gives the full note when needed.
export const TOP_HIT_CHARS = MAX_CHUNK_CHARS;
export const SNIPPET_CHARS = 300;

interface ChunkRow {
  id: number;
  path: string;
  ordinal: number;
  heading: string;
  text: string;
  hash: string;
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
  private readonly vectors = new Map<string, Float32Array>(); // keyed by chunk text hash
  private pending: Promise<void> | undefined;

  constructor(
    private readonly config: MemoryConfig,
    private readonly embedder?: Embedder,
  ) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL, suspicious INTEGER NOT NULL);
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX chunks_by_path ON chunks(path);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(title, body, tokenize = 'porter unicode61 remove_diacritics 2');
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

  async search(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<SearchHit[]> {
    await this.refresh();

    const terms = queryTerms(query);
    const marked = new Map<number, string>(); // chunk id -> body with matched words wrapped in \u0001 \u0002
    let keywordIds: number[] = [];
    if (terms.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT rowid AS id, highlight(chunks_fts, 1, char(1), char(2)) AS marked FROM chunks_fts
           WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 2.0, 1.0) LIMIT ${CANDIDATES}`,
        )
        .all(terms.map((term) => `"${term}"`).join(" OR ")) as { id: number; marked: string }[];
      for (const row of rows) {
        marked.set(row.id, row.marked);
      }
      keywordIds = this.filterByTermCoverage(
        rows.map((row) => row.id),
        terms,
      );
    }

    const vectorIds = this.embedder ? await this.vectorSearch(query) : [];
    const ranked = vectorIds.length > 0 ? fuse([keywordIds, vectorIds]) : keywordIds;

    const getChunk = this.db.prepare(
      "SELECT c.id, c.path, c.ordinal, c.heading, c.text, c.hash, f.suspicious FROM chunks c JOIN files f ON f.path = c.path WHERE c.id = ?",
    );
    const perFile = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const id of ranked) {
      const row = getChunk.get(id) as (ChunkRow & { suspicious: number }) | undefined;
      if (!row) {
        continue;
      }
      const count = perFile.get(row.path) ?? 0;
      if (count >= MAX_HITS_PER_FILE) {
        continue;
      }
      perFile.set(row.path, count + 1);
      const cap = hits.length === 0 ? TOP_HIT_CHARS : SNIPPET_CHARS;
      hits.push({
        path: row.path,
        heading: row.heading,
        text: row.text,
        snippet: makeSnippet(row.text, marked.get(id), cap),
        ordinal: row.ordinal,
        suspicious: row.suspicious === 1,
      });
      if (hits.length >= limit) {
        break;
      }
    }
    return hits;
  }

  private filterByTermCoverage(ids: number[], terms: string[]): number[] {
    const needed = minimumTermsMatched(terms.length);
    if (needed <= 1 || ids.length === 0) {
      return ids;
    }
    const matchedTerms = new Map<number, number>();
    const idList = ids.join(","); // integers from the database, safe to inline
    for (const term of terms) {
      const rows = this.db
        .prepare(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${idList})`)
        .all(`"${term}"`) as { id: number }[];
      for (const row of rows) {
        matchedTerms.set(row.id, (matchedTerms.get(row.id) ?? 0) + 1);
      }
    }
    return ids.filter((id) => (matchedTerms.get(id) ?? 0) >= needed);
  }

  stats(): { files: number; chunks: number; vectors: number } {
    const files = (this.db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
    const chunks = (this.db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
    return { files, chunks, vectors: this.vectors.size };
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
    const prepared = prepareNoteText(raw);
    const chunks = chunkMarkdown(prepared.text);
    const title = `${path.replace(/\.md$/, "").replace(/[/_-]+/g, " ")}`;
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (path, ordinal, heading, text, hash) VALUES (?, ?, ?, ?, ?)",
    );
    const insertFts = this.db.prepare("INSERT INTO chunks_fts (rowid, title, body) VALUES (?, ?, ?)");

    this.db.exec("BEGIN");
    try {
      this.deleteChunks(path);
      this.db
        .prepare("INSERT OR REPLACE INTO files (path, mtime, size, suspicious) VALUES (?, ?, ?, ?)")
        .run(path, mtime, size, prepared.suspicious ? 1 : 0);
      for (const chunk of chunks) {
        const hash = createHash("sha256").update(chunk.text).digest("hex");
        const result = insertChunk.run(path, chunk.ordinal, chunk.heading, chunk.text, hash);
        insertFts.run(Number(result.lastInsertRowid), `${title} ${chunk.headingPath}`, chunk.text);
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
      this.deleteChunks(path);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteChunks(path: string): void {
    const ids = this.db.prepare("SELECT id FROM chunks WHERE path = ?").all(path) as { id: number }[];
    const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    for (const { id } of ids) {
      deleteFts.run(id);
    }
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
  }

  private async embedMissing(embedder: Embedder): Promise<void> {
    const rows = this.db.prepare("SELECT DISTINCT hash, text FROM chunks").all() as { hash: string; text: string }[];
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
        // Keyword search still works. Remaining chunks are retried on the next search.
        logOnce("Embedding failed; search is using keywords only for now.");
        return;
      }
    }
  }

  private async vectorSearch(query: string): Promise<number[]> {
    if (!this.embedder || this.vectors.size === 0) {
      return [];
    }
    let queryVector: Float32Array;
    try {
      [queryVector] = await this.embedder.embed([query]);
    } catch {
      logOnce("Embedding failed; search is using keywords only for now.");
      return [];
    }

    const rows = this.db.prepare("SELECT id, hash FROM chunks").all() as { id: number; hash: string }[];
    const scored: { id: number; score: number }[] = [];
    for (const row of rows) {
      const vector = this.vectors.get(row.hash);
      if (!vector) {
        continue;
      }
      const score = dot(queryVector, vector);
      if (score >= this.embedder.minSimilarity) {
        scored.push({ id: row.id, score });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES)
      .map((entry) => entry.id);
  }
}

// Builds the text shown for one hit. Lines (list items with their continuation lines) that contain a
// matched word are kept, in order, up to cap characters. If no body line matched (the heading matched, or
// the hit came from vector search) the start of the section is shown. "…" marks text that was left out.
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

// Reciprocal rank fusion: a chunk scores 1/(60 + rank) in each list it appears in. Chunks found by both
// keyword and vector search rise to the top without having to compare BM25 scores with cosine scores.
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

// One shared index per vault and settings, reused by every MCP session.
export function getMemoryIndex(config: MemoryConfig): MemoryIndex {
  const embedding = config.embeddings ?? { provider: "none" as const };
  const key = JSON.stringify([config.rootDir, embedding]);
  let index = indexes.get(key);
  if (!index) {
    index = new MemoryIndex(config, config.embeddings ? createEmbedder(config.embeddings) : undefined);
    indexes.set(key, index);
  }
  return index;
}
