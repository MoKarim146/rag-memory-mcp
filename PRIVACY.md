# Privacy Policy

## Data The Server Can Access

The server can access markdown files under the configured `AI_MEMORY_DIR`. Current tools can:

- Read the five main memory files.
- Read a specific relative `.md` file.
- Search markdown files and return the best-matching sections.
- Replace `04_MODEL_HANDOFF.md`.
- Append session notes under `Sessions/`.
- Append decisions and open tasks to controlled memory files.

The server should not be pointed at an entire private Obsidian vault unless you intentionally want connected MCP clients to access those markdown files.

## Data Logged

Current server error logs include operational error messages such as failed request handling. They should not include note bodies or secrets.

The server does not log note text or search queries. Unexpected errors are logged by error code only.

Secret-looking strings (API keys, tokens, passwords, private keys) are replaced with `[secret removed]` in
everything the AI reads. This is pattern-based and does not catch every secret. Email and phone-number masking
are not implemented. The search index is kept in memory and never written to disk. With `RAG_EMBEDDINGS=ollama`,
cleaned note text is sent to the Ollama server on the same computer, and only to a loopback address.

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
