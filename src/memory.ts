import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, lstat, mkdir, open, opendir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type EmbeddingSettings, parseEmbeddingSettings } from "./retrieval/embeddings.js";
import { findWriteProblem, isPrivateNote, looksLikeInjection, maskSecrets } from "./safety.js";

export const DEFAULT_MEMORY_DIR = "~/ObsidianVault/AI-Memory";

export const MAIN_MEMORY_FILES = [
  "00_MAIN_CONTEXT.md",
  "01_CURRENT_WORK.md",
  "02_DECISIONS.md",
  "03_OPEN_TASKS.md",
  "04_MODEL_HANDOFF.md",
] as const;

export type MainMemoryFile = (typeof MAIN_MEMORY_FILES)[number];

export const READ_TOOLS = ["read_main_context", "read_handoff_summary", "search_memory", "read_note"] as const;
export const WRITE_TOOLS = ["update_handoff_summary", "append_session_note", "add_decision", "add_open_task"] as const;
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

// "suspicious": writes that look like instructions to an AI are held for the owner to review (default).
// "all": every write is held for review. "off": nothing is held (writes are still labelled and screened).
export type WriteReview = "suspicious" | "all" | "off";

export interface MemoryConfig {
  rootDir: string;
  // Optional vector add-on for search. Undefined means keyword search only.
  embeddings?: EmbeddingSettings;
  // false: read-only mode, the write tools are not offered and every write is refused. Default true.
  writeEnabled?: boolean;
  // true: search results show each undated note's last-change date. Default false (costs tokens).
  showDates?: boolean;
  writeReview?: WriteReview;
  // Tools to offer. Undefined means all of them (minus the write tools in read-only mode).
  tools?: string[];
  maskEmails?: boolean; // default true
  maskPhones?: boolean; // default true (phone and card numbers)
  maxNotes?: number; // most notes the search index takes in; default 20,000
  maxCallsPerMinute?: number; // per MCP session; default 120
  maxWritesPer10Minutes?: number; // per MCP session; default 20
  auditLog?: boolean; // record every write in .history/audit.jsonl; default true
  sessionId?: string; // set per MCP session, only used in the audit log
}

export interface WriteResult extends MemoryFile {
  held: boolean; // true: not saved, waiting in AI Review/pending.md for the owner
  masked: number; // secret-looking strings replaced before saving
}

// An error whose message is safe to show to the AI: it never contains a file system path.
export class MemoryError extends Error {}

export interface NoteFileInfo {
  path: string; // relative to AI_MEMORY_DIR, with forward slashes
  size: number;
  mtimeMs: number;
}

export interface MemoryFile {
  path: string;
  content: string;
}

