# Frozen baseline

`memory.ts` and `mcpServer.ts` are byte-for-byte copies of `src/` from the original project,
[secure-obsidian-memory-mcp](https://github.com/MoKarim146/secure-obsidian-memory-mcp) at commit `7aaf3f4`, the
code before the RAG and security work. In this repository that same code is the first commit (`chore: import
the original project unchanged`). The benchmark imports these copies so the "before" numbers can be measured
again at any time. They are not used by the server.

Check that they still match the first commit:

```bash
first=$(git rev-list --max-parents=0 HEAD)
diff <(git show $first:src/memory.ts) bench/baseline/memory.ts && diff <(git show $first:src/mcpServer.ts) bench/baseline/mcpServer.ts && echo identical
```
