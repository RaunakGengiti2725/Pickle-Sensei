import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Outcome } from "../src/coachReview/__tests__/stress/faultCatalog";
import {
  createResultsTable,
  flushResultsTable,
  recordResult,
} from "../src/coachReview/__tests__/stress/resultsTable";
import {
  campaignSeeds,
  makeRng,
  STRESS_DISABLED_HINT,
  stressEnabled,
  type Rng,
} from "../src/coachReview/__tests__/stress/seededRng";
import { ARTIFACTS_DIR } from "./playwright.config";

/**
 * STRESS / failure-injection — the admin console IN THE BROWSER (real vite dev
 * server, real Chromium), every network dependency of the page intercepted with
 * `page.route` and answered with abort / 4xx / 5xx / non-JSON / null / {} / [] /
 * partial / slow / never-resolves. Per fault we assert what an operator sees:
 *   - no infinite pending: with the page clock advanced 60 s the loading copy is
 *     gone and either data or an error is on screen;
 *   - no silent failure: a broken dependency produces visible error text;
 *   - no fake success: malformed data never renders as a healthy panel;
 *   - no crash: no uncaught page error, the app shell (h1 + nav) is still mounted
 *     (React unmounts the whole root on an uncaught render error — a blank page);
 *   - recoverable: a visible back/retry control exists, and once the fault is
 *     removed the same view loads (reload / Refresh / re-typed token).
 *
 * Scenario(seed) = CELLS[seed % CELLS.length]; RNG(seed) drives which key a
 * "partial" payload drops and the slow delay. Opt-in (see `stressEnabled`):
 * STRESS_ITER=<n> runs a campaign, STRESS_SEEDS=<n,...> replays; without either
 * the file registers as skipped. The JSON table lands in e2e/dist/artifacts/stress/.
 */

type Mode =
  | "abort"
  | "http500-json"
  | "http500-html"
  | "http401"
  | "http404"
  | "ok-nonjson"
  | "ok-null"
  | "ok-empty-object"
  | "ok-array"
  | "ok-string"
  | "ok-partial"
  | "slow"
  | "hang";

const REQUIRED_LAB = [
  "/datasets/coach-review/queue.json",
  "/datasets/coach-review/schema.json",
  "/datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json",
  "/datasets/coach-review/drills/drill-library.v0.json",
  "/datasets/coach-review/coaches.json",
  "/api/coach-reviews",
] as const;
const OPTIONAL_LAB = [
  "/api/coach-assignments",
  "/api/coach-adjudications",
  "/api/coach-review-amendments",
  "/api/drill-mapping-proposals",
] as const;
const LAB_MODES: Mode[] = [
  "abort",
  "http500-json",
  "http404",
  "ok-nonjson",
  "ok-null",
  "ok-empty-object",
  "ok-array",
  "ok-string",
  "ok-partial",
  "slow",
  "hang",
];
const CONSOLE_MODES: Mode[] = [
  "abort",
  "http500-json",
  "http500-html",
  "http401",
  "ok-nonjson",
  "ok-null",
  "ok-empty-object",
  "ok-string",
  "slow",
  "hang",
];

interface Cell {
  name: string;
  family: "lab-required" | "lab-optional" | "console" | "navigation" | "media";
  path: string;
  mode: Mode;
}

