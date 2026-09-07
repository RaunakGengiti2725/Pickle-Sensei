import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Browser smoke for the admin console (docs/devin/TEST_MATRIX.md → admin-web).
 *
 * Boots the legacy/local Fastify API (`@pickle/api start`, :3001) and the vite
 * dev server (:5173, which proxies `/v1` to the API), then drives Chromium
 * against them. Both servers are reused when already listening (so
 * `pnpm dev:api` + `pnpm --filter @pickle/admin-web dev` in other terminals
 * work too) — except under CI, where a stray server is an error.
 *
 * Env:
 *   DEV_AUTH_SECRET          HS256 secret shared by the API's dev token issuer
 *                            and the token this suite mints. Defaults below;
 *                            when reusing an externally started API it MUST
 *                            match that process's secret.
 *   PICKLE_E2E_DATABASE_URL  Optional migrated+seeded Postgres. Enables the
 *                            authenticated-panel test (otherwise it is
 *                            reported as SKIPPED with a reason, never green).
 */

export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(E2E_DIR, "../../..");
// Everything generated lands under `dist/`, which the root .gitignore, .prettierignore and
// eslint config already exclude (a nested ignore file would not be honoured by prettier).
export const OUTPUT_DIR = resolve(E2E_DIR, "dist");
export const ARTIFACTS_DIR = resolve(OUTPUT_DIR, "artifacts");

export const ADMIN_WEB_URL = "http://127.0.0.1:5173";
export const API_URL = "http://127.0.0.1:3001";
export const DEV_AUTH_SECRET = process.env["DEV_AUTH_SECRET"] ?? "pickle-e2e-dev-secret-0123456789";
export const E2E_DATABASE_URL = process.env["PICKLE_E2E_DATABASE_URL"] ?? "";

const isCi = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: E2E_DIR,
  // `*.e2e.ts`, not `*.spec.ts`: the package's `vitest run` would otherwise collect these files.
  testMatch: /.*\.e2e\.ts$/,
  outputDir: resolve(OUTPUT_DIR, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: isCi,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: resolve(OUTPUT_DIR, "report") }]],
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
      reuseExistingServer: !isCi,
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
      // `pnpm … dev -- --host` forwards the literal `--` to vite (host flag ignored, binds ::1
      // only), so invoke the binary directly. Same vite.config.ts (proxy `/v1` → :3001) applies.
      command:
        "pnpm --filter @pickle/admin-web exec vite --host 127.0.0.1 --port 5173 --strictPort",
      cwd: REPO_ROOT,
      url: ADMIN_WEB_URL,
      reuseExistingServer: !isCi,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
