# Threat Model

## Assets

- Private markdown memory under `AI_MEMORY_DIR`.
- Obsidian vault contents if a user points `AI_MEMORY_DIR` too broadly.
- MCP client sessions and requests.
- Local environment variables and future MCP auth tokens.
- Public reputation of the GitHub project.

## Trust Boundaries

- Local machine boundary: the server is intended to listen on loopback by default.
- MCP boundary: connected assistants can request reads and writes through registered tools.
- Filesystem boundary: all note access must remain under `AI_MEMORY_DIR`.
- Tunnel boundary: public tunnel providers can expose local services externally.
- Git boundary: only fake sample data is safe to publish.

## Threat Actors

- Untrusted MCP clients or compromised assistants.
- Anyone who obtains an unprotected public tunnel URL.
- Local malware or another local user account.
- Accidental user misconfiguration.
- Contributors who unintentionally commit private data.

## Main Threats

- Reading private notes outside the intended memory directory.
- Path traversal or symlink escape from `AI_MEMORY_DIR`.
- Unauthorized writes to memory files.
- Public tunnel exposure without authentication.
- Sensitive data leakage through logs, snippets, screenshots, or Git commits.
- Prompt injection in stored notes causing an assistant to misuse tools.

## Mitigations Already Implemented

- No delete tool.
- Markdown-only path policy.
- Absolute paths and `../` traversal are rejected.
- Realpath checks validate paths remain inside `AI_MEMORY_DIR`.
- Symlinked notes and directories are rejected or skipped.
- Writes are limited to controlled files and generated session notes.
- Express disables `x-powered-by`.
- JSON body size is limited.
- Host-header guard restricts unexpected hostnames.
- Zod validation is used for tool inputs.
- Error logs avoid note content.

## Mitigations Added In rag-memory-mcp

- Optional read/write token login (`MCP_AUTH_REQUIRED`), off by default.
- Read-only mode (`AI_MEMORY_WRITE_ENABLED=false`).
- Hidden comments, invisible characters and secret-looking strings removed from everything the AI reads, the
  search index and anything sent to an embedding server.
- Instruction-like text flagged with a warning; AI-written entries labelled.
- Input size limits, one-line fields without line breaks, a 2 MB cap per appended file, handoff history.
- Hidden folders (such as `.trash`) off limits; error messages without file system paths.
- Search index kept in memory only; embedding server must be on the same computer.

- OWASP Top 10 for LLM Applications 2026 controls: instruction-like writes held for owner review, hidden
  HTML and remote images removed, email/phone/card masking, private notes, tool allowlist, per-session rate
  limits and loop breaker, session caps and timeouts, write audit log, SBOM and CI.

Details and test results: SECURITY_REPORT.md.

## Still Planned

- CI checks for sample-vault-only demo data.
- A semantic check for politely worded instructions (today the check is pattern-based).

## Residual Risks

- Connected assistants can still reveal content they are allowed to read.
- Authentication at a tunnel or proxy can be misconfigured.
- A user may point `AI_MEMORY_DIR` at overly broad private data.
- Stored prompt injection can influence assistant behavior. Warnings and labels help, but do not prevent it.
- A note crafted to match many searches can still reach search results (capped at 2 per search).
- Local compromise of the host machine can bypass application-level controls.
