import { defineConfig } from "vitest/config";

// Integration tests share one physical test database and reset the public
// schema; files must not run against it concurrently.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