const SESSION_DIR = "Sessions";
const HISTORY_DIR = ".history";
// Writes held for review go here. Obsidian shows it to the owner; no tool can read, search or list it.
export const REVIEW_DIR = "AI Review";
export const REVIEW_FILE = `${REVIEW_DIR}/pending.md`;
const AUDIT_FILE = "audit.jsonl";
const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FOLDER_DEPTH = 32;
const MAX_INDEXED_TOTAL_BYTES = 200 * 1024 * 1024;
// Notes larger than this are not indexed for search (read_note can still read them).
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
// Appends are refused once a note would grow past this size. It stops a looping AI from filling the disk.
export const MAX_APPEND_FILE_BYTES = 2 * 1024 * 1024;
// The handoff history keeps every replaced handoff. Updates stop when it reaches this size.
export const MAX_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
// Size limits for tool input, in characters.
export const FIELD_LIMITS = {
  model_name: 100,
  title: 200,
  priority: 20,
  project: 100,
  task: 1000,
  decision: 1000,
  reason: 2000,
  content: 20_000,
} as const;
// Added to entries written through the tools, so people and later AIs can tell them from human notes.
export const AI_MARK = "(added by AI via MCP)";

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function getMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const embeddings = parseEmbeddingSettings(env);
  const review = (env.AI_MEMORY_WRITE_REVIEW ?? "suspicious").trim().toLowerCase();
  if (review !== "suspicious" && review !== "all" && review !== "off") {
    throw new Error("AI_MEMORY_WRITE_REVIEW must be suspicious, all or off");
  }
  let tools: string[] | undefined;
  if (env.AI_MEMORY_TOOLS?.trim()) {
    tools = env.AI_MEMORY_TOOLS.split(",").map((name) => name.trim()).filter(Boolean);
    const unknown = tools.filter((name) => !ALL_TOOLS.includes(name));
    if (unknown.length > 0) {
      throw new Error(`AI_MEMORY_TOOLS has unknown tool names: ${unknown.join(", ")}. Known: ${ALL_TOOLS.join(", ")}`);
    }
  }
  return {
    rootDir: path.resolve(expandHome(env.AI_MEMORY_DIR || DEFAULT_MEMORY_DIR)),
    embeddings: embeddings.provider === "none" ? undefined : embeddings,
    writeEnabled: parseBoolean(env, "AI_MEMORY_WRITE_ENABLED", true),
    showDates: parseBoolean(env, "RAG_SHOW_DATES", false),
    writeReview: review,
    tools,
    maskEmails: parseBoolean(env, "MASK_EMAILS", true),
    maskPhones: parseBoolean(env, "MASK_PHONE_NUMBERS", true),
    maxNotes: parsePositiveInt(env, "RAG_MAX_NOTES", 20_000),
    maxCallsPerMinute: parsePositiveInt(env, "MCP_MAX_CALLS_PER_MINUTE", 120),
    maxWritesPer10Minutes: parsePositiveInt(env, "MCP_MAX_WRITES_PER_10_MIN", 20),
    auditLog: parseBoolean(env, "AI_MEMORY_AUDIT_LOG", true),
  };
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a whole number above 0`);
  }
  return parsed;
}

export async function ensureMemoryLayout(config: MemoryConfig): Promise<void> {
  await mkdir(config.rootDir, { recursive: true });
  await assertDirectory(config.rootDir, "AI_MEMORY_DIR");

  const sessionsDir = path.join(config.rootDir, SESSION_DIR);
  await mkdir(sessionsDir, { recursive: true });
  await assertDirectory(sessionsDir, "Sessions");

  for (const file of MAIN_MEMORY_FILES) {
    const target = path.join(config.rootDir, file);
    await ensureMarkdownFile(target, defaultFileContent(file));
  }
}

export async function readMainContext(config: MemoryConfig): Promise<MemoryFile[]> {
  await ensureMemoryLayout(config);
  return Promise.all(
    MAIN_MEMORY_FILES.map(async (file) => ({
      path: file,
      content: await readSafeFile(config, file),
    })),
  );
}

export async function readHandoffSummary(config: MemoryConfig): Promise<MemoryFile> {
  await ensureMemoryLayout(config);
  return {
    path: "04_MODEL_HANDOFF.md",
    content: await readSafeFile(config, "04_MODEL_HANDOFF.md"),
  };
}

export async function readNote(config: MemoryConfig, notePath: string): Promise<MemoryFile> {
  await ensureMemoryLayout(config);
  return {
    path: normalizeRelativeMarkdownPath(notePath),
    content: await readSafeFile(config, notePath),
  };
}

// A short fingerprint of a note's text. read_handoff_summary shows it; update_handoff_summary can require it, so a
// write based on an old read is refused instead of silently replacing a newer handoff.
export function contentVersion(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex").slice(0, 12);
}

export async function updateHandoffSummary(
  config: MemoryConfig,
  content: string,
  now = new Date(),
  expectedVersion?: string,
): Promise<WriteResult> {
  return guardedWrite(config, "update_handoff_summary", "04_MODEL_HANDOFF.md", { content }, now, async (fields) => {
    const target = await resolveWritableFixedFile(config, "04_MODEL_HANDOFF.md");
    const entry = normalizeTrailingNewline(fields.content);
    return {
      entry,
      // Runs under the file's lock (guardedWrite), so the version check, the history record and the replacement
      // happen as one step: no other write can slip in between and be lost.
      apply: async () => {
        const previous = await readFile(target, "utf8");
        const current = contentVersion(previous);
        if (expectedVersion !== undefined && expectedVersion !== current) {
          throw new MemoryError(
            `Not saved: the handoff changed since it was read (read ${expectedVersion}, now ${current}). Read it again with read_handoff_summary, keep what still matters, and retry.`,
          );
        }
        // Keep the old handoff before replacing it, in .history/, which no tool can read or write. This also keeps
        // edits made outside the server (for example in Obsidian).
        if (previous.trim()) {
          const history = await resolveHistoryFile(config, "04_MODEL_HANDOFF.md");
          const record = `\n## Replaced at ${now.toISOString()}\n\n${normalizeTrailingNewline(previous)}`;
          await assertRoomToAppend(history, record, MAX_HISTORY_FILE_BYTES, "The handoff history");
          await appendFile(history, record, "utf8");
        }
        await replaceFileAtomically(target, entry);
        return readFile(target, "utf8");
      },
    };
  });
}

