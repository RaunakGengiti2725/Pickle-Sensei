import { defineConfig } from "vitest/config";

// The long-run leak harness (test/stress) forces GC between heap samples, so
// the worker processes need `--expose-gc`. Everything else is vitest default.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
  },
});
