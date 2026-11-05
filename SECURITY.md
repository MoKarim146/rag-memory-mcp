# Security Policy

## Supported Security Model

`rag-memory-mcp` is intended to run as a local-first MCP gateway on a trusted user machine. The supported default deployment is:

- Bind to `127.0.0.1`.
- Use a dedicated `AI_MEMORY_DIR`.
- Store only markdown memory files in that directory.
- Connect only trusted MCP clients.
- Use fake data from `examples/sample-vault/` for public demos and tests.

Built-in token login exists but is off by default (`MCP_AUTH_REQUIRED=false`), so on a default setup any program on the computer can call every tool. Public exposure is only supported with token login on (`MCP_AUTH_REQUIRED=true` and a long random `MCP_WRITE_TOKEN` and/or `MCP_READ_TOKEN`) or behind a separate authenticated reverse proxy or tunnel access-control layer.

## Reporting Security Issues

Do not open a public GitHub issue for suspected vulnerabilities involving private data exposure, authentication bypasses, path traversal, unsafe writes, or secret leakage.

Use a private reporting channel configured in the GitHub repository security settings. If that is not available yet, contact the repository owner through a private channel and include:

- A concise description of the issue.
- Impact and affected configuration.
- Reproduction steps using fake data only.
- Suggested fix, if known.

Do not include real vault contents, secrets, tokens, private tunnel URLs, emails, phone numbers, or private filesystem paths.

## Known Risks

- Token login is off by default. Turn it on before using a tunnel.
- Public tunnels can expose the MCP endpoint to anyone who can reach the URL unless the tunnel is protected.
- Connected AI assistants may send note content to their provider.
- Search/read tools can expose any markdown file under `AI_MEMORY_DIR`.
- Write tools can persist unwanted content if an untrusted client is connected. Use `AI_MEMORY_WRITE_ENABLED=false` or a read token where writes are not needed.
- Notes are cleaned (hidden comments, invisible characters and secret-looking strings removed) before an AI reads them, but this is pattern-based and cannot stop every prompt injection. See SECURITY_REPORT.md for what is still open.
- Host-header checks are helpful but are not authentication.

## Safe Configuration Checklist

- Keep `HOST=127.0.0.1` for local use.
- Leave `ALLOWED_ORIGINS` empty unless a browser-based client really needs access. Requests from web pages are refused by default.
- Point `AI_MEMORY_DIR` at a dedicated memory directory, not an entire private vault.
- Use `examples/sample-vault/` for demos, screenshots, tests, and GitHub examples.
- Keep `.env` out of Git.
- Do not commit real Obsidian notes or private memory.
- Do not commit tokens, tunnel URLs, logs, or local config files.
- Keep public tunnels disabled unless protected by authentication.
- If tunneling is required, turn on token login (`MCP_AUTH_REQUIRED=true`) or enforce authentication before traffic reaches `/mcp`.
- Stop tunnels immediately after use.

## Public Tunnel Warning

Public tunneling requires authentication. A random-looking tunnel URL is not a sufficient security boundary. Treat an unauthenticated tunnel as public internet exposure of your local MCP gateway.
