import { expect, test, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";
import { ARTIFACTS_DIR } from "./playwright.config";
import {
  createSeededRng,
  planCampaign,
  summarize,
  writeResultsTable,
  type IterationRow,
  type SeededRng,
} from "../src/stress/seeded";

/**
 * CONCURRENCY STRESS — admin console (browser side). Every `/v1/admin/**`
 * response the panels fetch is served by a seeded in-page mock (page.route),
 * so the run needs no datastore and every interleaving is replayable from its
 * seed. Per seed the scheduler picks response delays, which requests are held
 * back, and the order of these scenarios:
 *
 *   inspect-stale-success   Inspect analysis A (held), then B (fast): the panel
 *                           must keep showing B when A's late response lands.
 *   inspect-stale-error     A (held → 500), then B (fast → 200): the late
 *                           rejection must not paint an error over B's report.
 *   duplicate-clicks        k rapid "Inspect analysis" clicks for one id: k
 *                           requests, final state = that report, no error.
 *   dashboard-window-race   window days X (held) then Y (fast): the Quality
 *                           dashboard must keep Y's numbers (useLatestRequest).
 *   logout-during-request   token cleared while a request is in flight: the
 *                           late response must not throw or resurrect a panel.
 *   rotation-during-request token A → token B while A's request is in flight:
 *                           the panel shows the data fetched under B.
 *
 * Fast by default (STRESS_ITER=3 seeds); larger campaigns via STRESS_ITER, a
 * single replay via STRESS_ONLY_SEED, JSON results via STRESS_OUT.
 */

const DEFAULT_ITERATIONS = 3;
const DEFAULT_BASE_SEED = 20260904;

const campaign = planCampaign(process.env, {
  iterations: DEFAULT_ITERATIONS,
  baseSeed: DEFAULT_BASE_SEED,
});

interface Gate {
  release: () => void;
  released: Promise<void>;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolvePromise) => (release = resolvePromise));
  return { release, released };
}

function diagnostics(analysisId: string, code: string): Record<string, unknown> {
  return {
    diagnostics: {
      analysisId,
      userId: "00000000-0000-4000-8000-0000000000aa",
      serverJobState: "failed",
      inferenceMode: "cloud",
      failureCode: code,
      failureCategory: "pipeline",
      requestedAt: "2026-09-04T00:00:00.000Z",
      startedAt: "2026-09-04T00:00:01.000Z",
      finishedAt: "2026-09-04T00:00:03.000Z",
      latency: { queueMs: 1000, processingMs: 2000, totalMs: 3000 },
      hasMedia: true,
      mediaStatus: "uploaded",
      hasSession: false,
      permit: { status: "consumed", outcome: "scored" },
      shotResultKind: "scored",
      pipelineVersions: { pose: "stress" },
      device: null,
    },
  };
}

/** Encodes BOTH the window and the token so a stale dashboard render is visible. */
function attemptsFor(windowDays: number, token: string): number {
  return windowDays * 1000 + Number(token.replace(/\D/g, "").slice(-3) || 0);
}

function qualityDashboard(windowDays: number, token: string): Record<string, unknown> {
  const rate = { numerator: 0, denominator: 0, rate: null };
  return {
    schemaVersion: "stress",
    generatedAtIso: "2026-09-04T00:00:00.000Z",
    windowDays,
    trials: {
      attempts: attemptsFor(windowDays, token),
      outcomeCounts: {},
      completion: rate,
      usableResult: rate,
      abstention: rate,
      envelopeRejection: rate,
      targetLockSuccess: rate,
      strokeDistribution: [],
      latency: { measuredCount: 0, p50Ms: null, p90Ms: null, p99Ms: null },
      modelVersionDistribution: [],
      userReportedWrongTrialCount: 0,
    },
    sessions: { started: 0, completed: 0, completion: rate },
    crashFree: { status: "not_evaluable", reason: "stress mock" },
    backend: {
      analysisJobs: { requested: 0, failed: 0, failureRate: rate },
      deletionTasksFailed: 0,
      apiErrors: { status: "not_evaluable", reason: "stress mock" },
    },
    queues: {
      analysisQueued: 0,
      analysisProcessing: 0,
      oldestAnalysisQueuedAgeSeconds: null,
      deletionQueued: 0,
      deletionProcessing: 0,
    },
    review: {
      userReportedWrongShotRatings: 0,
      coachReviewQueueDepth: 0,
      silentFailureQueueDepth: 0,
      coachReviewsRecorded: 0,
    },
  };
}

