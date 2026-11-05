# secure-obsidian-memory-mcp

Secure local MCP gateway for connecting AI assistants to persistent Obsidian-based memory through one stable local endpoint.

Connect all your AI assistants to your personal knowledge through one secure local gateway.

## What It Does

This project runs a local TypeScript MCP server that exposes selected markdown memory files to MCP-capable assistants such as Claude, ChatGPT, Gemini, Codex, and local Ollama agents. It is designed for local-first personal memory: your notes stay on your machine, and the server only reads or writes files under `AI_MEMORY_DIR`.

Default MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

The server uses Express 5 and MCP Streamable HTTP.

## Local-First Design

- The server binds to `127.0.0.1` by default.
- Memory is stored as markdown files under `AI_MEMORY_DIR`.
- No OpenAI, Anthropic, Google, or other model API key is required by this server.
- The repository must only contain fake demo memory under `examples/sample-vault/`.
- Real Obsidian vaults and private memory directories must stay outside Git.

## Available Tools

- `read_main_context`: read the five main memory files.
- `read_handoff_summary`: read `04_MODEL_HANDOFF.md`.
- `search_memory`: search markdown files under `AI_MEMORY_DIR`.
- `read_note`: read one relative `.md` note under `AI_MEMORY_DIR`.
- `update_handoff_summary`: replace `04_MODEL_HANDOFF.md`.
- `append_session_note`: append a timestamped session note under `Sessions/`.
- `add_decision`: append a dated decision to `02_DECISIONS.md`.
- `add_open_task`: append a dated task to `03_OPEN_TASKS.md`.

There is intentionally no delete tool.

## Security Model

Current protections include:

- Markdown-only note access.
- Relative paths only; absolute paths and `../` traversal are rejected.
- Realpath checks keep resolved files inside `AI_MEMORY_DIR`.
- Symlinked directories and notes are rejected or skipped.
- Writes are limited to controlled memory files and generated session notes.
- Host-header guard for local and explicitly allowed hosts.
- Origin guard: requests from web pages are refused unless their origin is in `ALLOWED_ORIGINS` (empty by default).
- Zod validation on tool inputs.
- Request error logs avoid note content.

These protections are attacked by 27 adversarial tests, including a prompt injection test with a real agent. Results, including the known gaps, are in [SECURITY_TESTS.md](SECURITY_TESTS.md).

Authentication and audit logging are planned, but not implemented yet. Do not expose this server to untrusted networks without an authenticated reverse proxy or tunnel access control.

## Privacy Warning

Anything reachable under `AI_MEMORY_DIR` can potentially be read by connected MCP clients through search/read tools. Anything sent to an AI assistant may also be processed by that assistant provider according to its own product settings and policies.

Never commit real notes, private memory, secrets, tokens, tunnel URLs, emails, phone numbers, or private filesystem paths. GitHub demo data must live only under `examples/sample-vault/`.

## Quickstart

Install dependencies:

```bash
npm install
```

Run against the fake sample vault:

```bash
cp .env.example .env
export AI_MEMORY_DIR="$PWD/examples/sample-vault"
npm run build
npm start
```

Connect an MCP client to:

```text
http://127.0.0.1:8787/mcp
```

Run tests:

```bash
npm test
```

## Configuration

Copy `.env.example` to `.env` and adjust local values. Keep `.env` out of Git.

Key variables:

- `PORT`: local server port.
- `HOST`: bind address; keep `127.0.0.1` unless you know why you need more.
- `AI_MEMORY_DIR`: markdown memory directory.
- `ALLOWED_HOSTS`: comma-separated additional Host header values.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the server. Leave empty unless a browser-based client needs access.
- `AI_MEMORY_WRITE_ENABLED`: planned write gate.
- `LOG_CONTENT`, `MASK_EMAILS`, `MASK_PHONE_NUMBERS`, `MAX_SNIPPET_CHARS`: planned logging/privacy controls.
- `MCP_AUTH_REQUIRED`, `MCP_READ_TOKEN`, `MCP_WRITE_TOKEN`: planned authentication controls.

Some variables are documented ahead of implementation so safe deployment expectations are visible early.

## Safe Public Tunnel Warning

Public tunnels such as ngrok, Cloudflare Tunnel, Tailscale Funnel, or similar tools can make this local MCP server reachable from the internet. A tunnel URL is effectively a remote access path to your memory server.

Until server-side authentication is implemented, public tunneling requires authentication at the tunnel or reverse-proxy layer. Use provider access controls, short-lived tunnels, and least-privilege test data. Stop the tunnel when finished.
