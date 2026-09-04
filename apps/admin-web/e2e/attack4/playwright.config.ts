import { defineConfig, devices } from "@playwright/test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ATTACK S9 Playwright config. Boots the local Fastify API on :3001 (same as
 * the smoke config) and a vite dev server on :5174 whose Coach Review Lab
 * middleware is rooted at a THROWAWAY copy of datasets/coach-review under
 * e2e/dist (gitignored). The spec corrupts reviews/ inside that copy only.
 *
 *   pnpm --filter @pickle/admin-web exec playwright test --config e2e/attack4/playwright.config.ts
 */

export const ATTACK_DIR = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = resolve(ATTACK_DIR, "..");
export const REPO_ROOT = resolve(E2E_DIR, "../../..");
export const OUTPUT_DIR = resolve(E2E_DIR, "dist", "attack4");
export const ARTIFACTS_DIR = resolve(REPO_ROOT, "artifacts", "attack4");
export const LAB_ROOT = resolve(OUTPUT_DIR, "lab-root");
export const LAB_REVIEWS_DIR = resolve(LAB_ROOT, "datasets", "coach-review", "reviews");

export const ADMIN_WEB_URL = "http://127.0.0.1:5174";
export const API_URL = "http://127.0.0.1:3001";
export const DEV_AUTH_SECRET =
  process.env["DEV_AUTH_SECRET"] ?? "attack4-e2e-dev-secret-0123456789abcdef";
export const E2E_DATABASE_URL = process.env["PICKLE_E2E_DATABASE_URL"] ?? "";

// Fresh throwaway lab root on every config load (the webServer below reads it).
rmSync(LAB_ROOT, { recursive: true, force: true });
mkdirSync(resolve(LAB_ROOT, "datasets"), { recursive: true });
cpSync(
  resolve(REPO_ROOT, "datasets", "coach-review"),
  resolve(LAB_ROOT, "datasets", "coach-review"),
  {
    recursive: true,
  },
);
rmSync(LAB_REVIEWS_DIR, { recursive: true, force: true });
mkdirSync(LAB_REVIEWS_DIR, { recursive: true });

export default defineConfig({
  testDir: ATTACK_DIR,
  // `*.attack.ts`, not `*.e2e.ts`: the package's main playwright.config.ts globs
  // e2e/**/*.e2e.ts and would otherwise run this spec without the throwaway
  // lab-root mounted (and vitest would collect *.test.ts).
  testMatch: /.*\.attack\.ts$/,
  outputDir: resolve(OUTPUT_DIR, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(ARTIFACTS_DIR, "s9-playwright-report.json") }],
  ],
  use: {
    baseURL: ADMIN_WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @pickle/api start",
      cwd: REPO_ROOT,
      url: `${API_URL}/v1/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PICKLE_ENV: "development",
        PORT: "3001",
        HOST: "127.0.0.1",
        DEV_AUTH_SECRET,
        ...(E2E_DATABASE_URL ? { DATABASE_URL: E2E_DATABASE_URL } : {}),
      },
    },
    {
      command:
        "pnpm --filter @pickle/admin-web exec vite --config e2e/attack4/labRoot.vite.config.ts --host 127.0.0.1 --port 5174 --strictPort",
      cwd: REPO_ROOT,
      url: ADMIN_WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { PICKLE_ATTACK4_LAB_ROOT: LAB_ROOT },
    },
  ],
});
