import { defineConfig } from "vitest/config";

// Fast tests, run by "npm test". The slow fuzz and stress tests in tests/heavy/ run with "npm run test:heavy".
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "coverage/**", "obsidian-mcp-server/**", "tests/heavy/**"],
  },
});
