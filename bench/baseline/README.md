# Frozen baseline

`memory.ts` and `mcpServer.ts` are byte-for-byte copies of `src/` on `main` at commit `7aaf3f4`, the code before
the RAG and security work. The benchmark imports them so the "before" numbers can be re-measured at any time.
They are not used by the server.

Check that they still match `main`:

```bash
diff <(git show 7aaf3f4:src/memory.ts) bench/baseline/memory.ts && diff <(git show 7aaf3f4:src/mcpServer.ts) bench/baseline/mcpServer.ts && echo identical
```
