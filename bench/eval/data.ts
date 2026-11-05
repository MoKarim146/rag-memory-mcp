// Outside retrieval datasets for bench/eval/run.ts: BEIR SciFact and LongMemEval-S (cleaned).
//
// Every file is pinned by URL (with a fixed revision where the host has one) and SHA-256, downloaded once into
// bench/.cache/eval/ (not committed) and checked before use.
//
// What is searchable and what is not: the notes written for the server hold only the documents (SciFact
// abstracts, LongMemEval chat sessions with their dates). Relevance labels, answers and LongMemEval's
// has_answer turn labels stay in the gold data, which the server never sees.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const EVAL_SOURCES = {
  scifactRelease: {
    url: "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz",
    sha256: "11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be",
    about: "SciFact original release: corpus.jsonl (5,183 abstracts) and claims_train/dev.jsonl (Wadden et al., 2020)",
    license: "Claims and annotations: CC BY 4.0; abstracts (from S2ORC): ODC-By 1.0 (allenai/scifact LICENSE.md)",
  },
  scifactQrelsTest: {
    url: "https://huggingface.co/datasets/BeIR/scifact-qrels/resolve/2938d17dc3b09882fdb8c12bbbe2e2dc0e75a029/test.tsv",
    sha256: "0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c",
    about: "BEIR SciFact test relevance labels (300 claims, 339 pairs), dataset revision 2938d17",
    license: "CC BY-SA 4.0 (BEIR dataset card)",
  },
  scifactQrelsTrain: {
    url: "https://huggingface.co/datasets/BeIR/scifact-qrels/resolve/2938d17dc3b09882fdb8c12bbbe2e2dc0e75a029/train.tsv",
    sha256: "a53f2114831916c096b6c37d9e54da68cef4efdcdbd5ed46533601af972acf1d",
    about: "BEIR SciFact train relevance labels (809 claims), dataset revision 2938d17. Development only",
    license: "CC BY-SA 4.0 (BEIR dataset card)",
  },
  longmemevalS: {
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json",
    sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
    about: "LongMemEval-S, cleaned September 2025 release (Wu et al., 2025): 500 questions, each with about 50 dated chat sessions. Dataset revision 98d7416",
    license: "MIT",
  },
} as const;
export type EvalSource = keyof typeof EVAL_SOURCES;

export async function fetchPinned(cacheDir: string, name: EvalSource): Promise<Buffer> {
  const source = EVAL_SOURCES[name];
  await mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${name}${path.extname(new URL(source.url).pathname) || ".bin"}`);
  let data: Buffer;
  if (existsSync(file)) {
    data = await readFile(file);
  } else {
    console.log(`downloading ${source.url}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
  }
  const sum = createHash("sha256").update(data).digest("hex");
  if (sum !== source.sha256) {
    throw new Error(`${path.basename(file)} has SHA-256 ${sum}, expected ${source.sha256}. Delete it to download again.`);
  }
  if (!existsSync(file)) await writeFile(file, data);
  return data;
}

// A small reader for .tar.gz (ustar), so the benchmark needs no extra package.
export function untarGz(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const name = (field(345, 155) ? `${field(345, 155)}/` : "") + field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if ((type === "0" || type === "") && !path.basename(name).startsWith("._")) {
      files.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------
// Common shape

export interface EvalDoc {
  id: string; // the dataset's own id, unchanged
  path: string; // the note written for the server
  text: string; // the note's full text
  date?: string; // the dataset's own timestamp, unchanged
}

export interface EvalQuery {
  id: string;
  text: string;
  relevant: Record<string, number>; // document id -> relevance grade (outside searchable content)
  answers?: string[]; // LongMemEval only
  evidenceTurns?: string[]; // LongMemEval has_answer turns (outside searchable content)
  date?: string;
  type?: string;
  abstention?: boolean;
}

// One note per document; ids are kept in the path so results map back to them exactly.
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

// ---------------------------------------------------------------------------------------------------------
// BEIR SciFact

export interface SciFact {
  docs: EvalDoc[];
  test: EvalQuery[]; // BEIR test split: the evaluation set
  train: EvalQuery[]; // BEIR train split: development only
}

function qrels(tsv: Buffer): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const line of tsv.toString("utf8").split(/\r?\n/).slice(1)) {
    const [query, doc, score] = line.split("\t");
    if (!query || !doc) continue;
    out.set(query, { ...(out.get(query) ?? {}), [doc]: Number(score) });
  }
  return out;
}

// BEIR's own SciFact files could not be downloaded here, so the corpus and claims come from the original
// release and the relevance labels from BEIR's pinned files. They match: for all 300 test claims, BEIR's
// relevant documents are exactly the claim's cited_doc_ids in claims_dev.jsonl. A document's text is its
// title as a heading and its abstract sentences joined by spaces, as in BEIR.
export function sciFact(release: Buffer, testQrels: Buffer, trainQrels: Buffer): SciFact {
  const files = untarGz(release);
  const jsonl = (name: string) =>
    files
      .get(`data/${name}`)!
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const docs: EvalDoc[] = jsonl("corpus.jsonl").map((d: { doc_id: number; title: string; abstract: string[] }) => ({
    id: String(d.doc_id),
    path: `abstracts/${safe(String(d.doc_id))}.md`,
    text: `# ${d.title.trim()}\n\n${d.abstract.map((s) => s.trim()).join(" ")}\n`,
  }));
  const claims = new Map<string, string>(
    [...jsonl("claims_train.jsonl"), ...jsonl("claims_dev.jsonl")].map((c: { id: number; claim: string }) => [String(c.id), c.claim]),
  );
  const toQueries = (labels: Map<string, Record<string, number>>) =>
    [...labels.entries()].map(([id, relevant]) => {
      const text = claims.get(id);
      if (text === undefined) throw new Error(`SciFact claim ${id} is in the relevance labels but not in the release`);
      return { id, text, relevant };
    });
  return { docs, test: toQueries(qrels(testQrels)), train: toQueries(qrels(trainQrels)) };
}

// ---------------------------------------------------------------------------------------------------------
// LongMemEval-S

interface LmeItem {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: string; content: string; has_answer?: boolean }[][];
}

export interface LongMemEvalItem {
  query: EvalQuery;
  docs: EvalDoc[]; // this question's own history: one note per session
}

// Each session becomes one note: its date as the heading, then one paragraph per turn. Session ids and dates are
// the dataset's own. The has_answer labels are left out of the note and kept as gold evidence.
export function longMemEvalS(json: Buffer): LongMemEvalItem[] {
  const items = JSON.parse(json.toString("utf8")) as LmeItem[];
  return items.map((item) => {
    const docs: EvalDoc[] = item.haystack_session_ids.map((sessionId, i) => {
      const date = item.haystack_dates[i];
      const turns = item.haystack_sessions[i].map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.trim()}`);
      return { id: sessionId, path: `sessions/${String(i + 1).padStart(3, "0")}_${safe(sessionId)}.md`, date, text: `# Chat on ${date}\n\n${turns.join("\n\n")}\n` };
    });
    const evidenceTurns = item.haystack_sessions.flatMap((s) => s.filter((t) => t.has_answer).map((t) => t.content.trim()));
    return {
      docs,
      query: {
        id: item.question_id,
        text: item.question,
        relevant: Object.fromEntries(item.answer_session_ids.map((id) => [id, 1])),
        answers: [String(item.answer)],
        evidenceTurns,
        date: item.question_date,
        type: item.question_type,
        abstention: item.question_id.endsWith("_abs"),
      },
    };
  });
}