export async function appendSessionNote(
  config: MemoryConfig,
  modelName: string,
  title: string,
  content: string,
  now = new Date(),
): Promise<WriteResult> {
  const fields = { model_name: modelName, title, content };
  const relativePath = `${SESSION_DIR}/${formatLocalDate(now)}_${slugify(String(modelName ?? ""))}.md`;
  return guardedWrite(config, "append_session_note", relativePath, fields, now, async (safe) => {
    const target = await resolveWritableGeneratedMarkdownFile(config, relativePath);
    const entry = [
      "",
      `## ${now.toISOString()} - ${safe.title.trim()}`,
      "",
      `Model: ${safe.model_name.trim()}`,
      "",
      normalizeTrailingNewline(safe.content).trimEnd(),
      "",
    ].join("\n");
    return {
      entry,
      apply: async () => {
        await assertRoomToAppend(target, entry, MAX_APPEND_FILE_BYTES, relativePath);
        await appendFile(target, entry, "utf8");
        return readFile(target, "utf8");
      },
    };
  });
}

export async function addDecision(
  config: MemoryConfig,
  decision: string,
  reason: string,
  now = new Date(),
): Promise<WriteResult> {
  return guardedWrite(config, "add_decision", "02_DECISIONS.md", { decision, reason }, now, async (safe) => {
    const target = await resolveWritableFixedFile(config, "02_DECISIONS.md");
    const entry = [
      "",
      `## ${formatLocalDate(now)}`,
      "",
      `- Decision: ${safe.decision.trim()} ${AI_MARK}`,
      `  Reason: ${safe.reason.trim()}`,
      "",
    ].join("\n");
    return {
      entry,
      apply: async () => {
        await assertRoomToAppend(target, entry, MAX_APPEND_FILE_BYTES, "02_DECISIONS.md");
        await appendFile(target, entry, "utf8");
        return readFile(target, "utf8");
      },
    };
  });
}

export async function addOpenTask(
  config: MemoryConfig,
  task: string,
  priority: string,
  project: string | undefined,
  now = new Date(),
): Promise<WriteResult> {
  const fields: Record<string, string> = { task, priority };
  if (project !== undefined) {
    fields.project = project;
  }
  return guardedWrite(config, "add_open_task", "03_OPEN_TASKS.md", fields, now, async (safe) => {
    const target = await resolveWritableFixedFile(config, "03_OPEN_TASKS.md");
    const projectPrefix = safe.project?.trim() ? ` (${safe.project.trim()})` : "";
    const entry = `- [ ] ${formatLocalDate(now)} [${safe.priority.trim()}]${projectPrefix} ${safe.task.trim()} ${AI_MARK}\n`;
    return {
      entry,
      apply: async () => {
        await assertRoomToAppend(target, entry, MAX_APPEND_FILE_BYTES, "03_OPEN_TASKS.md");
        await appendFile(target, entry, "utf8");
        return readFile(target, "utf8");
      },
    };
  });
}