const CELLS: Cell[] = [
  ...REQUIRED_LAB.flatMap((path) =>
    LAB_MODES.map((mode): Cell => ({
      name: `lab-required:${path}:${mode}`,
      family: "lab-required",
      path,
      mode,
    })),
  ),
  ...OPTIONAL_LAB.flatMap((path) =>
    LAB_MODES.map((mode): Cell => ({
      name: `lab-optional:${path}:${mode}`,
      family: "lab-optional",
      path,
      mode,
    })),
  ),
  ...["/v1/admin/quality-dashboard", "/v1/flags"].flatMap((path) =>
    CONSOLE_MODES.map((mode): Cell => ({
      name: `console:${path}:${mode}`,
      family: "console",
      path,
      mode,
    })),
  ),
  {
    name: "navigation:unknown-queue-item",
    family: "navigation",
    path: "#/coach/item/does-not-exist",
    mode: "http404",
  },
  {
    name: "navigation:malformed-percent-in-hash",
    family: "navigation",
    path: "#/coach/item/%E0%A4%A",
    mode: "http404",
  },
  {
    name: "navigation:agreement-view-with-reviews-500",
    family: "navigation",
    path: "#/coach/agreement",
    mode: "http500-json",
  },
  { name: "media:item-video-404", family: "media", path: "video", mode: "http404" },
  { name: "media:item-video-abort", family: "media", path: "video", mode: "abort" },
  { name: "media:item-video-nonvideo-body", family: "media", path: "video", mode: "ok-nonjson" },
];

const table = createResultsTable("admin-web browser (Playwright + page.route) failure-injection");
const seeds = campaignSeeds(process.env, 8);
const enabled = stressEnabled(process.env);

function faultHandler(mode: Mode, rng: Rng, notes: string[]): (route: Route) => Promise<void> {
  return async (route) => {
    switch (mode) {
      case "abort":
        return route.abort("failed");
      case "http500-json":
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "injected 500" }),
        });
      case "http500-html":
        return route.fulfill({
          status: 500,
          contentType: "text/html",
          body: "<html><body>Bad Gateway</body></html>",
        });
      case "http401":
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "unauthorized", message: "injected 401" } }),
        });
      case "http404":
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ message: "injected 404" }),
        });
      case "ok-nonjson":
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body>captive portal</body></html>",
        });
      case "ok-null":
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      case "ok-empty-object":
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      case "ok-array":
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      case "ok-string":
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify("unexpected string"),
        });
      case "ok-partial": {
        const real = await route.fetch();
        const json = (await real.json()) as unknown;
        if (json && typeof json === "object" && !Array.isArray(json)) {
          const keys = Object.keys(json as Record<string, unknown>);
          const dropped = rng.pick(keys);
          const copy = { ...(json as Record<string, unknown>) };
          delete copy[dropped];
          notes.push(`partial payload dropped top-level key "${dropped}"`);
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(copy),
          });
        }
        if (Array.isArray(json) && json.length > 0) {
          const truncated = json.slice(0, Math.floor(json.length / 2));
          notes.push(`partial payload kept ${truncated.length}/${json.length} elements`);
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(truncated),
          });
        }
        notes.push("partial payload: real body had nothing to drop, served as-is");
        return route.fulfill({ response: real });
      }
      case "slow": {
        const delayMs = rng.int(2_000, 3_500);
        notes.push(`slow: delayed ${delayMs}ms`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
        return route.continue();
      }
      case "hang":
        // Never fulfilled; the route is torn down with the page.
        return new Promise<void>(() => undefined);
    }
  };
}

interface PageFaults {
  pageErrors: string[];
}

function watchPage(page: Page): PageFaults {
  const faults: PageFaults = { pageErrors: [] };
  page.on("pageerror", (error) => faults.pageErrors.push(error.message));
  return faults;
}

async function settle(page: Page): Promise<void> {
  // Let in-flight fetches resolve, then push the page clock 60 s ahead so any
  // client-side timeout/spinner logic would have fired.
  await page.waitForTimeout(600);
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(200);
}

/** Text of the first match, or "" — never auto-waits for an element that may legitimately be absent. */
async function firstText(locator: Locator): Promise<string> {
  if ((await locator.count()) === 0) return "";
  return (await locator.first().textContent())?.trim() ?? "";
}

async function shellMounted(page: Page): Promise<boolean> {
  return (await page.getByRole("heading", { level: 1, name: "Pickle Sensei — Admin" }).count()) > 0;
}

