// Child process for the cross-process handoff test: replaces the handoff N times as fast as it can.
//   tsx tests/helpers/handoff-writer.ts <vault> <name> <count>
import { getMemoryConfig, updateHandoffSummary } from "../../src/memory.js";

const [vault, name, count] = process.argv.slice(2);
const config = getMemoryConfig({ AI_MEMORY_DIR: vault, AI_MEMORY_WRITE_REVIEW: "off", AI_MEMORY_AUDIT_LOG: "false" });
await Promise.all(Array.from({ length: Number(count) }, (_, i) => updateHandoffSummary(config, `${name} ${i + 1}`)));
