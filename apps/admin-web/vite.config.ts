import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { createLabApiMiddleware } from "./src/coachReview/labApi";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Coach Review Lab dev API. The full implementation (identity gates,
 * append-only persistence, schema validation) lives in
 * src/coachReview/labApi.ts so the exact middleware the dev server runs is
 * unit-tested against throwaway roots — see __tests__/labApi.test.ts.
 */
function coachReviewLabPlugin(): Plugin {
  return {
    name: "pickle-coach-review-lab",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(createLabApiMiddleware(REPO_ROOT));
    },
  };
}

export default defineConfig({
  plugins: [react(), coachReviewLabPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:3001",
    },
  },
});
