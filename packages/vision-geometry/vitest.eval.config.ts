import { defineConfig } from "vitest/config";

/** Benchmark evaluations are separate from unit tests: `pnpm eval`. */
export default defineConfig({
  test: { include: ["eval/**/*.eval.ts"] },
});
