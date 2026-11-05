import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDecision,
  addOpenTask,
  appendSessionNote,
  type MemoryConfig,
  readHandoffSummary,
  readMainContext,
  readNote,
  searchMemory,
  updateHandoffSummary,
} from "./memory.js";

const serverInstructions =
  "Local-first Obsidian AI memory connector. Read from and write only to the configured AI_MEMORY_DIR. No delete tools exist. Use read_handoff_summary before changing handoff notes. Write tools modify markdown files and should be used only when the user asks to persist memory.";

export function createObsidianMemoryMcpServer(config: MemoryConfig): McpServer {
  const server = new McpServer(
    {
      name: "obsidian-memory-mcp",
      version: "0.1.0",
    },
    {
      instructions: serverInstructions,
    },
  );

  server.registerTool(
    "read_main_context",
    {
      title: "Read Main Context",
      description:
        "Read the main shared memory files and return the current project context from 00_MAIN_CONTEXT.md, 01_CURRENT_WORK.md, 02_DECISIONS.md, 03_OPEN_TASKS.md, and 04_MODEL_HANDOFF.md. Use this when starting work with the Obsidian Memory connector.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const files = await readMainContext(config);
      return textResult({
        files,
      });
    },
  );

  server.registerTool(
    "read_handoff_summary",
    {
      title: "Read Handoff Summary",
      description:
        "Read 04_MODEL_HANDOFF.md. Use this first when switching between Claude, ChatGPT, Gemini, or another model.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const file = await readHandoffSummary(config);
      return textResult(file);
    },
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search Memory",
      description:
        "Search markdown files inside AI_MEMORY_DIR and return matching relative file paths with line numbers and short snippets. Use this to find relevant memory notes without reading unrelated files.",
      inputSchema: {
        query: z.string().min(1).describe("Plain-text search query."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const result = await searchMemory(config, query);
      return textResult(result);
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read Note",
      description:
        "Read one markdown note inside AI_MEMORY_DIR. The path must be a relative .md path, for example Sessions/2026-05-30_ChatGPT.md. Absolute paths and ../ traversal are rejected.",
      inputSchema: {
        path: z.string().min(1).describe("Relative path to a markdown note under AI_MEMORY_DIR."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const file = await readNote(config, path);
      return textResult(file);
    },
  );

  server.registerTool(
    "update_handoff_summary",
    {
      title: "Update Handoff Summary",
      description:
        "Write tool: replace 04_MODEL_HANDOFF.md with the provided content. This is the main handoff note used when switching between Claude, ChatGPT, and Gemini. Use only when the user wants to persist a new handoff summary.",
      inputSchema: {
        content: z.string().min(1).describe("Full replacement markdown content for 04_MODEL_HANDOFF.md."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ content }) => {
      const file = await updateHandoffSummary(config, content);
      return textResult({
        path: file.path,
        bytes: Buffer.byteLength(file.content, "utf8"),
        message: "Updated handoff summary.",
      });
    },
  );

  server.registerTool(
    "append_session_note",
    {
      title: "Append Session Note",
      description:
        "Write tool: append a timestamped markdown session note under Sessions/YYYY-MM-DD_<model_name>.md. This does not overwrite existing notes.",
      inputSchema: {
        model_name: z.string().min(1).describe("Model or assistant name, used in the generated session filename."),
        title: z.string().min(1).describe("Short markdown section title for this session note."),
        content: z.string().min(1).describe("Markdown body to append to the session note."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ model_name, title, content }) => {
      const file = await appendSessionNote(config, model_name, title, content);
      return textResult({
        path: file.path,
        bytes: Buffer.byteLength(file.content, "utf8"),
        message: "Appended session note.",
      });
    },
  );

  server.registerTool(
    "add_decision",
    {
      title: "Add Decision",
      description:
        "Write tool: append a dated decision and reason to 02_DECISIONS.md. This does not overwrite existing decisions.",
      inputSchema: {
        decision: z.string().min(1).describe("Decision to record."),
        reason: z.string().min(1).describe("Reason or context for the decision."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ decision, reason }) => {
      const file = await addDecision(config, decision, reason);
      return textResult({
        path: file.path,
        bytes: Buffer.byteLength(file.content, "utf8"),
        message: "Appended decision.",
      });
    },
  );

  server.registerTool(
    "add_open_task",
    {
      title: "Add Open Task",
      description:
        "Write tool: append a dated task to 03_OPEN_TASKS.md. This does not overwrite existing tasks.",
      inputSchema: {
        task: z.string().min(1).describe("Task to add."),
        priority: z.string().min(1).describe("Priority label, for example high, medium, or low."),
        project: z.string().min(1).optional().describe("Optional project label."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ task, priority, project }) => {
      const file = await addOpenTask(config, task, priority, project);
      return textResult({
        path: file.path,
        bytes: Buffer.byteLength(file.content, "utf8"),
        message: "Appended open task.",
      });
    },
  );

  return server;
}

function textResult<T extends object>(data: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}