async function screenshot(page: Page, name: string): Promise<string> {
  const dir = resolve(ARTIFACTS_DIR, "stress");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${name.replace(/[^a-z0-9]+/gi, "_")}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

interface Verdict {
  outcome: Outcome;
  observed: string;
}

async function runLabCell(page: Page, cell: Cell, rng: Rng, notes: string[]): Promise<Verdict> {
  const faults = watchPage(page);
  await page.clock.install();
  await page.route((url) => url.pathname === cell.path, faultHandler(cell.mode, rng, notes));
  await page.goto("/#/coach");
  if (cell.mode === "slow") await page.waitForTimeout(3_800);
  await settle(page);

  const loading = await page.getByText("Loading queue…").count();
  const errorBox = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Coach Review Lab" }) });
  const errorText = await firstText(errorBox.locator("p"));
  const queueVisible =
    (await page.getByRole("heading", { level: 2, name: /Review queue/ }).count()) > 0;
  const mounted = await shellMounted(page);
  const backLink = await page.getByRole("link", { name: "API console" }).count();

  if (faults.pageErrors.length > 0 || !mounted) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_CRASH",
      observed: `uncaught page error(s) [${faults.pageErrors.join(" | ").slice(0, 200)}]; app shell mounted=${mounted} — the whole console is blank, no error text, no back control`,
    };
  }
  if (loading > 0) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_INFINITE_PENDING",
      observed: `"Loading queue…" still on screen 60 s (page clock) after ${cell.path} ${cell.mode}; no timeout, no error, no retry control`,
    };
  }
  const isRequired = cell.family === "lab-required";
  // `[]` is a legitimate (empty) reviews list; every other required resource is an object.
  const validEmpty = cell.path === "/api/coach-reviews" && cell.mode === "ok-array";
  if (validEmpty) {
    if (!queueVisible) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_SILENT",
        observed: `empty reviews list [] should render the queue; error="${errorText.slice(0, 100)}"`,
      };
    }
  } else if (
    isRequired &&
    (cell.mode === "abort" ||
      cell.mode === "http500-json" ||
      cell.mode === "http404" ||
      cell.mode === "ok-nonjson")
  ) {
    if (!errorText) {
      await screenshot(page, cell.name);
      return {
        outcome: queueVisible ? "BROKEN_FAKE_SUCCESS" : "BROKEN_SILENT",
        observed: `required ${cell.path} ${cell.mode}: no error text; queueVisible=${queueVisible}`,
      };
    }
    if (backLink === 0)
      return { outcome: "BROKEN_NO_RECOVERY", observed: "error shown but no back/nav control" };
    notes.push(
      "error state offers no in-app retry button (copy says 'reload'); back control = nav link 'API console'",
    );
  } else if (
    isRequired &&
    (cell.mode === "ok-null" ||
      cell.mode === "ok-empty-object" ||
      cell.mode === "ok-array" ||
      cell.mode === "ok-string")
  ) {
    // Valid JSON of the wrong shape: acceptable outcomes are an error box or a rendered queue
    // that is honest about the missing data — a crash was already caught above.
    if (queueVisible) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_FAKE_SUCCESS",
        observed: `required ${cell.path} answered ${cell.mode} yet the queue rendered as healthy`,
      };
    }
    if (!errorText) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_SILENT",
        observed: `required ${cell.path} answered ${cell.mode}: neither queue nor error text on screen`,
      };
    }
  } else if (cell.family === "lab-optional") {
    // Optional endpoints fall back to empty data on rejection; a 2xx of the wrong shape must
    // still leave the page usable (error or queue), never blank.
    if (!queueVisible && !errorText) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_SILENT",
        observed: `optional ${cell.path} ${cell.mode}: neither queue nor error text on screen`,
      };
    }
    if (
      errorText &&
      (cell.mode === "abort" ||
        cell.mode === "http500-json" ||
        cell.mode === "http404" ||
        cell.mode === "ok-nonjson")
    ) {
      notes.push(
        `optional endpoint failure surfaced as a page-level error instead of the empty fallback: ${errorText.slice(0, 100)}`,
      );
    }
  } else if (!queueVisible && !errorText) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_SILENT",
      observed: `${cell.name}: neither queue nor error text on screen`,
    };
  }

  // Recovery: remove the fault, reload — the lab must come back.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const recovered = await page
    .getByRole("heading", { level: 2, name: /Review queue/ })
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!recovered) {
    await screenshot(page, `${cell.name}-recovery`);
    return {
      outcome: "BROKEN_NO_RECOVERY",
      observed: `${cell.name}: after removing the fault and reloading, the queue did not render`,
    };
  }
  return {
    outcome: "HELD",
    observed: queueVisible
      ? `queue rendered (${cell.mode})`
      : `error shown: ${errorText.slice(0, 140)}`,
  };
}

