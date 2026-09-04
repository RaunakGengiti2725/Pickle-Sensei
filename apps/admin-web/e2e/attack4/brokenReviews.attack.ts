import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARTIFACTS_DIR, LAB_REVIEWS_DIR } from "./playwright.config";

/**
 * ATTACK S9 (UI half): with `reviews/broken.json` (invalid JSON) in the lab
 * root, GET /api/coach-reviews is 500 and the Coach Review Lab must render its
 * explicit error box — NOT an empty queue, NOT a blank panel. A control run
 * without the corrupt file must render the queue, proving the harness itself
 * is healthy.
 */

interface Capture {
  /** Every /api/coach-reviews status seen (React StrictMode double-mounts in dev → 2 loads). */
  reviewsStatuses: number[];
  pageErrors: string[];
}

function capture(page: Page): Capture {
  const cap: Capture = { reviewsStatuses: [], pageErrors: [] };
  page.on("pageerror", (error) => cap.pageErrors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/coach-reviews") {
      cap.reviewsStatuses.push(response.status());
    }
  });
  return cap;
}

function isReviewsResponse(url: string): boolean {
  return new URL(url).pathname === "/api/coach-reviews";
}

async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const path = resolve(ARTIFACTS_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
  return path;
}

function resetReviewsDir(): void {
  rmSync(LAB_REVIEWS_DIR, { recursive: true, force: true });
  mkdirSync(LAB_REVIEWS_DIR, { recursive: true });
}

test.describe("ATTACK S9: corrupt review JSON surfaces as a UI error, not an empty queue", () => {
  test.afterAll(() => resetReviewsDir());

  test("control: clean reviews/ renders the queue table", async ({ page }) => {
    resetReviewsDir();
    const cap = capture(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: /^Review queue/ })).toBeVisible();
    await expect(page.getByText(/Loading queue…/)).toHaveCount(0);
    expect(cap.reviewsStatuses.length).toBeGreaterThanOrEqual(1);
    expect(
      cap.reviewsStatuses.every((s) => s === 200),
      String(cap.reviewsStatuses),
    ).toBe(true);
    expect(cap.pageErrors).toEqual([]);
    await shot(page, "s9-ui-control-clean-queue");
  });

  test("broken.json → HTTP 500 and the lab shows the error box (queue not rendered)", async ({
    page,
  }) => {
    resetReviewsDir();
    writeFileSync(resolve(LAB_REVIEWS_DIR, "broken.json"), '{"reviewId": "x", ');
    const cap = capture(page);
    const firstReviews = page.waitForResponse((r) => isReviewsResponse(r.url()));

    await page.goto("/");
    const reviewsResponse = await firstReviews;
    const reviewsBody = await reviewsResponse.text();
    const errorBox = page.getByText(/GET \/api\/coach-reviews → HTTP 500/);
    await expect(errorBox).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Coach Review Lab" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /^Review queue/ })).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByText(/Loading queue…/)).toHaveCount(0);

    expect(reviewsResponse.status()).toBe(500);
    expect(reviewsBody).toMatch(/SyntaxError/);
    expect(cap.reviewsStatuses.length).toBeGreaterThanOrEqual(1);
    expect(
      cap.reviewsStatuses.every((s) => s === 500),
      String(cap.reviewsStatuses),
    ).toBe(true);
    // Rendering path: loadCoachReviewData rejects → setError; no uncaught error.
    expect(cap.pageErrors).toEqual([]);

    const path = await shot(page, "s9-ui-broken-json-error-box");
    writeFileSync(
      resolve(ARTIFACTS_DIR, "s9-ui-broken-json.json"),
      JSON.stringify(
        {
          scenario: "S9-ui",
          screenshot: path,
          errorText: await errorBox.textContent(),
          reviewsStatuses: cap.reviewsStatuses,
          firstReviewsResponse: { status: reviewsResponse.status(), body: reviewsBody },
          pageErrors: cap.pageErrors,
        },
        null,
        2,
      ),
    );
  });

  test("recovery: removing the corrupt file and reloading brings the queue back", async ({
    page,
  }) => {
    writeFileSync(resolve(LAB_REVIEWS_DIR, "broken.json"), "{");
    await page.goto("/");
    await expect(page.getByText(/HTTP 500/)).toBeVisible();
    resetReviewsDir();
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: /^Review queue/ })).toBeVisible();
    await shot(page, "s9-ui-recovered-after-fix");
  });
});
