import { constants as fsConstants } from "node:fs";
import { access, appendFile, lstat, mkdir, opendir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type EmbeddingSettings, parseEmbeddingSettings } from "./retrieval/embeddings.js";

export const DEFAULT_MEMORY_DIR = "~/ObsidianVault/AI-Memory";

export const MAIN_MEMORY_FILES = [
  "00_MAIN_CONTEXT.md",
  "01_CURRENT_WORK.md",
  "02_DECISIONS.md",
  "03_OPEN_TASKS.md",
  "04_MODEL_HANDOFF.md",
] as const;

export type MainMemoryFile = (typeof MAIN_MEMORY_FILES)[number];

export interface MemoryConfig {
  rootDir: string;
  // Optional vector add-on for search. Undefined means keyword search only.
  embeddings?: EmbeddingSettings;
  // false: read-only mode, the write tools are not offered and every write is refused. Default true.
  writeEnabled?: boolean;
  // true: search results show each undated note's last-change date. Default false (costs tokens).
  showDates?: boolean;
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
  const writes = (env.AI_MEMORY_WRITE_ENABLED ?? "true").trim().toLowerCase();
  if (writes !== "true" && writes !== "false") {
    throw new Error("AI_MEMORY_WRITE_ENABLED must be true or false");
  }
  return {
    rootDir: path.resolve(expandHome(env.AI_MEMORY_DIR || DEFAULT_MEMORY_DIR)),
    embeddings: embeddings.provider === "none" ? undefined : embeddings,
    writeEnabled: writes === "true",
    showDates: (env.RAG_SHOW_DATES ?? "false").trim().toLowerCase() === "true",
  };
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

export async function updateHandoffSummary(
  config: MemoryConfig,
  content: string,
  now = new Date(),
): Promise<MemoryFile> {
  assertWritable(config);
  await ensureMemoryLayout(config);
  assertMultiLineInput("content", content);
  const target = await resolveWritableFixedFile(config, "04_MODEL_HANDOFF.md");

  // Keep the old handoff before replacing it, in .history/, which no tool can read or write.
  const previous = await readFile(target, "utf8");
  if (previous.trim()) {
    const history = await resolveHistoryFile(config, "04_MODEL_HANDOFF.md");
    const entry = `\n## Replaced at ${now.toISOString()}\n\n${normalizeTrailingNewline(previous)}`;
    await assertRoomToAppend(history, entry, MAX_HISTORY_FILE_BYTES, "The handoff history");
    await appendFile(history, entry, "utf8");
  }

  await writeFile(target, normalizeTrailingNewline(content), "utf8");
  return {
    path: "04_MODEL_HANDOFF.md",
    content: await readFile(target, "utf8"),
  };
}

export async function appendSessionNote(
  config: MemoryConfig,
  modelName: string,
  title: string,
  content: string,
  now = new Date(),
): Promise<MemoryFile> {
  assertWritable(config);
  await ensureMemoryLayout(config);
  assertSingleLineInput("model_name", modelName);
  assertSingleLineInput("title", title);
  assertMultiLineInput("content", content);

  const modelSlug = slugify(modelName);
  const relativePath = `${SESSION_DIR}/${formatLocalDate(now)}_${modelSlug}.md`;
  const target = await resolveWritableGeneratedMarkdownFile(config, relativePath);
  const entry = [
    "",
    `## ${now.toISOString()} - ${title.trim()}`,
    "",
    `Model: ${modelName.trim()}`,
    "",
    normalizeTrailingNewline(content).trimEnd(),
    "",
  ].join("\n");

  await assertRoomToAppend(target, entry, MAX_APPEND_FILE_BYTES, relativePath);
  await appendFile(target, entry, "utf8");

  return {
    path: relativePath,
    content: await readFile(target, "utf8"),
  };
}

export async function addDecision(
  config: MemoryConfig,
  decision: string,
  reason: string,
  now = new Date(),
): Promise<MemoryFile> {
  assertWritable(config);
  await ensureMemoryLayout(config);
  assertSingleLineInput("decision", decision);
  assertSingleLineInput("reason", reason);

  const target = await resolveWritableFixedFile(config, "02_DECISIONS.md");
  const entry = [
    "",
    `## ${formatLocalDate(now)}`,
    "",
    `- Decision: ${decision.trim()} ${AI_MARK}`,
    `  Reason: ${reason.trim()}`,
    "",
  ].join("\n");

  await assertRoomToAppend(target, entry, MAX_APPEND_FILE_BYTES, "02_DECISIONS.md");
  await appendFile(target, entry, "utf8");
  return {
    path: "02_DECISIONS.md",
    content: await readFile(target, "utf8"),
  };
}

export async function addOpenTask(
  config: MemoryConfig,
  task: string,
  priority: string,
  project: string | undefined,
  now = new Date(),
): Promise<MemoryFile> {
  assertWritable(config);
  await ensureMemoryLayout(config);
  assertSingleLineInput("task", task);
  assertSingleLineInput("priority", priority);
  if (project !== undefined) {
    assertSingleLineInput("project", project);
  }

  const safeProject = project?.trim();
  const projectPrefix = safeProject ? ` (${safeProject})` : "";
  const target = await resolveWritableFixedFile(config, "03_OPEN_TASKS.md");
  const entry = `- [ ] ${formatLocalDate(now)} [${priority.trim()}]${projectPrefix} ${task.trim()} ${AI_MARK}\n`;

  await assertRoomToAppend(target, entry, MAX_APPEND_FILE_BYTES, "03_OPEN_TASKS.md");
  await appendFile(target, entry, "utf8");
  return {
    path: "03_OPEN_TASKS.md",
    content: await readFile(target, "utf8"),
  };
}

// Every note search may look at: the same markdown files read_note accepts, with the same checks.
export async function listNoteFiles(config: MemoryConfig): Promise<NoteFileInfo[]> {
  await ensureMemoryLayout(config);
  const files = await listMarkdownFiles(config);
  return files.filter((file) => file.size <= MAX_INDEXED_FILE_BYTES);
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

  async function walk(currentDir: string): Promise<void> {
    const currentReal = await realpath(currentDir);
    const relativeCurrent = path.relative(rootReal, currentReal);
    if (relativeCurrent.startsWith("..") || path.isAbsolute(relativeCurrent)) {
      return;
    }

    const dir = await opendir(currentDir);
    for await (const entry of dir) {
      if (entry.name.startsWith(".")) {
        continue; // same rule as read_note: hidden folders and files are never listed
      }
      const absolute = path.join(currentDir, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        await walk(absolute);
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
