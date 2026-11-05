# Privacy Policy

## Data The Server Can Access

The server can access markdown files under the configured `AI_MEMORY_DIR`. Current tools can:

- Read the five main memory files.
- Read a specific relative `.md` file.
- Search markdown files and return matching snippets.
- Replace `04_MODEL_HANDOFF.md`.
- Append session notes under `Sessions/`.
- Append decisions and open tasks to controlled memory files.

The server should not be pointed at an entire private Obsidian vault unless you intentionally want connected MCP clients to access those markdown files.

## Data Logged

Current server error logs include operational error messages such as failed request handling. They should not include note bodies or secrets.

Planned privacy controls include content logging switches, email masking, phone-number masking, and snippet length limits. Until those controls are implemented, avoid adding verbose request logging.

## Data That Must Never Be Committed

Never commit:

- Real Obsidian notes or private memory.
- `.env` files.
- Secrets, API keys, bearer tokens, or MCP auth tokens.
- Public tunnel URLs.
- Logs containing user prompts, note content, or operational details.
- Emails, phone numbers, addresses, or other personal identifiers.
- Private filesystem paths.

## GitHub Sample-Vault-Only Policy

Public repository data must use fake demo notes only. The only memory vault content intended for GitHub is under:

```text
examples/sample-vault/
```

All files there must be fictional, non-sensitive, and safe to show in screenshots, tests, documentation, and demos.
