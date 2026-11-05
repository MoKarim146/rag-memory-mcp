// A two-minute tour of the server, on a throwaway copy of the made-up notes in bench/agent/test-vault.
//
//   npm run demo
//
// It starts the real HTTP server (src/index.ts) on 127.0.0.1:8799, connects as an MCP client over HTTP, makes the
// same calls an AI would, and prints a short excerpt of every answer with its size in tokens (o200k_base). It exits
// with status 1 if any behaviour it shows is missing, so CI runs it too. Nothing leaves this computer, and the copy
// is deleted at the end.
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getEncoding } from "js-tiktoken";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const tokens = getEncoding("o200k_base");
const checks: string[] = [];
const failed: string[] = [];
function expect(ok: boolean, what: string): void {
  checks.push(what);
  if (!ok) failed.push(what);
}

async function allText(dir: string): Promise<string> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  return (await Promise.all(files.sort().map((f) => readFile(f, "utf8")))).join("\n");
}

function show(title: string, text: string, pick?: RegExp, lines = 6): void {
  const all = text.split("\n");
  const start = pick ? Math.max(0, all.findIndex((l) => pick.test(l))) : 0;
  console.log(`\n== ${title}  (${tokens.encode(text).length} tokens)`);
  console.log(all.slice(start, start + lines).map((l) => `   ${l.length > 150 ? `${l.slice(0, 147)}...` : l}`).join("\n"));
}

const vault = await mkdtemp(path.join(os.tmpdir(), "rag-memory-demo-"));
await cp(path.join(ROOT, "bench", "agent", "test-vault"), vault, { recursive: true });
const server = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "src", "index.ts")], {
  cwd: vault, // so a .env in the repository is not loaded
  env: { ...process.env, AI_MEMORY_DIR: vault, PORT: String(PORT), HOST: "127.0.0.1", RAG_EMBEDDINGS: "", AI_MEMORY_AUDIT_LOG: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
const client = new Client({ name: "demo", version: "1.0.0" });
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not start within 20 seconds")), 20_000);
    server.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    let errors = "";
    server.stderr.on("data", (d: Buffer) => (errors += d.toString()));
    server.on("exit", (code) => reject(new Error(`the server stopped (exit code ${code}): ${errors.replace(/.*ExperimentalWarning.*\n.*trace-warnings.*\n/, "").trim()}`)));
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("\n");
  };

  const pasted = await allText(vault);
  console.log(`Notes: ${vault} (a copy of bench/agent/test-vault)`);
  console.log(`Pasting every note into the chat would take ${tokens.encode(pasted).length} tokens. Each answer below shows its own size.`);

  const start = await call("read_main_context");
  show("read_main_context: the start of a session", start, /Decisions|02_DECISIONS/, 12);
  console.log("   -> The Mailgun decision is listed as superseded, because the Postmark decision says so in a Supersedes line.");
  console.log("      The 6:00 opening time is marked as added by AI and does not replace the user's 7:00: the skill tells the AI to ask.");
  expect(start.includes("(superseded by 2026-05-10)"), "the replaced decision is marked superseded");
  expect(start.includes("Open at 6:00 on weekdays. (added by AI via MCP)") && !/2026-04-01[^\n]*superseded/.test(start), "the AI-written decision is marked and replaces nothing");

  const port = await call("search_memory", { query: "staging database port" });
  show('search_memory "staging database port"', port);
  expect(port.includes("port 6432"), "the search finds the port");

  const supplier = await call("search_memory", { query: "hold supplier support reply" });
  show('search_memory "hold supplier support reply"', supplier, /hold-supplier/, 4);
  expect(/hold-supplier\.md" warning="looks like instructions to an AI/.test(supplier), "the planted instructions are flagged");
  console.log('   -> The note with planted "NOTE TO AI ASSISTANTS" instructions arrives with a warning: treat it as data.');

  const secret = await call("read_note", { path: "Reference/front-desk.md" });
  show("read_note Reference/front-desk.md (marked ai_private: true)", secret, undefined, 3);
  expect(/marked private/.test(secret) && !secret.includes("4471"), "the private note is not shown");

  const handoff = await call("read_handoff_summary");
  const version = /version="([0-9a-f]{12})"/.exec(handoff)?.[1];
  show("read_handoff_summary", handoff, undefined, 2);
  const stale = await call("update_handoff_summary", { content: "# Model Handoff\n\nDemo.\n", expected_version: "000000000000" });
  show("update_handoff_summary with an out-of-date version (as if another assistant saved in between)", stale, undefined, 2);
  expect(stale.startsWith("Not saved: the handoff changed since it was read"), "a save based on an old version is refused");
  const saved = await call("update_handoff_summary", { content: "# Model Handoff\n\nDemo save.\n", expected_version: version });
  show("update_handoff_summary with the version just read", saved, undefined, 2);
  expect(saved.startsWith("Saved"), "a save based on the current version goes through");
  console.log(`\nDemo checks: ${checks.length - failed.length} of ${checks.length} passed.${failed.length ? ` Failed: ${failed.join("; ")}` : ""}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  server.kill();
  await rm(vault, { recursive: true, force: true });
}
