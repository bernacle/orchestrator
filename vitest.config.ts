import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests drive real git (origin, clone, worktrees); generous for slow or busy machines.
    testTimeout: 120_000,
    pool: "forks",
  },
});