async function runConsoleCell(page: Page, cell: Cell, rng: Rng, notes: string[]): Promise<Verdict> {
  const faults = watchPage(page);
  await page.clock.install();
  await page.route((url) => url.pathname === cell.path, faultHandler(cell.mode, rng, notes));
  await page.goto("/#/");
  const tokenInput = page.getByPlaceholder("paste OIDC (or local dev) admin token");
  await tokenInput.fill("stress-not-a-real-token");
  if (cell.mode === "slow") await page.waitForTimeout(3_800);
  await settle(page);

  const panelName = cell.path.includes("flags") ? "Feature flags" : /Quality dashboard/;
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: panelName }) });
  const mounted = await shellMounted(page);
  if (faults.pageErrors.length > 0 || !mounted) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_CRASH",
      observed: `uncaught page error(s) [${faults.pageErrors.join(" | ").slice(0, 200)}]; app shell mounted=${mounted} — entire console blank`,
    };
  }
  const errorText = await firstText(panel.locator("p").filter({ hasText: /.+/ }));
  const tableRows = await panel.locator("table tr").count();
  const refresh = await panel.getByRole("button", { name: "Refresh" }).count();

  if (cell.mode === "slow") {
    // Real backend answers late: for a fake token that is a visible 401, never a blank panel.
    if (!errorText && tableRows === 0) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_SILENT",
        observed: `${cell.name}: slow response left the panel blank`,
      };
    }
  } else if (cell.mode === "hang") {
    if (!errorText && tableRows === 0) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_INFINITE_PENDING",
        observed: `${cell.path} never resolves: panel shows neither data, error nor loading indicator after 60 s (page clock); no client timeout`,
      };
    }
  } else if (
    cell.mode === "ok-null" ||
    cell.mode === "ok-empty-object" ||
    cell.mode === "ok-string" ||
    cell.mode === "ok-nonjson"
  ) {
    if (tableRows > 0) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_FAKE_SUCCESS",
        observed: `${cell.path} answered ${cell.mode} yet the panel rendered a data table (${tableRows} rows)`,
      };
    }
    if (!errorText) {
      await screenshot(page, cell.name);
      return {
        outcome: "BROKEN_SILENT",
        observed: `${cell.path} answered 200 ${cell.mode}: panel shows neither data nor error text`,
      };
    }
  } else if (!errorText) {
    await screenshot(page, cell.name);
    return {
      outcome: tableRows > 0 ? "BROKEN_FAKE_SUCCESS" : "BROKEN_SILENT",
      observed: `${cell.path} ${cell.mode}: no error text (rows=${tableRows})`,
    };
  }
  if (refresh === 0)
    notes.push("panel has no Refresh/retry control; recovery = re-typing the token");

  // Recovery: drop the fault; Refresh (or re-type the token) → the injected error is replaced by
  // the real backend's verdict for a fake token (a 401 message) or data.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (refresh > 0) await panel.getByRole("button", { name: "Refresh" }).click();
  else await tokenInput.fill("stress-not-a-real-token-2");
  const recovered = await expect
    .poll(() => firstText(panel.locator("p")), { timeout: 10_000 })
    .toMatch(/Token verification|unauthori[sz]ed|invalid|HTTP 401|HTTP 503/i)
    .then(() => true)
    .catch(() => false);
  if (!recovered) {
    await screenshot(page, `${cell.name}-recovery`);
    return {
      outcome: "BROKEN_NO_RECOVERY",
      observed: `${cell.name}: after removing the fault the panel still shows "${errorText.slice(0, 100)}"`,
    };
  }
  return { outcome: "HELD", observed: `error shown: ${errorText.slice(0, 140)}` };
}

