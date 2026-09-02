import { defineConfig } from "vitest/config";

// Integration tests share one physical test database and reset the public
// schema; files must not run against it concurrently. Each test replays the
// full migration set against real PostgreSQL, which on shared CI runners can
// exceed vitest's 5s unit-test default.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
