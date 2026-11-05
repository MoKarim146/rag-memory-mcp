// Freezes the paraphrase split before any run: whole groups (a fact and all its questions) go to one side.
//   npx tsx bench/paraphrase/make-splits.ts      writes bench/paraphrase/splits.json (committed, not to be edited)
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seededShuffle } from "../books.js";
import { loadSet } from "./check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = 2027;
const ids = (await loadSet()).map((g) => g.id).sort();
const shuffled = seededShuffle(ids, SEED);
const out = {
  about: "Frozen before any run on the paraphrase set. Groups stay whole. Do not edit.",
  seed: SEED,
  method: "seeded shuffle of the sorted group ids; the first 8 groups are development, the other 16 evaluation",
  development: shuffled.slice(0, 8).sort(),
  evaluation: shuffled.slice(8).sort(),
};
await writeFile(path.join(HERE, "splits.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(out.development.join(" "), "|", out.evaluation.join(" "));
