import { defineConfig } from "vitest/config";

// The long-run leak harness (test/stress/) forces GC between heap samples;
// `--expose-gc` is only honoured as a node CLI flag, so it is passed to the
// fork pool rather than expected from the caller's NODE_OPTIONS.
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
