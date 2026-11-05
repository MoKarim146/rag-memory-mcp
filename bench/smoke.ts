// A free benchmark check for CI: no downloads, a few seconds.
//
//   npm run bench:smoke              run, verify, compare with bench/smoke-expected.json
//   npm run bench:smoke -- --update  write bench/smoke-expected.json from this run (only after a deliberate change)
//
// It asks the 25 questions of test set 1 (bench/fixture-vault, bench/tasks.json) with keywords and as full
// questions, records every answer with the same run records as the full benchmarks (in a temporary folder),
// checks the run with bench/verify.ts, and compares the deterministic quality numbers with the committed
// snapshot. Timings are recorded but never compared: they vary between machines.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, runQueries, type Query } from "./books.js";
import { RunWriter } from "./lib/runs.js";
import { verifyRun } from "./verify.js";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = path.join(BENCH, "smoke-expected.json");

interface Lookup {
  id: string;
  keyword: string;
  question: string;
  answer: string | null;
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const tasks = JSON.parse(await readFile(path.join(BENCH, "tasks.json"), "utf8")) as { lookups: Lookup[] };
  const lookups = tasks.lookups.filter((l) => l.answer !== null);
  const queries = (style: "keyword" | "question"): Query[] =>
    lookups.map((l) => ({ id: l.id, query: l[style], answers: [l.answer as string], tags: {} }));

  const base = await mkdtemp(path.join(os.tmpdir(), "bench-smoke-"));
  try {
    const vault = path.join(base, "vault");
    await cp(path.join(BENCH, "fixture-vault"), vault, { recursive: true });
    const groups = (["keyword", "question"] as const).map((style) => ({ name: `set1/current/${style}`, queries: lookups.length, about: { style } }));
    const writer = await RunWriter.start(path.join(BENCH, ".."), path.join(base, "runs"), "smoke", {
      config: { about: "CI smoke check (bench/smoke.ts)", vault: "bench/fixture-vault", tasks: "bench/tasks.json", tokenizer: "o200k_base" },
      data: { vault: "bench/fixture-vault (fictional, in the repository)" },
      plan: groups,
    });
    const server = await connect("current", vault);
    for (const style of ["keyword", "question"] as const) {
      await runQueries(server, queries(style), undefined, `set1/current/${style}`, writer);
    }
    await server.close();
    const { summary } = await writer.finish();

    const problems = await verifyRun(writer.dir, true);
    if (problems.length) {
      console.log("The smoke run failed verification:");
      for (const p of problems) console.log(`  - ${p}`);
      process.exit(1);
    }
    if (update) {
      await writeFile(EXPECTED, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`Wrote ${path.relative(process.cwd(), EXPECTED)}`);
      return;
    }
    const expected = JSON.parse(await readFile(EXPECTED, "utf8")) as Record<string, unknown>;
    let failed = false;
    for (const group of Object.keys({ ...expected, ...summary })) {
      if (JSON.stringify(expected[group]) !== JSON.stringify(summary[group])) {
        failed = true;
        console.log(`differs from bench/smoke-expected.json: ${group}`);
        console.log(`  expected ${JSON.stringify(expected[group])}`);
        console.log(`  got      ${JSON.stringify(summary[group])}`);
      }
    }
    if (failed) process.exit(1);
    for (const [group, s] of Object.entries(summary as Record<string, { found: number; questions: number; tokensMean: number }>)) {
      console.log(`ok ${group}: ${s.found}/${s.questions} answers found, ${s.tokensMean} tokens per search`);
    }
    console.log("Smoke run verified and equal to bench/smoke-expected.json.");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
