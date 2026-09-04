import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Structural audit probes (auditor #2) for apps/admin-web/e2e/playwright.config.ts:
 * the config is imported with a controlled environment so its defaults can be
 * asserted without launching Playwright.
 */

type WebServer = {
  command: string;
  reuseExistingServer?: boolean;
  env?: Record<string, string>;
};
type LoadedConfig = {
  default: { webServer?: WebServer | WebServer[]; globalSetup?: string | string[] };
  DEV_AUTH_SECRET: string;
};

async function loadConfig(env: Record<string, string | undefined>): Promise<LoadedConfig> {
  vi.resetModules();
  const saved = { CI: process.env["CI"], DEV_AUTH_SECRET: process.env["DEV_AUTH_SECRET"] };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return (await import("../../e2e/playwright.config.js")) as unknown as LoadedConfig;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function servers(config: LoadedConfig): WebServer[] {
  const ws = config.default.webServer;
  return Array.isArray(ws) ? ws : ws ? [ws] : [];
}

afterEach(() => vi.resetModules());

describe("playwright.config.ts defaults", () => {
  it("under CI a stray :3001/:5173 server is an error (reuseExistingServer=false)", async () => {
    const config = await loadConfig({ CI: "1", DEV_AUTH_SECRET: undefined });
    expect(servers(config).map((s) => s.reuseExistingServer)).toEqual([false, false]);
  });

  it("the API webServer is pinned to PICKLE_ENV=development and passes the minted secret through", async () => {
    const config = await loadConfig({
      CI: undefined,
      DEV_AUTH_SECRET: "audit-secret-0123456789abcdef",
    });
    const api = servers(config).find((s) => s.command.includes("@pickle/api"));
    expect(api?.env?.["PICKLE_ENV"]).toBe("development");
    expect(api?.env?.["DEV_AUTH_SECRET"]).toBe("audit-secret-0123456789abcdef");
    expect(config.DEV_AUTH_SECRET.length).toBeGreaterThanOrEqual(16);
  });

  it("OBSERVATION: off-CI with no DEV_AUTH_SECRET the suite reuses ANY listening :3001 with a public default secret and no preflight", async () => {
    const config = await loadConfig({ CI: undefined, DEV_AUTH_SECRET: undefined });
    const reuse = servers(config).map((s) => s.reuseExistingServer);
    const defaultSecret = config.DEV_AUTH_SECRET;
    // Facts about 4d812e1a pinned by this assertion: both servers are reused when already
    // listening, the fallback secret is a committed literal, and nothing verifies that a
    // reused API was started with the same secret (no globalSetup) — a mismatch surfaces
    // later as 401s inside the authenticated-panel test.
    expect({ reuse, defaultSecret, globalSetup: config.default.globalSetup ?? null }).toEqual({
      reuse: [false, false],
      defaultSecret: expect.not.stringContaining("pickle-e2e-dev-secret"),
      globalSetup: expect.any(String),
    });
  });
});
