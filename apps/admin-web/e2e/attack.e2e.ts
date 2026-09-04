import {
  expect,
  test,
  type APIRequestContext,
  type ConsoleMessage,
  type Page,
  type Request,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mintDevToken } from "./devToken";
import { API_URL, ARTIFACTS_DIR, DEV_AUTH_SECRET, E2E_DATABASE_URL } from "./playwright.config";

/**
 * Adversarial pass 3 — admin console (apps/admin-web) browser attacks.
 *
 *  S2  quality-dashboard request aborted with `connectionfailed` → the panel
 *      shows an error while the flags + model-bundle panels still render.
 *  S3  role downgrade race: paste admin token A, immediately paste user token
 *      B, release A's delayed responses last → the UI must show B's outcome
 *      (403 on the dashboard, B's own cohort in the flag table), never A's.
 *  S3b sequential downgrade (A fully loaded, then B) → what stays on screen?
 *  +   expired token (clock skew), oversized bearer, mid-flight navigation.
 *
 * Every test here needs the API to have a datastore (same gate as the smoke).
 */

const TOKEN_PLACEHOLDER = "paste OIDC (or local dev) admin token";
const DASHBOARD_RE = /\/v1\/admin\/quality-dashboard/;
const FLAGS_RE = /\/v1\/flags$/;
const PANEL_RE = /\/v1\/(flags|admin\/quality-dashboard)/;
/** Registered flag seeded disabled/0% — the only DB row that decides it. */
const COHORT_FLAG = "ball_tracking";

interface Faults {
  pageErrors: string[];
  consoleErrors: string[];
}

function watchFaults(page: Page): Faults {
  const faults: Faults = { pageErrors: [], consoleErrors: [] };
  page.on("pageerror", (error: Error) => faults.pageErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") faults.consoleErrors.push(message.text());
  });
  return faults;
}

async function saveScreenshot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const path = resolve(ARTIFACTS_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
  return path;
}

function saveJson(name: string, value: unknown): string {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const path = resolve(ARTIFACTS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

/** Mirror of services/api/src/modules/flags/routes.ts rolloutBucket(). */
function rolloutBucket(flagKey: string, userId: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${userId}`).digest();
  return ((digest[0]! << 8) | digest[1]!) % 100;
}

async function bootstrap(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.post(`${API_URL}/v1/account/bootstrap`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      locale: "en-US",
      timezone: "UTC",
      device: { platform: "ios", osVersion: "e2e", appVersion: "0.0.0-e2e", model: "playwright" },
    },
  });
  expect(res.status(), "POST /v1/account/bootstrap").toBeLessThan(300);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

async function setFlag(
  request: APIRequestContext,
  adminToken: string,
  key: string,
  patch: { enabled: boolean; rolloutPercent: number },
): Promise<void> {
  const res = await request.put(`${API_URL}/v1/admin/flags/${key}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    data: patch,
  });
  expect(res.status(), `PUT /v1/admin/flags/${key}`).toBe(200);
}

const bearerOf = (request: Request) => request.headers()["authorization"] ?? "";

