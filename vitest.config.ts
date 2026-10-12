import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/ts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/target/**"],
    // litesvm is a native addon: keep each file in its own process.
    pool: "forks",
    testTimeout: 60_000,
  },
});