// Every write goes through here (OWASP LLM01 control 9: memory writes are privileged operations):
//   1. field checks: non-empty, size limits, no line breaks in one-line fields;
//   2. refuse text the owner could not see in Obsidian (hidden comments, invisible characters, hidden HTML)
//      and active content (remote images, embedded pages, scripts, javascript: links);
//   3. replace secret-looking strings, so credentials never reach the shared notes on disk;
//   4. hold instruction-like writes (or every write, with AI_MEMORY_WRITE_REVIEW=all) in AI Review/pending.md
//      for the owner instead of saving them;
//   5. record the outcome in the audit log.
async function guardedWrite<F extends Record<string, string>>(
  config: MemoryConfig,
  tool: string,
  target: string,
  fields: F,
  now: Date,
  prepare: (safe: F) => Promise<{ entry: string; apply: () => Promise<string> }>,
): Promise<WriteResult> {
  try {
    assertWritable(config);
    await ensureMemoryLayout(config);
    for (const [name, value] of Object.entries(fields)) {
      if (name === "content") {
        assertMultiLineInput("content", value);
      } else {
        assertSingleLineInput(name as keyof typeof FIELD_LIMITS, value);
      }
      const problem = findWriteProblem(value);
      if (problem) {
        const why =
          problem.kind === "hidden"
            ? "Hidden text is not allowed: the owner would not see it in Obsidian."
            : "Remote images, embedded pages, scripts and javascript: links are not allowed in memory notes.";
        throw new MemoryError(`Not saved: ${name} ${problem.message}. ${why}`);
      }
    }

    let masked = 0;
    const safe = Object.fromEntries(
      Object.entries(fields).map(([name, value]) => {
        const result = maskSecrets(value);
        masked += result.count;
        return [name, result.text];
      }),
    ) as F;

    const { entry, apply } = await prepare(safe);
    const review = config.writeReview ?? "suspicious";
    const instructionLike = looksLikeInjection(Object.values(safe).join("\n"));
    if (review === "all" || (review === "suspicious" && instructionLike)) {
      const reason = instructionLike ? "it looks like instructions to an AI" : "every write needs the owner's approval";
      await withFileLock(config, REVIEW_FILE, () => holdForReview(config, tool, target, entry, reason, now));
      await audit(config, { tool, target, outcome: "held", entry, now });
      return { path: REVIEW_FILE, content: "", held: true, masked };
    }

    const content = await withFileLock(config, target, apply);
    await audit(config, { tool, target, outcome: "saved", entry, now });
    return { path: target, content, held: false, masked };
  } catch (error) {
    await audit(config, { tool, target, outcome: "refused", entry: "", now }).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Serialised, atomic writes
//
// Every write to a note runs inside withFileLock:
// - in this process, writes to the same file run one after another (a promise chain per file);
// - across processes (two servers on one vault), a lock file in .history/locks/ is created with exclusive create
//   (O_EXCL). A lock older than LOCK_STALE_MS is taken to be left by a crashed process and removed. Exclusive
//   create is reliable on local disks; on network or synced folders (Dropbox, iCloud, SMB) it may not be.
// A replaced file is written to a temporary file next to it and renamed over it, so a reader (Obsidian, another
// process) sees either the old or the new text, never half of it.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const localLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(config: MemoryConfig, relativePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(config.rootDir, relativePath);
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = previous.then(() => gate);
  localLocks.set(key, mine);
  await previous;
  try {
    return await withProcessLock(config, relativePath, fn);
  } finally {
    release();
    if (localLocks.get(key) === mine) {
      localLocks.delete(key);
    }
  }
}

async function withProcessLock<T>(config: MemoryConfig, relativePath: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.join(config.rootDir, HISTORY_DIR, "locks");
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, `${relativePath.replace(/[\\/]/g, "__")}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new MemoryError("Not saved: another process is writing this note. Try again in a moment.");
      }
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

async function replaceFileAtomically(target: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function holdForReview(
  config: MemoryConfig,
  tool: string,
  target: string,
  entry: string,
  reason: string,
  now: Date,
): Promise<void> {
  const dir = path.join(config.rootDir, REVIEW_DIR);
  await mkdir(dir, { recursive: true });
  await assertDirectory(dir, REVIEW_DIR);
  const file = path.join(config.rootDir, REVIEW_FILE);
  await assertInsideRoot(config.rootDir, file);
  try {
    await assertRegularFile(file);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  // A code fence longer than any run of backticks in the entry, so the entry is shown exactly as written.
  const fence = "`".repeat(Math.max(3, ...[...entry.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const record = [
    "",
    `## ${now.toISOString()} - ${tool} for ${target}`,
    "",
    `Held because ${reason}. If it is right, copy it into ${target} yourself; otherwise delete this section.`,
    "",
    `${fence}text`,
    entry.trim(),
    fence,
    "",
  ].join("\n");
  await assertRoomToAppend(file, record, MAX_APPEND_FILE_BYTES, REVIEW_FILE);
  await appendFile(file, record, "utf8");
}