/** Seeded mock of the admin API behind the vite proxy. */
class MockAdminApi {
  readonly holds = new Map<string, Gate>();
  readonly failing = new Set<string>();
  readonly served: string[] = [];
  /** requests the browser abandoned (navigation) before the mock answered */
  readonly abandoned: string[] = [];
  constructor(private readonly rng: SeededRng) {}

  hold(key: string): Gate {
    const g = gate();
    this.holds.set(key, g);
    return g;
  }

  releaseAll(): void {
    for (const held of this.holds.values()) held.release();
  }

  private async fulfill(route: Route, label: string, response: Parameters<Route["fulfill"]>[0]) {
    try {
      await route.fulfill(response);
    } catch (error) {
      if (!String(error).includes("already handled")) throw error;
      this.abandoned.push(label);
    }
  }

  /** Key of the request as the scenarios name it (analysis id, user id or windowDays). */
  static key(route: Route): { kind: "analysis" | "list" | "dashboard" | "other"; key: string } {
    const url = new URL(route.request().url());
    const analysis = /\/v1\/admin\/support\/analyses\/([^/?]+)$/.exec(url.pathname);
    if (analysis) return { kind: "analysis", key: analysis[1]! };
    const list = /\/v1\/admin\/support\/users\/([^/?]+)\/analyses$/.exec(url.pathname);
    if (list) return { kind: "list", key: list[1]! };
    if (url.pathname === "/v1/admin/quality-dashboard") {
      return { kind: "dashboard", key: `window:${url.searchParams.get("windowDays") ?? ""}` };
    }
    return { kind: "other", key: url.pathname };
  }

  handler = async (route: Route): Promise<void> => {
    const { kind, key } = MockAdminApi.key(route);
    const headers = route.request().headers();
    const token = headers["authorization"]?.replace(/^Bearer /, "") ?? "";
    this.served.push(`${kind}:${key}@${token}`);
    const held = this.holds.get(key);
    if (held) await held.released;
    else await new Promise((r) => setTimeout(r, this.rng.range(0, 40)));
    if (this.failing.has(key)) {
      await this.fulfill(route, `${kind}:${key}`, {
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "stress_500", message: `stress failure for ${key}` },
        }),
      });
      return;
    }
    const body =
      kind === "analysis"
        ? diagnostics(key, `CODE-${key}`)
        : kind === "list"
          ? { analyses: [] }
          : kind === "dashboard"
            ? qualityDashboard(Number(key.slice("window:".length)), token)
            : { flags: {} };
    await this.fulfill(route, `${kind}:${key}`, {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };
}

const TOKEN_INPUT = "paste OIDC (or local dev) admin token";

async function inspectAnalysis(page: Page, analysisId: string): Promise<void> {
  await page.getByPlaceholder("analysis uuid").fill(analysisId);
  await page.getByRole("button", { name: "Inspect analysis" }).click();
}

function outcomeCell(page: Page) {
  // first <dd> of the support diagnostics report: "<category> (<failureCode>)"
  return page.locator("dl dd").first();
}

function attemptsCell(page: Page) {
  return page
    .getByRole("row", { name: /Trial attempts/ })
    .locator("td")
    .nth(1);
}

type Scenario = (ctx: {
  page: Page;
  api: MockAdminApi;
  rng: SeededRng;
  token: string;
  fail: (message: string) => void;
  note: (key: string, value: unknown) => void;
}) => Promise<void>;

