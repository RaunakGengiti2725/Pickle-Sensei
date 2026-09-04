import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CAMPAIGNS,
  DEFAULT_OUT_DIR,
  digest,
  runCampaign,
  summarize,
  writeReport,
  type CampaignSummary,
  type StressRow,
} from "./campaign.js";

/**
 * LENS boundary-malformed — seeded stress campaigns for @pickle/queue.
 *
 * `STRESS_ITER` (default 150) iterations PER campaign (three campaigns: the
 * in-memory queue, SQS wire-body decoding, SQS producer encoding).
 * `STRESS_SEED` (default 20260904) picks the seed base; the row for iteration
 * i uses `seedFor(campaign, STRESS_SEED, i)` and is replayable alone via
 * `replay(campaign, seed)`. `STRESS_OUT` overrides the artifact directory
 * (default artifacts/stress/pkg-queue-boundary-malformed at the repo root).
 *
 * Full campaign: STRESS_ITER=1000 pnpm --filter @pickle/queue test -- stress
 *
 * The SQS SDK client is replaced by the in-process fake broker; the real
 * ElasticMQ wire is covered by boundaryMalformed.elasticmq.test.ts.
 *
 * A row is BROKEN when a hard invariant fails. Failures already reproduced
 * and pinned by boundaryMalformed.knownGaps.test.ts are tagged with a gapId
 * and tolerated here (they would otherwise hide new failures behind a red
 * suite); any BROKEN row WITHOUT a gapId fails the test.
 */

vi.mock("@aws-sdk/client-sqs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sqs")>();
  const { FakeSQSClient } = await import("./fakeBroker.js");
  return { ...actual, SQSClient: FakeSQSClient };
});

const ITER = Math.max(1, Number.parseInt(process.env["STRESS_ITER"] ?? "150", 10) || 150);
const SEED = Number.parseInt(process.env["STRESS_SEED"] ?? "20260904", 10) || 20260904;
const OUT_DIR = process.env["STRESS_OUT"] ?? DEFAULT_OUT_DIR;
const CAMPAIGN_NAMES = Object.keys(CAMPAIGNS);

function assertFiniteNumbers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteNumbers(entry, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertFiniteNumbers(entry, `${path}.${key}`);
  }
}

describe(`boundary-malformed stress (STRESS_ITER=${ITER}, STRESS_SEED=${SEED})`, () => {
  const results = new Map<string, { rows: StressRow[]; summary: CampaignSummary; ms: number }>();

  it.each(CAMPAIGN_NAMES)(
    "%s campaign: no unclassified BROKEN rows",
    async (campaign) => {
      const started = performance.now();
      const rows = await runCampaign(campaign, SEED, ITER);
      const ms = performance.now() - started;
      const summary = summarize(campaign, SEED, rows);
      results.set(campaign, { rows, summary, ms });
      const { rowsPath } = writeReport(
        OUT_DIR,
        `${campaign}.seed${SEED}.iter${ITER}`,
        rows,
        summary,
      );

      expect(rows).toHaveLength(ITER);
      expect(new Set(rows.map((row) => row.seed)).size, "seeds must be unique").toBe(ITER);
      assertFiniteNumbers(summary, `${campaign}.summary`);
      for (const row of rows) {
        expect(typeof row.seed).toBe("number");
        expect(Number.isInteger(row.seed)).toBe(true);
        expect(["HELD", "BROKEN"]).toContain(row.outcome);
      }

      const unclassified = rows.filter((row) => row.outcome === "BROKEN" && !row.gapId);
      expect(
        unclassified,
        `new BROKEN rows in ${rowsPath}: ${JSON.stringify(unclassified.slice(0, 5), null, 2)}`,
      ).toHaveLength(0);
    },
    120_000,
  );

  it.each(CAMPAIGN_NAMES)("%s campaign: same seed → identical outcomes", async (campaign) => {
    const first = results.get(campaign);
    expect(first, "campaign must have run").toBeDefined();
    if (!first) return;
    const replayCount = Math.min(ITER, 200);
    const again = await runCampaign(campaign, SEED, replayCount);
    expect(digest(again)).toBe(digest(first.rows.slice(0, replayCount)));
    for (let index = 0; index < replayCount; index += 1) {
      const original = first.rows[index];
      const replayed = again[index];
      expect(replayed?.seed).toBe(original?.seed);
      expect(replayed?.category).toBe(original?.category);
      expect(replayed?.outcome).toBe(original?.outcome);
      expect(replayed?.violations).toEqual(original?.violations);
    }
  });

  it("writes an aggregate summary with an honest executed-scenario count", () => {
    expect(results.size).toBe(CAMPAIGN_NAMES.length);
    const campaigns = [...results.values()].map((entry) => ({
      ...entry.summary,
      wallMs: Math.round(entry.ms),
    }));
    const aggregate = {
      lens: "boundary-malformed",
      unit: "pkg-queue",
      seedBase: SEED,
      iterationsPerCampaign: ITER,
      scenariosExecuted: campaigns.reduce((total, entry) => total + entry.iterations, 0),
      held: campaigns.reduce((total, entry) => total + entry.held, 0),
      brokenKnownGap: campaigns.reduce((total, entry) => total + entry.brokenKnownGap, 0),
      brokenNew: campaigns.reduce((total, entry) => total + entry.brokenNew, 0),
      campaigns,
    };
    assertFiniteNumbers(aggregate, "aggregate");
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      resolve(OUT_DIR, `aggregate.seed${SEED}.iter${ITER}.json`),
      JSON.stringify(aggregate, null, 2),
    );
    expect(aggregate.scenariosExecuted).toBe(ITER * CAMPAIGN_NAMES.length);
    expect(aggregate.brokenNew).toBe(0);
  });
});