async function runNavigationCell(
  page: Page,
  cell: Cell,
  rng: Rng,
  notes: string[],
): Promise<Verdict> {
  const faults = watchPage(page);
  await page.clock.install();
  if (cell.name.includes("reviews-500")) {
    await page.route(
      (url) => url.pathname === "/api/coach-reviews",
      faultHandler("http500-json", rng, notes),
    );
  }
  await page.goto(`/${cell.path}`);
  await settle(page);
  const mounted = await shellMounted(page);
  if (faults.pageErrors.length > 0 || !mounted) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_CRASH",
      observed: `navigating to ${cell.path}: uncaught page error(s) [${faults.pageErrors.join(" | ").slice(0, 200)}]; app shell mounted=${mounted}`,
    };
  }
  const back = await page
    .getByRole("link", { name: /Back to queue|API console|Coach Review Lab/ })
    .count();
  const body = await firstText(page.locator("main"));
  const visibleVerdict =
    /Unknown queue item|Review queue|Coach Review Lab|agreement|Agreement/i.test(body);
  if (!visibleVerdict) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_SILENT",
      observed: `${cell.path}: page shows no queue, no error, no 'unknown item' copy`,
    };
  }
  if (back === 0)
    return {
      outcome: "BROKEN_NO_RECOVERY",
      observed: `${cell.path}: no back/nav control on screen`,
    };
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto("/#/coach");
  const backViaHash =
    (await page.getByRole("heading", { level: 2, name: /Review queue/ }).count()) > 0;
  if (!backViaHash) {
    // The lab's error state replaces every hash view and only a document reload re-fetches;
    // in-app navigation alone does not retry.
    notes.push(
      "in-app hash navigation back to #/coach did not retry the failed load; recovery required a page reload",
    );
    await page.reload();
  }
  const recovered = await page
    .getByRole("heading", { level: 2, name: /Review queue/ })
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return recovered
    ? { outcome: "HELD", observed: `visible verdict with back control (${back} link(s))` }
    : {
        outcome: "BROKEN_NO_RECOVERY",
        observed: `${cell.path}: queue did not render after navigating back`,
      };
}

