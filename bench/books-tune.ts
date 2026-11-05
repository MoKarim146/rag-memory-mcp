// Tuning set for the long-text benchmark. Search changes are tried here, never on the data bench/books.ts
// reports on:
// - 48 random articles of the SQuAD *training* set (none of them is in the development set) and 2,000 of their
//   questions;
// - 20 other made-up facts, planted in a different book (The Parent's Assistant).
//
//   npx tsx bench/books-tune.ts [system ...]     systems: current (default), current-ollama, current-ngram
//   npx tsx bench/books-tune.ts current current-ollama --label "passage vectors"
//
// Each run appends one line per system to bench/results/books-tune.txt, so every setting tried is on record.
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bookToChapterNotes, fetchSources, squadToNotes, unzip } from "./books-data.js";
import {
  connect,
  documentFrequency,
  needleQueries,
  plantNeedles,
  runQueries,
  seededShuffle,
  squadQueries,
  summarise,
  writeVault,
  warmUp,
  type Needle,
  type System,
} from "./books.js";

const BENCH = path.dirname(fileURLToPath(import.meta.url));

// Written for tuning only, after the reported facts, and different from them. Half keep a name from the fact,
// half share no word with it.
const TUNING_NEEDLES: Needle[] = [
  { id: "d01", fact: "The boiler in the Harrow Lane flat is serviced every October by a firm called Tidewell.", answer: "every October", keyword: "Harrow Lane boiler", question: "When does someone come to check the heating at our apartment?", overlap: "none" },
  { id: "d02", fact: "Agnes Petrov keeps the signed contracts in the grey filing cabinet in room 4.", answer: "grey filing cabinet", keyword: "Agnes Petrov contracts", question: "Where does Agnes Petrov store the agreements we signed?", overlap: "name" },
  { id: "d03", fact: "The bakery van leaves the depot at 5:15 every weekday morning.", answer: "5:15", keyword: "bakery van depot", question: "What time does the bread lorry set off from the yard?", overlap: "none" },
  { id: "d04", fact: "Professor Lionel Arkwright's office hours are Tuesdays from 2 to 4.", answer: "Tuesdays from 2 to 4", keyword: "Arkwright office hours", question: "When can students drop in to see Lionel Arkwright?", overlap: "name" },
  { id: "d05", fact: "The swimming pool at Westbrook Leisure Centre is closed for repairs until 9 May.", answer: "9 May", keyword: "Westbrook swimming pool", question: "When will the place to do laps at the gym reopen?", overlap: "none" },
  { id: "d06", fact: "Delphine Osei manages the charity's donations and sends receipts within 48 hours.", answer: "48 hours", keyword: "Delphine Osei receipts", question: "How fast does Delphine Osei confirm a gift?", overlap: "name" },
  { id: "d07", fact: "The company laptop must be returned to the IT desk on the last working day.", answer: "last working day", keyword: "company laptop returned", question: "When do leavers hand back their computer?", overlap: "none" },
  { id: "d08", fact: "Barnaby Clough's dog, a greyhound named Comet, needs a walk at noon.", answer: "noon", keyword: "Barnaby Clough greyhound", question: "At what time does Barnaby Clough's pet go out?", overlap: "name" },
  { id: "d09", fact: "The hotel shuttle to the airport runs every 40 minutes from the front entrance.", answer: "every 40 minutes", keyword: "hotel shuttle airport", question: "How often is there a bus to the planes from where we are staying?", overlap: "none" },
  { id: "d10", fact: "Our wedding venue, Larkspur Hall, allows a maximum of 120 guests.", answer: "120 guests", keyword: "Larkspur Hall guests", question: "How many people can come to the party at Larkspur Hall?", overlap: "name" },
  { id: "d11", fact: "The solar panels on the barn roof produce about 14 kilowatt hours on a sunny day.", answer: "14 kilowatt hours", keyword: "solar panels barn", question: "How much electricity do we generate from sunlight at the farm building?", overlap: "none" },
  { id: "d12", fact: "Cosima Lindqvist translates the Swedish manuals for a fee of 0.12 euros per word.", answer: "0.12 euros", keyword: "Cosima Lindqvist translates", question: "What does Cosima Lindqvist charge for her language work?", overlap: "name" },
  { id: "d13", fact: "The fish tank filter must be cleaned every second Sunday.", answer: "every second Sunday", keyword: "fish tank filter", question: "How often should the aquarium pump be washed?", overlap: "none" },
  { id: "d14", fact: "Tobias Reyes is the only person with the alarm code for the Clifton warehouse.", answer: "Tobias Reyes", keyword: "Clifton warehouse alarm code", question: "Who can switch off the security system at Clifton?", overlap: "name" },
  { id: "d15", fact: "The minibus seats fourteen passengers and needs a special licence to drive.", answer: "fourteen passengers", keyword: "minibus seats", question: "How many people fit in the small coach?", overlap: "none" },
  { id: "d16", fact: "Henrietta Vos will cover reception while Malik is on holiday in August.", answer: "Henrietta Vos", keyword: "cover reception holiday", question: "Who looks after the front desk when Malik is away?", overlap: "name" },
  { id: "d17", fact: "Fresh towels for the gym are delivered on Mondays and Thursdays.", answer: "Mondays and Thursdays", keyword: "fresh towels gym", question: "On which days does clean linen arrive at the fitness room?", overlap: "none" },
  { id: "d18", fact: "The Marlowe Street car park charges 2 pounds for the first hour.", answer: "2 pounds", keyword: "Marlowe Street car park", question: "How much is parking on Marlowe Street for a short stay?", overlap: "name" },
  { id: "d19", fact: "The vaccine fridge in the clinic is kept between 2 and 8 degrees.", answer: "between 2 and 8 degrees", keyword: "vaccine fridge clinic", question: "What temperature range must the cooler for jabs stay in?", overlap: "none" },
  { id: "d20", fact: "Ingrid Moss is allergic to cats, so the meeting moved to the library.", answer: "allergic to cats", keyword: "Ingrid Moss", question: "Why was Ingrid Moss's session held somewhere else?", overlap: "name" },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const label = valueOf("--label") ?? "";
  // --env KEY=VALUE,KEY=VALUE: extra settings for this run, e.g. RAG_MIN_SIMILARITY=0.3
  const extraEnv = Object.fromEntries((valueOf("--env") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  const flagValues = new Set(["--label", "--env"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const systems = args.filter((a, i) => !a.startsWith("--") && !flagValues.has(i)) as System[];
  if (systems.length === 0) systems.push("current");

  const data = await fetchSources(path.join(BENCH, ".cache", "books"), ["gutenberg", "squadTrain"]);
  const train = squadToNotes(data.squadTrain);
  const articles = new Set(seededShuffle([...new Set(train.questions.map((q) => q.title))], 7).slice(0, 48));
  const chosen = train.questions.filter((q) => articles.has(q.title));
  const chosenPaths = new Set(chosen.map((q) => q.notePath));
  const notes = train.notes.filter((n) => chosenPaths.has(n.path));
  const questions = seededShuffle(chosen, 7).slice(0, 2000);

  const book = [...unzip(data.gutenberg).entries()].find(([name]) => name.endsWith("edgeworth-parents.txt"))![1].toString("latin1");
  const bookNotes = bookToChapterNotes("edgeworth-parents", plantNeedles(book, TUNING_NEEDLES));

  const base = await mkdtemp(path.join(os.tmpdir(), "books-tune-"));
  const lines: string[] = [];
  try {
    const squadVault = path.join(base, "squad");
    const bookVault = path.join(base, "book");
    await writeVault(squadVault, notes);
    await writeVault(bookVault, bookNotes);
    const squadDf = documentFrequency(notes);
    const bookDf = documentFrequency(bookNotes);

    for (const system of systems) {
      const parts: string[] = [];
      const squadServer = await connect(system, squadVault, extraEnv);
      const firstMs = await warmUp(squadServer);
      for (const style of ["question"] as const) {
        const s = summarise(await runQueries(squadServer, squadQueries(questions, style, squadDf)));
        parts.push(`squad-train ${style}: found ${s.foundPct}% context ${s.evidencePct}% listed ${s.goldListedPct}% tokens ${s.tokensMean} ms ${s.msMean}`);
      }
      await squadServer.close();

      const bookServer = await connect(system, bookVault, extraEnv);
      await warmUp(bookServer);
      for (const style of ["keyword", "question"] as const) {
        const results = await runQueries(bookServer, needleQueries(bookNotes, style, bookDf, TUNING_NEEDLES));
        const by = (o: string) => results.filter((r) => r.tags.overlap === o && r.correct.found).length;
        const s = summarise(results);
        parts.push(`facts ${style}: ${s.found}/20 (name ${by("name")}/10, none ${by("none")}/10) tokens ${s.tokensMean}`);
      }
      await bookServer.close();
      const env = Object.keys(extraEnv).length ? ` ${JSON.stringify(extraEnv)}` : "";
      const line = `${new Date().toISOString().slice(0, 16)} ${label ? `[${label}] ` : ""}${system}${env} | ${parts.join(" | ")} | index ${Math.round(firstMs)} ms (${notes.length} articles, ${questions.length} questions)`;
      console.log(line);
      lines.push(line);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  await appendFile(path.join(BENCH, "results", "books-tune.txt"), `${lines.join("\n")}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
