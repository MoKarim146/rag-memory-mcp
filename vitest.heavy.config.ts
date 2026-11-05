import { defineConfig } from "vitest/config";

// Heavy tests: property-based fuzzing, stress, concurrency and large vaults. Slow on purpose.
export default defineConfig({
  test: {
    include: ["tests/heavy/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