test.describe("admin-web adversarial (pass 3)", () => {
  test.skip(
    E2E_DATABASE_URL === "",
    "PICKLE_E2E_DATABASE_URL not set — the API runs without a datastore, so authenticated panels return 503.",
  );

  const adminToken = mintDevToken(DEV_AUTH_SECRET, "pickle-e2e-admin", "admin");

  test.beforeEach(async ({ request }) => {
    await bootstrap(request, adminToken);
  });

  test("S2: dashboard connection failure shows an error while flags + model bundle render", async ({
    page,
  }) => {
    const faults = watchFaults(page);
    let aborted = 0;
    await page.route("**/v1/admin/quality-dashboard**", async (route) => {
      aborted += 1;
      await route.abort("connectionfailed");
    });

    await page.goto("/#/");
    const flags200 = page.waitForResponse((r) => FLAGS_RE.test(r.url()) && r.status() === 200);
    await page.getByPlaceholder(TOKEN_PLACEHOLDER).fill(adminToken);
    await flags200;

    const dashboard = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: /Quality dashboard/ }),
    });
    const dashboardError = dashboard.locator("p[style*='185, 28, 28']");
    await expect(dashboardError).toBeVisible();
    const errorText = (await dashboardError.textContent()) ?? "";
    expect(aborted).toBeGreaterThanOrEqual(1);
    // No stale table beneath the error — nothing ever loaded.
    await expect(dashboard.locator("table")).toHaveCount(0);

    // Sibling panels are unaffected.
    const flagsPanel = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: "Feature flags" }),
    });
    await expect(flagsPanel.locator("tbody tr")).not.toHaveCount(0);
    await expect(flagsPanel.locator("p[style*='185, 28, 28']")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 2, name: "Model bundle release" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "User lookup (audited)" }),
    ).toBeVisible();
    await saveScreenshot(page, "attack-s2-dashboard-connectionfailed");

    // Recovery: lift the fault and press Refresh → error clears, table appears.
    await page.unroute("**/v1/admin/quality-dashboard**");
    const dashboard200 = page.waitForResponse(
      (r) => DASHBOARD_RE.test(r.url()) && r.status() === 200,
    );
    await dashboard.getByRole("button", { name: "Refresh" }).click();
    await dashboard200;
    await expect(dashboardError).toHaveCount(0);
    await expect(dashboard.locator("table")).toHaveCount(1);

    saveJson("attack-s2-observation", { errorText, aborted, faults });
    expect(faults.pageErrors).toEqual([]);
    // The aborted fetch logs a network error line in the console; nothing else may.
    for (const line of faults.consoleErrors)
      expect(line).toMatch(/ERR_CONNECTION_FAILED|quality-dashboard|Failed to fetch/);
  });

  test("S3: role downgrade race — A (admin) held back, B (user) pasted, A released last", async ({
    page,
    request,
  }) => {
    const faults = watchFaults(page);
    const adminId = await bootstrap(request, adminToken);

    // Pick a user-role subject whose cohort differs from the admin's for
    // COHORT_FLAG so "A's flag list" and "B's flag list" are distinguishable.
    let userToken = "";
    let userId = "";
    let suffix = 0;
    for (; suffix < 50; suffix++) {
      const candidate = mintDevToken(DEV_AUTH_SECRET, `pickle-e2e-user-${suffix}`, "user");
      const id = await bootstrap(request, candidate);
      if (rolloutBucket(COHORT_FLAG, id) !== rolloutBucket(COHORT_FLAG, adminId)) {
        userToken = candidate;
        userId = id;
        break;
      }
    }
    expect(userToken, "found a user whose cohort differs from the admin").not.toBe("");
    const bucketA = rolloutBucket(COHORT_FLAG, adminId);
    const bucketB = rolloutBucket(COHORT_FLAG, userId);
    const pct = Math.max(bucketA, bucketB);
    const expectA = bucketA < pct;
    const expectB = bucketB < pct;
    expect(expectA).not.toBe(expectB);

    await setFlag(request, adminToken, COHORT_FLAG, { enabled: true, rolloutPercent: pct });
    try {
      await page.goto("/#/");
      const tokenInput = page.getByPlaceholder(TOKEN_PLACEHOLDER);

      // Hold every panel response for token A until we release it.
      let releaseA = (): void => {};
      const gateA = new Promise<void>((r) => (releaseA = r));
      let heldA = 0;
      await page.route(PANEL_RE, async (route) => {
        if (bearerOf(route.request()) === `Bearer ${adminToken}`) {
          heldA += 1;
          await gateA;
        }
        await route.continue();
      });

      const bFlags = page.waitForResponse(
        (r) => FLAGS_RE.test(r.url()) && bearerOf(r.request()) === `Bearer ${userToken}`,
      );
      const bDashboard = page.waitForResponse(
        (r) => DASHBOARD_RE.test(r.url()) && bearerOf(r.request()) === `Bearer ${userToken}`,
      );
      const aFlags = page.waitForResponse(
        (r) => FLAGS_RE.test(r.url()) && bearerOf(r.request()) === `Bearer ${adminToken}`,
      );
      const aDashboard = page.waitForResponse(
        (r) => DASHBOARD_RE.test(r.url()) && bearerOf(r.request()) === `Bearer ${adminToken}`,
      );

      await tokenInput.fill(adminToken);
      await tokenInput.fill(userToken);

      expect((await bFlags).status(), "B GET /v1/flags").toBe(200);
      expect((await bDashboard).status(), "B GET quality-dashboard").toBe(403);
      await expect.poll(() => heldA).toBeGreaterThanOrEqual(2);

      const flagsPanel = page.locator("section", {
        has: page.getByRole("heading", { level: 2, name: "Feature flags" }),
      });
      const cohortRow = flagsPanel.locator("tbody tr", {
        has: page.getByText(COHORT_FLAG, { exact: true }),
      });
      await expect(cohortRow).toHaveCount(1);
      await expect(cohortRow.locator("td").nth(1)).toHaveText(expectB ? "ON" : "off");

      const dashboard = page.locator("section", {
        has: page.getByRole("heading", { level: 2, name: /Quality dashboard/ }),
      });
      const dashboardError = dashboard.locator("p[style*='185, 28, 28']");
      await expect(dashboardError).toContainText(/Admin role required/);

      // Now let A's stale (privileged, successful) responses land.
      releaseA();
      expect((await aFlags).status(), "A GET /v1/flags").toBe(200);
      expect((await aDashboard).status(), "A GET quality-dashboard").toBe(200);
      await page.waitForLoadState("networkidle");
      await page.unroute(PANEL_RE);

      // The UI must still reflect B.
      await expect(cohortRow.locator("td").nth(1)).toHaveText(expectB ? "ON" : "off");
      await expect(dashboardError).toContainText(/Admin role required/);
      await expect(dashboard.locator("table")).toHaveCount(0);
      const shot = await saveScreenshot(page, "attack-s3-downgrade-race");
      saveJson("attack-s3-observation", {
        adminId,
        userId,
        userSuffix: suffix,
        bucketA,
        bucketB,
        pct,
        expectA,
        expectB,
        heldA,
        faults,
        screenshot: shot,
      });
      expect(faults.pageErrors).toEqual([]);
    } finally {
      await setFlag(request, adminToken, COHORT_FLAG, { enabled: false, rolloutPercent: 0 });
    }
  });

  test("S3b: sequential downgrade — A fully loaded, then B: is A's dashboard data cleared?", async ({
    page,
    request,
  }) => {
    const faults = watchFaults(page);
    const userToken = mintDevToken(DEV_AUTH_SECRET, "pickle-e2e-user-seq", "user");
    await bootstrap(request, userToken);

    await page.goto("/#/");
    const tokenInput = page.getByPlaceholder(TOKEN_PLACEHOLDER);
    const aDashboard = page.waitForResponse(
      (r) => DASHBOARD_RE.test(r.url()) && r.status() === 200,
    );
    await tokenInput.fill(adminToken);
    await aDashboard;
    const dashboard = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: /Quality dashboard/ }),
    });
    await expect(dashboard.locator("table")).toHaveCount(1);

    const bDashboard = page.waitForResponse(
      (r) => DASHBOARD_RE.test(r.url()) && bearerOf(r.request()) === `Bearer ${userToken}`,
    );
    await tokenInput.fill(userToken);
    expect((await bDashboard).status()).toBe(403);
    const dashboardError = dashboard.locator("p[style*='185, 28, 28']");
    await expect(dashboardError).toContainText(/Admin role required/);
    await page.waitForLoadState("networkidle");

    const staleTables = await dashboard.locator("table").count();
    const shot = await saveScreenshot(page, "attack-s3b-sequential-downgrade");
    saveJson("attack-s3b-observation", {
      staleTablesUnder403: staleTables,
      faults,
      screenshot: shot,
    });
    expect(faults.pageErrors).toEqual([]);
    // After a 403 for the CURRENT token, no privileged data from the previous
    // token may remain rendered under the error.
    expect(staleTables, "admin dashboard table still rendered under B's 403").toBe(0);
  });

  test("clock skew: an expired admin token is refused everywhere and the UI says so", async ({
    page,
    request,
  }) => {
    const faults = watchFaults(page);
    const expired = mintDevToken(DEV_AUTH_SECRET, "pickle-e2e-admin", "admin", -120);
    const direct = await request.get(`${API_URL}/v1/flags`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(direct.status(), "expired token GET /v1/flags").toBe(401);

    await page.goto("/#/");
    const rejected = page.waitForResponse((r) => FLAGS_RE.test(r.url()));
    await page.getByPlaceholder(TOKEN_PLACEHOLDER).fill(expired);
    expect((await rejected).status()).toBe(401);
    await expect(page.getByText(/Token verification failed/).first()).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
    expect(faults.pageErrors).toEqual([]);
  });

  test("huge input: a 20 KB bearer does not crash the page and never unlocks a panel", async ({
    page,
  }) => {
    const faults = watchFaults(page);
    const huge = `${adminToken}${"A".repeat(20_000)}`;
    await page.goto("/#/");
    const first = page.waitForResponse((r) => FLAGS_RE.test(r.url()));
    await page.getByPlaceholder(TOKEN_PLACEHOLDER).fill(huge);
    const status = (await first).status();
    saveJson("attack-huge-bearer", { status });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("section table")).toHaveCount(0);
    await expect(page.locator("p[style*='185, 28, 28']").first()).toBeVisible();
    expect(faults.pageErrors).toEqual([]);
  });

  test("cancellation mid-flight: navigating away while panels load leaves no page errors", async ({
    page,
  }) => {
    const faults = watchFaults(page);
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    await page.route(PANEL_RE, async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });
    await page.goto("/#/");
    await page.getByPlaceholder(TOKEN_PLACEHOLDER).fill(adminToken);
    await expect.poll(() => held).toBeGreaterThanOrEqual(2);
    // Leave the API console (unmounts every panel) while responses are pending.
    await page.getByRole("link", { name: "Coach Review Lab" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: /Review queue|Coach Review Lab/ }),
    ).toBeVisible();
    release();
    await page.waitForLoadState("networkidle");
    await page.unroute(PANEL_RE);
    // Back to the console: the token lives in AdminApp, so the panels remount
    // and load fresh (the released stale responses must not have leaked in).
    const fresh = page.waitForResponse((r) => FLAGS_RE.test(r.url()) && r.status() === 200);
    await page.getByRole("link", { name: "API console" }).click();
    await fresh;
    await expect(page.locator("section table").first().locator("tbody tr")).not.toHaveCount(0);
    expect(faults.pageErrors).toEqual([]);
    expect(faults.consoleErrors).toEqual([]);
  });
});