// One JSON line per write attempt: when, which session, which tool, which file, the outcome, and the
// size and SHA-256 hash of what was (or would have been) written. Never the text itself. Lives in .history/,
// which no tool can read. Rotates to audit.1.jsonl at 5 MB.
async function audit(
  config: MemoryConfig,
  record: { tool: string; target: string; outcome: "saved" | "held" | "refused"; entry: string; now: Date },
): Promise<void> {
  if (config.auditLog === false) {
    return;
  }
  try {
    const dir = path.join(config.rootDir, HISTORY_DIR);
    await mkdir(dir, { recursive: true });
    await assertDirectory(dir, HISTORY_DIR);
    const file = path.join(dir, AUDIT_FILE);
    await assertInsideRoot(config.rootDir, file);
    try {
      await assertRegularFile(file);
      if ((await stat(file)).size > MAX_AUDIT_FILE_BYTES) {
        await rename(file, path.join(dir, "audit.1.jsonl"));
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    const line = JSON.stringify({
      time: record.now.toISOString(),
      session: config.sessionId ?? null,
      tool: record.tool,
      target: record.target,
      outcome: record.outcome,
      bytes: Buffer.byteLength(record.entry, "utf8"),
      sha256: record.entry ? createHash("sha256").update(record.entry).digest("hex") : null,
    });
    await appendFile(file, `${line}\n`, "utf8");
  } catch {
    // A read-only or full disk must not stop the server. The write itself has its own error handling.
    console.error("Audit log could not be written");
  }
}

// Notes too large to search (over MAX_INDEXED_FILE_BYTES). read_note can still open them page by page; they
// are named so the AI can ask the user to split them. A note marked private in its first 64 KB is left out,
// so its name is never shown.
export async function listOversizedNotes(config: MemoryConfig): Promise<string[]> {
  const out: string[] = [];
  for (const file of await listMarkdownFiles(config)) {
    if (file.size <= MAX_INDEXED_FILE_BYTES) continue;
    const handle = await open(path.join(config.rootDir, file.path), "r");
    try {
      const head = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (!isPrivateNote(head.subarray(0, bytesRead).toString("utf8"))) out.push(file.path);
    } finally {
      await handle.close();
    }
  }
  return out;
}

// Every note search may look at: the same markdown files read_note accepts, with the same checks.
export async function listNoteFiles(config: MemoryConfig): Promise<NoteFileInfo[]> {
  await ensureMemoryLayout(config);
  const all = await listMarkdownFiles(config);
  for (const file of all) {
    if (file.size > MAX_INDEXED_FILE_BYTES) {
      warnOnce(`Not searched, over 1 MB: ${file.path}. Split it into smaller notes.`);
    }
  }
  const files = all.filter((file) => file.size <= MAX_INDEXED_FILE_BYTES);
  // Caps against a vault so large it would exhaust memory (OWASP LLM06): at most maxNotes notes and
  // MAX_INDEXED_TOTAL_BYTES of text, taken in path order so the result is the same every time.
  const limit = config.maxNotes ?? 20_000;
  const kept: NoteFileInfo[] = [];
  let bytes = 0;
  for (const file of files) {
    if (kept.length >= limit || bytes + file.size > MAX_INDEXED_TOTAL_BYTES) {
      warnOnce(`Search covers only the first ${kept.length} notes (RAG_MAX_NOTES or the 200 MB cap was reached).`);
      break;
    }
    kept.push(file);
    bytes += file.size;
  }
  return kept;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (!warned.has(message)) {
    warned.add(message);
    console.error(message);
  }
}

// Reads one note's raw text through the same path checks as read_note.
export async function readNoteText(config: MemoryConfig, relativePath: string): Promise<string> {
  return readSafeFile(config, relativePath);
}

async function readSafeFile(config: MemoryConfig, relativePath: string): Promise<string> {
  const target = await resolveReadableFile(config, relativePath);
  return readFile(target, "utf8");
}

async function resolveReadableFile(config: MemoryConfig, relativePath: string): Promise<string> {
  const safePath = normalizeRelativeMarkdownPath(relativePath);
  const target = path.resolve(config.rootDir, safePath);
  await assertInsideRoot(config.rootDir, target);
  await assertRegularFile(target);
  return target;
}

async function resolveWritableFixedFile(config: MemoryConfig, file: MainMemoryFile): Promise<string> {
  const target = path.resolve(config.rootDir, file);
  await assertInsideRoot(config.rootDir, target);
  await assertRegularFile(target);
  return target;
}

async function resolveHistoryFile(config: MemoryConfig, file: MainMemoryFile): Promise<string> {
  const dir = path.join(config.rootDir, HISTORY_DIR);
  await mkdir(dir, { recursive: true });
  await assertDirectory(dir, HISTORY_DIR);
  const target = path.join(dir, file);
  await assertInsideRoot(config.rootDir, target);
  try {
    await assertRegularFile(target);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  return target;
}

async function assertRoomToAppend(target: string, entry: string, limit: number, label: string): Promise<void> {
  let size = 0;
  try {
    size = (await stat(target)).size;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  if (size + Buffer.byteLength(entry, "utf8") > limit) {
    throw new MemoryError(
      `${label} has reached its size limit (${Math.round(limit / 1024 / 1024)} MB). Ask the user to archive it.`,
    );
  }
}

function assertWritable(config: MemoryConfig): void {
  if (config.writeEnabled === false) {
    throw new MemoryError("This memory is read-only (AI_MEMORY_WRITE_ENABLED=false).");
  }
}

async function resolveWritableGeneratedMarkdownFile(config: MemoryConfig, relativePath: string): Promise<string> {
  const safePath = normalizeRelativeMarkdownPath(relativePath);
  if (!safePath.startsWith(`${SESSION_DIR}/`)) {
    throw new MemoryError("Generated markdown writes are only allowed under Sessions/");
  }

  const target = path.resolve(config.rootDir, safePath);
  await assertInsideRoot(config.rootDir, target);
  await assertDirectory(path.dirname(target), SESSION_DIR);

  try {
    await access(target, fsConstants.F_OK);
    await assertRegularFile(target);
  } catch (error) {
    if (isNotFoundError(error)) {
      return target;
    }
    throw error;
  }

  return target;
}

function normalizeRelativeMarkdownPath(input: string): string {
  assertTextInput("path", input);

  if (input.includes("\0")) {
    throw new MemoryError("Path contains an invalid null byte");
  }

  const normalizedSlashes = input.trim().replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedSlashes) || path.isAbsolute(normalizedSlashes)) {
    throw new MemoryError("Absolute paths are not allowed");
  }

  const normalized = path.posix.normalize(normalizedSlashes);
  const segments = normalized.split("/");
  if (normalized === "." || segments.includes("..")) {
    throw new MemoryError("Path traversal is not allowed");
  }

  // Hidden folders and files (.trash with Obsidian's deleted notes, .obsidian, .git, .history) are off limits.
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new MemoryError("Hidden folders and files are not available");
  }

  // Writes held for review are for the owner only.
  if (segments[0].toLowerCase() === REVIEW_DIR.toLowerCase()) {
    throw new MemoryError(`The ${REVIEW_DIR} folder is for the owner only`);
  }

  if (!normalized.endsWith(".md")) {
    throw new MemoryError("Only markdown notes ending in .md are allowed");
  }

  return normalized;
}

async function assertInsideRoot(rootDir: string, target: string): Promise<void> {
  const rootReal = await realpath(rootDir);
  const parentReal = await realpath(path.dirname(target));
  const relativeParent = path.relative(rootReal, parentReal);

  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new MemoryError("Resolved path escapes AI_MEMORY_DIR");
  }

  try {
    await access(target, fsConstants.F_OK);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  const targetReal = await realpath(target);
  const relativeTarget = path.relative(rootReal, targetReal);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new MemoryError("Resolved path escapes AI_MEMORY_DIR");
  }
}

