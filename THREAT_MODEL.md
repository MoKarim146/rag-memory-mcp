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

## Planned Mitigations

- Read/write token authentication.
- Optional write-disable mode.
- Audit logging without note-body disclosure.
- Configurable content logging safeguards.
- Email and phone-number masking for logs/snippets.
- Snippet length control through configuration.
- Stronger public tunnel deployment guidance.
- CI checks for sample-vault-only demo data.

## Residual Risks

- Connected assistants can still reveal content they are allowed to read.
- Authentication at a tunnel or proxy can be misconfigured.
- A user may point `AI_MEMORY_DIR` at overly broad private data.
- Stored prompt injection can influence assistant behavior.
- Local compromise of the host machine can bypass application-level controls.