const scenarios: Record<string, Scenario> = {
  async "inspect-stale-success"({ page, api, rng, fail }) {
    const a = `a-${rng.int(1e6)}`;
    const b = `b-${rng.int(1e6)}`;
    const heldA = api.hold(a);
    await inspectAnalysis(page, a);
    await inspectAnalysis(page, b);
    await expect(outcomeCell(page)).toContainText(`(CODE-${b})`);
    heldA.release();
    await expect
      .poll(() => api.served.filter((entry) => entry.startsWith(`analysis:${a}@`)).length)
      .toBe(1);
    await page.waitForTimeout(rng.range(50, 150));
    const shown = (await outcomeCell(page).textContent()) ?? "";
    if (!shown.includes(`(CODE-${b})`)) {
      fail(
        `inspect-stale-success: input shows "${b}" but the report shows "${shown.trim()}" (stale response for "${a}" overwrote the newer one)`,
      );
    }
  },

  async "inspect-stale-error"({ page, api, rng, fail }) {
    const a = `a-${rng.int(1e6)}`;
    const b = `b-${rng.int(1e6)}`;
    api.failing.add(a);
    const heldA = api.hold(a);
    await inspectAnalysis(page, a);
    await inspectAnalysis(page, b);
    await expect(outcomeCell(page)).toContainText(`(CODE-${b})`);
    heldA.release();
    await expect
      .poll(() => api.served.filter((entry) => entry.startsWith(`analysis:${a}@`)).length)
      .toBe(1);
    await page.waitForTimeout(rng.range(50, 150));
    const error = page.getByText(`stress failure for ${a}`);
    if ((await error.count()) > 0) {
      fail(
        `inspect-stale-error: the older request's rejection ("stress failure for ${a}") is painted over the newer, successful report for "${b}"`,
      );
    }
  },

  async "duplicate-clicks"({ page, api, rng, fail, note }) {
    const id = `dup-${rng.int(1e6)}`;
    const clicks = rng.range(3, 8);
    await page.getByPlaceholder("analysis uuid").fill(id);
    // dispatched in-page so all k handlers run in one task (a true duplicate-call burst)
    await page.getByRole("button", { name: "Inspect analysis" }).evaluate((element, count) => {
      for (let i = 0; i < count; i += 1) (element as HTMLButtonElement).click();
    }, clicks);
    await expect
      .poll(() => api.served.filter((entry) => entry.startsWith(`analysis:${id}@`)).length)
      .toBe(clicks);
    await expect(outcomeCell(page)).toContainText(`(CODE-${id})`);
    note("duplicateClicks", clicks);
    if ((await page.getByText(/stress failure|HTTP 5/).count()) > 0) {
      fail("duplicate-clicks: an error is shown after identical concurrent requests");
    }
  },

  async "dashboard-window-race"({ page, api, rng, token, fail }) {
    const x = rng.range(10, 40);
    const y = rng.range(41, 90);
    const heldX = api.hold(`window:${x}`);
    const windowInput = page.getByLabel("window days");
    await windowInput.fill(String(x));
    await windowInput.fill(String(y));
    const expected = String(attemptsFor(y, token));
    await expect(attemptsCell(page)).toHaveText(expected);
    heldX.release();
    await expect
      .poll(() => api.served.filter((entry) => entry.startsWith(`dashboard:window:${x}@`)).length)
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(rng.range(50, 150));
    const shown = await attemptsCell(page).textContent();
    if (shown !== expected) {
      fail(
        `dashboard-window-race: window days input is ${y} but attempts shows ${shown} (expected ${expected})`,
      );
    }
  },

  async "logout-during-request"({ page, api, rng, fail }) {
    const id = `logout-${rng.int(1e6)}`;
    const held = api.hold(id);
    await inspectAnalysis(page, id);
    await page.getByPlaceholder(TOKEN_INPUT).fill("");
    await expect(page.getByText("Provide a token to load panels.")).toBeVisible();
    held.release();
    await expect
      .poll(() => api.served.filter((entry) => entry.startsWith(`analysis:${id}@`)).length)
      .toBe(1);
    await page.waitForTimeout(rng.range(50, 150));
    if ((await page.getByRole("heading", { level: 2, name: /Support diagnostics/ }).count()) > 0) {
      fail(
        "logout-during-request: a late response resurrected a panel after the token was cleared",
      );
    }
    if ((await outcomeCell(page).count()) > 0)
      fail("logout-during-request: report rendered while signed out");
  },

  async "rotation-during-request"({ page, api, rng, fail, note }) {
    const tokenA = `stress-token-a-${rng.range(100, 999)}`;
    const tokenB = `stress-token-b-${rng.range(100, 999)}`;
    const w = rng.range(2, 9);
    const heldW = api.hold(`window:${w}`);
    const tokenInput = page.getByPlaceholder(TOKEN_INPUT);
    await tokenInput.fill(tokenA);
    await page.getByLabel("window days").fill(String(w));
    await expect
      .poll(
        () =>
          api.served.filter((entry) => entry.startsWith(`dashboard:window:${w}@${tokenA}`)).length,
      )
      .toBeGreaterThanOrEqual(1);
    await tokenInput.fill(tokenB);
    // token B's own request for the held window is held as well; release both
    await expect
      .poll(
        () =>
          api.served.filter((entry) => entry.startsWith(`dashboard:window:${w}@${tokenB}`)).length,
      )
      .toBeGreaterThanOrEqual(1);
    heldW.release();
    const expected = String(attemptsFor(w, tokenB));
    await expect(attemptsCell(page)).toHaveText(expected);
    await page.waitForTimeout(rng.range(50, 150));
    const shown = await attemptsCell(page).textContent();
    note("rotation", { tokenA, tokenB, window: w });
    if (shown !== expected) {
      fail(
        `rotation-during-request: token is now B but the dashboard shows data fetched under A (${shown} ≠ ${expected})`,
      );
    }
  },
};

