import { expect, test, type ConsoleMessage, type Page, type Request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { mintDevToken } from "./devToken";
import { API_URL, ARTIFACTS_DIR, DEV_AUTH_SECRET, E2E_DATABASE_URL } from "./playwright.config";

interface BrowserFaults {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

/** Collects everything that would make a "loads cleanly" claim false. */
function watchBrowserFaults(page: Page): BrowserFaults {
  const faults: BrowserFaults = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") faults.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error: Error) => faults.pageErrors.push(error.message));
  page.on("requestfailed", (request: Request) =>
    faults.failedRequests.push(
      `${request.method()} ${request.url()} → ${request.failure()?.errorText}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      faults.failedRequests.push(
        `${response.request().method()} ${response.url()} → HTTP ${response.status()}`,
      );
  });
  return faults;
}

function expectNoFaults(faults: BrowserFaults): void {
  expect(faults.consoleErrors, "browser console errors").toEqual([]);
  expect(faults.pageErrors, "uncaught page errors").toEqual([]);
  expect(faults.failedRequests, "failed or 4xx/5xx requests").toEqual([]);
}

async function saveScreenshot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const path = resolve(ARTIFACTS_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
  return path;
}

test.describe("admin-web smoke", () => {
  test("loads the API console with no console errors and a healthy API", async ({
    page,
    request,
  }) => {
    const faults = watchBrowserFaults(page);

    // An empty hash defaults to the Coach Review Lab (useHashRoute); `#/` is the API console.
    await page.goto("/#/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Pickle Sensei — Admin" }),
    ).toBeVisible();
    await expect(page.getByPlaceholder("paste OIDC (or local dev) admin token")).toBeVisible();
    await expect(page.getByText("Provide a token to load panels.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Coach Review Lab" })).toBeVisible();

    // API reachability, direct (:3001) …
    const direct = await request.get(`${API_URL}/v1/health`);
    expect(direct.status(), "GET :3001/v1/health").toBe(200);
    expect(await direct.json()).toEqual({ status: "ok", version: expect.any(String) });

    // … and through the vite proxy the browser actually uses (`/v1` → :3001).
    const viaBrowser = await page.evaluate(async () => {
      const response = await fetch("/v1/health", { headers: { accept: "application/json" } });
      return { status: response.status, body: (await response.json()) as unknown };
    });
    expect(viaBrowser.status, "browser fetch /v1/health via vite proxy").toBe(200);
    expect(viaBrowser.body).toEqual({ status: "ok", version: expect.any(String) });

    await saveScreenshot(page, "admin-console-anonymous");
    expectNoFaults(faults);
  });

  test("renders the Coach Review Lab from the checked-in datasets", async ({ page }) => {
    const faults = watchBrowserFaults(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Pickle Sensei — Admin" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "API console" })).toBeVisible();
    // Either the queue table or the explicit "run pnpm lab:coach-queue" error box counts as a
    // rendered lab; a blank/crashed panel does not.
    await expect(
      page.getByRole("heading", { level: 2, name: /Review queue|Coach Review Lab/ }),
    ).toBeVisible();
    await expect(page.getByText(/Loading queue…/)).toHaveCount(0);

    await saveScreenshot(page, "coach-review-lab");
    expectNoFaults(faults);
  });

  test("an admin dev token unlocks the panels and feature flags load from Postgres", async ({
    page,
    request,
  }) => {
    test.skip(
      E2E_DATABASE_URL === "",
      "PICKLE_E2E_DATABASE_URL not set — the API runs without a datastore, so authenticated panels return 503. " +
        "Point it at a migrated+seeded Postgres (see docs/devin/TEST_MATRIX.md) to run this test.",
    );
    const faults = watchBrowserFaults(page);
    const token = mintDevToken(DEV_AUTH_SECRET, "pickle-e2e-admin", "admin");

    // Dev tokens identify a subject; the app_user row is created by bootstrap (idempotent).
    const bootstrap = await request.post(`${API_URL}/v1/account/bootstrap`, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        locale: "en-US",
        timezone: "UTC",
        device: { platform: "ios", osVersion: "e2e", appVersion: "0.0.0-e2e", model: "playwright" },
      },
    });
    expect(bootstrap.status(), "POST /v1/account/bootstrap").toBeLessThan(300);

    await page.goto("/#/");
    const tokenInput = page.getByPlaceholder("paste OIDC (or local dev) admin token");

    // A rejected token surfaces the API error in the panels (negative control). The
    // 401s it provokes are the only faults this test tolerates; everything after
    // this point must be clean, so the collector is drained once they are checked.
    await tokenInput.fill("not-a-valid-token");
    await expect(page.getByText(/Token verification failed/).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(faults.pageErrors, "uncaught page errors").toEqual([]);
    expect(faults.failedRequests, "rejected-token requests").not.toEqual([]);
    for (const fault of faults.failedRequests) expect(fault).toMatch(/ → HTTP 401$/);
    for (const fault of faults.consoleErrors) expect(fault).toMatch(/401/);
    faults.failedRequests.length = 0;
    faults.consoleErrors.length = 0;

    // A later successful load must clear the error — a stale error above a
    // correctly loaded table is what an operator typing a token keystroke-by-
    // keystroke sees otherwise.
    const flagsResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/flags") &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await tokenInput.fill(token);

    expect((await flagsResponse).status(), "GET /v1/flags through the vite proxy").toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: "Feature flags" })).toBeVisible();
    await expect(page.locator("table").first().locator("tbody tr")).not.toHaveCount(0);
    await expect(page.getByText(/Token verification failed/)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: /Quality dashboard/ })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Model bundle release" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "User lookup (audited)" }),
    ).toBeVisible();

    await saveScreenshot(page, "admin-console-authenticated");
    expectNoFaults(faults);
  });
});