async function runMediaCell(page: Page, cell: Cell, rng: Rng, notes: string[]): Promise<Verdict> {
  const faults = watchPage(page);
  const queue = (await (await page.request.get("/datasets/coach-review/queue.json")).json()) as {
    queue: Array<{ queueItemId: string; video: string }>;
  };
  const item = queue.queue[0]!;
  const itemUrl = `/#/coach/item/${encodeURIComponent(item.queueItemId)}`;
  const readVideo = () =>
    page
      .locator("video")
      .first()
      .evaluate((element: HTMLVideoElement) => ({
        error: element.error ? `${element.error.code}:${element.error.message}` : null,
        readyState: element.readyState,
        networkState: element.networkState,
      }));
  // Control: load the fixture without a fault first. The headless shell ships without H.264, so
  // the control itself may already error; that is recorded in notes and the cell then only judges
  // what the page shows for a media error (copy / back control), not why the element errored.
  const itemHeading = page
    .getByRole("heading", { level: 2, name: new RegExp(item.queueItemId) })
    .first();
  await page.goto(itemUrl);
  await itemHeading.waitFor({ timeout: 15_000 });
  await expect
    .poll(async () => (await readVideo()).readyState, { timeout: 10_000 })
    .toBeGreaterThan(0)
    .catch(() => undefined);
  const control = await readVideo();
  if (control.error || control.readyState === 0) {
    notes.push(
      `control (no fault) already errors in this browser: ${JSON.stringify(control)} — codec gap of chromium headless shell, not a product fault`,
    );
  }

  await page.clock.install();
  let intercepted = 0;
  const handler = faultHandler(cell.mode, rng, notes);
  await page.route(
    (url) => url.pathname === `/${item.video}`,
    (route) => {
      intercepted += 1;
      return handler(route);
    },
  );
  await page.reload();
  await itemHeading.waitFor({ timeout: 15_000 });
  await settle(page);
  if (intercepted === 0) {
    return {
      outcome: "HARNESS_ERROR",
      observed: "video request was never intercepted (served from cache?) — cell not evaluable",
    };
  }
  const mounted = await shellMounted(page);
  if (faults.pageErrors.length > 0 || !mounted) {
    await screenshot(page, cell.name);
    return {
      outcome: "BROKEN_CRASH",
      observed: `video ${cell.mode}: uncaught page error(s) [${faults.pageErrors.join(" | ").slice(0, 200)}]`,
    };
  }
  const state = await readVideo();
  const body = await firstText(page.locator("main"));
  const mediaErrorCopy =
    /video (failed|unavailable|could not|error)|failed to load|could not load|unavailable/i.test(
      body,
    );
  const back = await page.getByRole("link", { name: /queue|Coach Review Lab/ }).count();
  await screenshot(page, cell.name);
  if (state.error && !mediaErrorCopy) {
    return {
      outcome: "BROKEN_SILENT",
      observed: `video ${cell.mode} (intercepted ${intercepted}x): element error ${state.error} (networkState=${state.networkState}) but no visible media-error copy — operator sees a black box and a scrubber that never moves; back link count=${back}`,
    };
  }
  if (!state.error && cell.mode !== "ok-nonjson") {
    notes.push(
      `browser reported no media error for ${cell.mode} (readyState=${state.readyState}, networkState=${state.networkState})`,
    );
  }
  return {
    outcome: "HELD",
    observed: `video ${cell.mode}: error=${state.error} copy=${mediaErrorCopy} back=${back}`,
  };
}

test.describe("admin-web browser failure injection", () => {
  test.skip(!enabled, STRESS_DISABLED_HINT);

  test.afterAll(() => {
    if (!enabled) return;
    const path = flushResultsTable(table, "browser-page-route.json");

    console.warn(
      `[stress:browser] executed=${table.executed} held=${table.byOutcome.HELD} failing=${table.failingSeeds.length} → ${path}`,
    );
  });

  for (const seed of seeds) {
    const cell = CELLS[seed % CELLS.length]!;
    test(`seed ${seed} → ${cell.name}`, async ({ page }) => {
      const rng = makeRng(seed);
      const notes: string[] = [];
      const started = Date.now();
      let verdict: Verdict;
      try {
        verdict =
          cell.family === "console"
            ? await runConsoleCell(page, cell, rng, notes)
            : cell.family === "navigation"
              ? await runNavigationCell(page, cell, rng, notes)
              : cell.family === "media"
                ? await runMediaCell(page, cell, rng, notes)
                : await runLabCell(page, cell, rng, notes);
      } catch (error) {
        verdict = { outcome: "HARNESS_ERROR", observed: String(error).slice(0, 300) };
      }
      recordResult(table, {
        seed,
        scenario: cell.name,
        outcome: verdict.outcome,
        observed: verdict.observed,
        notes,
        durationMs: Date.now() - started,
      });
      expect(verdict.outcome, `${verdict.observed}\nreplay: STRESS_SEEDS=${seed}`).toBe("HELD");
    });
  }
});