async function runSeed(page: Page, seed: number): Promise<IterationRow> {
  const startedAt = Date.now();
  const rng = createSeededRng(seed);
  const api = new MockAdminApi(rng);
  const failures: string[] = [];
  const notes: Record<string, unknown> = {};
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on("pageerror", onPageError);
  await page.route(/\/v1\//, api.handler);

  const token = `stress-token-${seed % 1000}`;
  const order = rng.shuffle(Object.keys(scenarios));
  const plan = { order, token };
  const signedIn = () => page.getByRole("heading", { level: 2, name: /Support diagnostics/ });
  try {
    await page.goto("/#/");
    await page.getByPlaceholder(TOKEN_INPUT).fill(token);
    await expect(signedIn()).toBeVisible();

    for (const name of order) {
      // every scenario starts from a signed-in console with the seed's token
      const tokenInput = page.getByPlaceholder(TOKEN_INPUT);
      if ((await tokenInput.inputValue()) !== token) {
        await tokenInput.fill(token);
        await expect(signedIn()).toBeVisible();
      }
      try {
        await scenarios[name]!({
          page,
          api,
          rng,
          token,
          fail: (message) => failures.push(message),
          note: (key, value) => (notes[key] = value),
        });
      } catch (error) {
        const firstLine = String(error).split("\n")[0] ?? "";
        failures.push(
          `${name}: ${firstLine.replace(new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g"), "")}`,
        );
      } finally {
        // a scenario that bailed early must not leave a held response to poison the next one
        api.releaseAll();
      }
    }
    if (pageErrors.length > 0) failures.push(`uncaught page errors: ${pageErrors.join(" | ")}`);
  } finally {
    api.releaseAll();
    await page.unroute(/\/v1\//);
    page.off("pageerror", onPageError);
  }
  notes["requestsServed"] = api.served.length;
  if (api.abandoned.length > 0) notes["abandonedRequests"] = api.abandoned;
  return {
    seed,
    outcome: failures.length === 0 ? "HELD" : "BROKEN",
    ms: Date.now() - startedAt,
    plan,
    failures,
    notes,
  };
}

test.describe("admin-web concurrency stress (seeded, mocked admin API)", () => {
  test.setTimeout(campaign.seeds.length * 60_000 + 30_000);

  test(`holds latest-wins / no-stale-paint / logout & rotation safety over ${campaign.seeds.length} seeded interleavings`, async ({
    page,
  }) => {
    const startedAtIso = new Date().toISOString();
    const rows: IterationRow[] = [];
    for (const seed of campaign.seeds) rows.push(await runSeed(page, seed));
    const table = summarize(
      "admin-web.browser.concurrency.stress",
      campaign.baseSeed,
      startedAtIso,
      rows,
    );
    const outPath = campaign.outPath ?? resolve(ARTIFACTS_DIR, "stress-concurrency.json");
    writeResultsTable(outPath, table);
    await test
      .info()
      .attach("stress-concurrency.json", { path: outPath, contentType: "application/json" });
    console.warn(
      `[stress] browser concurrency: ${table.held} HELD / ${table.broken} BROKEN over ${table.iterations} seeds × ${Object.keys(scenarios).length} scenarios (base ${campaign.baseSeed})` +
        (table.failedSeeds.length > 0 ? `; failing seeds: ${table.failedSeeds.join(",")}` : ""),
    );
    expect(
      rows
        .filter((row) => row.outcome !== "HELD")
        .map((row) => `seed ${row.seed}: ${row.failures.join(" | ")}`),
      "replay a failing seed with STRESS_ONLY_SEED=<seed>",
    ).toEqual([]);
  });
});
