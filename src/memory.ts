import { constants as fsConstants } from "node:fs";
import { access, appendFile, lstat, mkdir, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
}

export interface MemoryFile {
  path: string;
  content: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
}

const SESSION_DIR = "Sessions";
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_SNIPPET_LENGTH = 220;

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
  return {
    rootDir: path.resolve(expandHome(env.AI_MEMORY_DIR || DEFAULT_MEMORY_DIR)),
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

export async function updateHandoffSummary(config: MemoryConfig, content: string): Promise<MemoryFile> {
  await ensureMemoryLayout(config);
  assertTextInput("content", content);
  const target = await resolveWritableFixedFile(config, "04_MODEL_HANDOFF.md");
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
  await ensureMemoryLayout(config);
  assertTextInput("model_name", modelName);
  assertTextInput("title", title);
  assertTextInput("content", content);

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
  await ensureMemoryLayout(config);
  assertTextInput("decision", decision);
  assertTextInput("reason", reason);

  const target = await resolveWritableFixedFile(config, "02_DECISIONS.md");
  const entry = [
    "",
    `## ${formatLocalDate(now)}`,
    "",
    `- Decision: ${decision.trim()}`,
    `  Reason: ${reason.trim()}`,
    "",
  ].join("\n");

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
  await ensureMemoryLayout(config);
  assertTextInput("task", task);
  assertTextInput("priority", priority);

  const safeProject = project?.trim();
  const projectPrefix = safeProject ? ` (${safeProject})` : "";
  const target = await resolveWritableFixedFile(config, "03_OPEN_TASKS.md");
  const entry = `- [ ] ${formatLocalDate(now)} [${priority.trim()}]${projectPrefix} ${task.trim()}\n`;

  await appendFile(target, entry, "utf8");
  return {
    path: "03_OPEN_TASKS.md",
    content: await readFile(target, "utf8"),
  };
}

export async function searchMemory(config: MemoryConfig, query: string): Promise<SearchResult> {
  await ensureMemoryLayout(config);
  assertTextInput("query", query);

  const needle = query.trim().toLowerCase();
  const files = await listMarkdownFiles(config);
  const matches: SearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= MAX_SEARCH_RESULTS) {
      break;
    }

    const target = await resolveReadableFile(config, file);
    const stat = await lstat(target);
    if (stat.size > MAX_SEARCH_FILE_BYTES) {
      continue;
    }

    const text = await readFile(target, "utf8");
    const lines = text.split(/\r?\n/);

    for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_RESULTS; index += 1) {
      const line = lines[index];
      if (line.toLowerCase().includes(needle)) {
        matches.push({
          path: file,
          line: index + 1,
          snippet: makeSnippet(line, needle),
        });
      }
    }
  }

  return { query: query.trim(), matches };
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

async function resolveWritableGeneratedMarkdownFile(config: MemoryConfig, relativePath: string): Promise<string> {
  const safePath = normalizeRelativeMarkdownPath(relativePath);
  if (!safePath.startsWith(`${SESSION_DIR}/`)) {
    throw new Error("Generated markdown writes are only allowed under Sessions/");
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
    throw new Error("Path contains an invalid null byte");
  }

  const normalizedSlashes = input.trim().replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedSlashes) || path.isAbsolute(normalizedSlashes)) {
    throw new Error("Absolute paths are not allowed");
  }

  const normalized = path.posix.normalize(normalizedSlashes);
  const segments = normalized.split("/");
  if (normalized === "." || segments.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }

  if (!normalized.endsWith(".md")) {
    throw new Error("Only markdown notes ending in .md are allowed");
  }

  return normalized;
}

async function assertInsideRoot(rootDir: string, target: string): Promise<void> {
  const rootReal = await realpath(rootDir);
  const parentReal = await realpath(path.dirname(target));
  const relativeParent = path.relative(rootReal, parentReal);

  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error("Resolved path escapes AI_MEMORY_DIR");
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
    throw new Error("Resolved path escapes AI_MEMORY_DIR");
  }
}

async function assertDirectory(target: string, label: string): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
}

async function assertRegularFile(target: string): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new Error("Refusing to read or write symlinked notes");
  }

  if (!stat.isFile()) {
    throw new Error("Path is not a regular file");
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

async function listMarkdownFiles(config: MemoryConfig): Promise<string[]> {
  const rootReal = await realpath(config.rootDir);
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const currentReal = await realpath(currentDir);
    const relativeCurrent = path.relative(rootReal, currentReal);
    if (relativeCurrent.startsWith("..") || path.isAbsolute(relativeCurrent)) {
      return;
    }

    const dir = await opendir(currentDir);
    for await (const entry of dir) {
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
        results.push(relative);
      }
    }
  }

  await walk(config.rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

function defaultFileContent(file: MainMemoryFile): string {
  const title = file.replace(/^\d+_/, "").replace(/\.md$/, "").replace(/_/g, " ");
  return `# ${title}\n\n`;
}

function assertTextInput(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
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

function makeSnippet(line: string, needle: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_SNIPPET_LENGTH) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  const index = lower.indexOf(needle);
  const start = Math.max(0, index - 80);
  const end = Math.min(trimmed.length, start + MAX_SNIPPET_LENGTH);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < trimmed.length ? "..." : "";
  return `${prefix}${trimmed.slice(start, end)}${suffix}`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