async function assertDirectory(target: string, label: string): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new MemoryError(`${label} must not be a symlink`);
  }

  if (!stat.isDirectory()) {
    throw new MemoryError(`${label} must be a directory`);
  }
}

async function assertRegularFile(target: string): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new MemoryError("Refusing to read or write symlinked notes");
  }

  if (!stat.isFile()) {
    throw new MemoryError("Path is not a regular file");
  }
}

async function ensureMarkdownFile(target: string, defaultContent: string): Promise<void> {
  try {
    await access(target, fsConstants.F_OK);
    await assertRegularFile(target);
  } catch (error) {
    if (isNotFoundError(error)) {
      await writeFile(target, defaultContent, { encoding: "utf8", flag: "wx" });
      return;
    }
    throw error;
  }
}

async function listMarkdownFiles(config: MemoryConfig): Promise<NoteFileInfo[]> {
  const rootReal = await realpath(config.rootDir);
  const results: NoteFileInfo[] = [];

  async function walk(currentDir: string, depth = 0): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH) {
      return; // very deep folders are not walked (OWASP LLM06)
    }
    // Notes can be created, renamed or deleted while the vault is being walked (the owner is editing in
    // Obsidian). Anything that disappears halfway is skipped instead of failing the whole search.
    let currentReal: string;
    let dir: Awaited<ReturnType<typeof opendir>>;
    try {
      currentReal = await realpath(currentDir);
      dir = await opendir(currentDir);
    } catch (error) {
      if (isNotFoundError(error) || isNotDirectoryError(error)) return;
      throw error;
    }
    const relativeCurrent = path.relative(rootReal, currentReal);
    if (relativeCurrent.startsWith("..") || path.isAbsolute(relativeCurrent)) {
      await dir.close().catch(() => undefined);
      return;
    }

    for await (const entry of dir) {
      if (entry.name.startsWith(".")) {
        continue; // same rule as read_note: hidden folders and files are never listed
      }
      if (depth === 0 && entry.name.toLowerCase() === REVIEW_DIR.toLowerCase()) {
        continue; // writes held for review are for the owner only
      }
      const absolute = path.join(currentDir, entry.name);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }

      if (stat.isFile() && entry.name.endsWith(".md")) {
        const relative = path.relative(config.rootDir, absolute).split(path.sep).join("/");
        results.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }

  await walk(config.rootDir);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function defaultFileContent(file: MainMemoryFile): string {
  const title = file.replace(/^\d+_/, "").replace(/\.md$/, "").replace(/_/g, " ");
  return `# ${title}\n\n`;
}

function assertTextInput(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryError(`${name} must be a non-empty string`);
  }
}

function assertLength(name: keyof typeof FIELD_LIMITS, value: string): void {
  if (value.length > FIELD_LIMITS[name]) {
    throw new MemoryError(`${name} is too long (${value.length} characters, limit ${FIELD_LIMITS[name]})`);
  }
}

// One-line fields must not contain line breaks or other control characters, so they cannot add fake
// lines, entries or headings to the shared notes.
function assertSingleLineInput(name: keyof typeof FIELD_LIMITS, value: string): void {
  assertTextInput(name, value);
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(value)) {
    throw new MemoryError(`${name} must be a single line of text, without line breaks or control characters`);
  }
  assertLength(name, value);
}

function assertMultiLineInput(name: "content", value: string): void {
  assertTextInput(name, value);
  assertLength(name, value);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new MemoryError(`${name} must not contain control characters`);
  }
}

function normalizeTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "model";
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNotDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTDIR";
}
