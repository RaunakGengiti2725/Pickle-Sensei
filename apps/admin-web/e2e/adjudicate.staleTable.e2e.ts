import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { mintDevToken } from "./devToken";
import { API_URL, ARTIFACTS_DIR, DEV_AUTH_SECRET, E2E_DATABASE_URL } from "./playwright.config";

/**
 * ADJUDICATION reproduction (area: services-api-legacy-admin-web).
 *
 * Claim under test: after the Quality dashboard has loaded with an ADMIN token,
 * replacing the token with one the API rejects (a non-admin user) shows the
 * error banner but leaves the previously fetched privileged table on screen.
 *
 * The test asserts the CORRECT behaviour (table gone once authorization is
 * lost); a failure is the reproduced defect.
 */
test.describe("ADJUDICATE admin console — privileged data after authorization loss", () => {
  test("Quality dashboard table is cleared when the token is downgraded to a non-admin user", async ({
    page,
    request,
  }) => {
    test.skip(
      E2E_DATABASE_URL === "",
      "PICKLE_E2E_DATABASE_URL not set — authenticated panels need Postgres.",
    );

    const adminToken = mintDevToken(DEV_AUTH_SECRET, "pickle-adjudicate-admin", "admin");
    const userToken = mintDevToken(DEV_AUTH_SECRET, "pickle-adjudicate-user", "user");
    const body = {
      locale: "en-US",
      timezone: "UTC",
      device: { platform: "ios", osVersion: "e2e", appVersion: "0.0.0-e2e", model: "playwright" },
    };
    for (const token of [adminToken, userToken]) {
      const res = await request.post(`${API_URL}/v1/account/bootstrap`, {
        headers: { authorization: `Bearer ${token}` },
        data: body,
      });
      expect(res.status(), "bootstrap").toBeLessThan(300);
    }

    await page.goto("/#/");
    const tokenInput = page.getByPlaceholder("paste OIDC (or local dev) admin token");
    const dashboardOk = page.waitForResponse(
      (r) => r.url().includes("/v1/admin/quality-dashboard") && r.status() === 200,
    );
    await tokenInput.fill(adminToken);
    await dashboardOk;
    const dashboard = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: /Quality dashboard/ }),
    });
    await expect(dashboard.locator("table tbody tr")).not.toHaveCount(0);
    await expect(dashboard.getByText("Analysis-job failures")).toBeVisible();

    // Downgrade: the API now answers 403 for this token on every admin route.
    const dashboardDenied = page.waitForResponse(
      (r) => r.url().includes("/v1/admin/quality-dashboard") && r.status() >= 400,
    );
    await tokenInput.fill(userToken);
    const denied = await dashboardDenied;
    await page.waitForLoadState("networkidle");

    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const shot = resolve(ARTIFACTS_DIR, "adjudicate-stale-quality-dashboard.png");
    await page.screenshot({ path: shot, fullPage: true });
    await test.info().attach("after-downgrade", { path: shot, contentType: "image/png" });

    const rowsAfter = await dashboard.locator("table tbody tr").count();
    const errorVisible = await dashboard
      .locator("p")
      .filter({ hasText: /403|forbidden|admin/i })
      .count();
    console.warn(
      `ADJ-UI-STALE: downgrade → quality-dashboard HTTP ${denied.status()}; error paragraphs=${errorVisible}; privileged table rows still rendered=${rowsAfter}; screenshot=${shot}`,
    );
    expect(errorVisible, "authorization error must be shown").toBeGreaterThan(0);
    expect(rowsAfter, "privileged rows must not remain visible after authorization loss").toBe(0);
  });
});
