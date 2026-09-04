import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { createLabApiMiddleware } from "../../src/coachReview/labApi";

/**
 * ATTACK S9 harness: the SAME vite setup as ../../vite.config.ts (react +
 * `/v1` proxy + the real Coach Review Lab middleware), except the middleware
 * is rooted at `PICKLE_ATTACK4_LAB_ROOT` — a throwaway directory the e2e spec
 * owns — instead of the repository. The repo's datasets/ never see the
 * corrupt file.
 */
const LAB_ROOT = process.env["PICKLE_ATTACK4_LAB_ROOT"];
if (!LAB_ROOT) throw new Error("PICKLE_ATTACK4_LAB_ROOT must point at the throwaway lab root");

function throwawayCoachReviewLabPlugin(): Plugin {
  return {
    name: "pickle-coach-review-lab-attack4",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(createLabApiMiddleware(LAB_ROOT!));
    },
  };
}

export default defineConfig({
  plugins: [react(), throwawayCoachReviewLabPlugin()],
  server: {
    port: 5174,
    proxy: {
      "/v1": "http://127.0.0.1:3001",
    },
  },
});
