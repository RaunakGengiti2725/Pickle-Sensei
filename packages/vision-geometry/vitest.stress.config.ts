import { defineConfig } from "vitest/config";

/**
 * Long-run stress campaigns with V8's GC exposed to the worker process:
 *   STRESS_ITER=1000 STRESS_OUT=/tmp/leak.json vitest run --config vitest.stress.config.ts
 * The default `pnpm test` still runs the same file at its small default.
 */
export default defineConfig({
  test: {
    include: ["test/stress/**/*.stress.test.ts"],
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--expose-gc"], singleFork: true } },
    testTimeout: 20 * 60 * 1000,
  },
});
