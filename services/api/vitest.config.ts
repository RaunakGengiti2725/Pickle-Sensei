import { defineConfig } from "vitest/config";

/**
 * Several integration suites reset the `public` schema of the shared test
 * database, so running suite files in parallel makes migrations race. One file
 * at a time keeps the database gate reproducible.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
