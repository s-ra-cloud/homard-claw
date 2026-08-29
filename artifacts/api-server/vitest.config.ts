import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The lifecycle suite exercises the real Postgres database; run files
    // serially so tests never race each other on shared tables.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Serialize whole suite runs against the shared dev database: a
    // session advisory lock makes a second concurrent `vitest run` wait
    // instead of interleaving with (and corrupting) the first one.
    globalSetup: ["./src/test-global-setup.ts"],
  },
});
