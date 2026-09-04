/**
 * Long-run-leak stress campaign for @pickle/shared-types (lens `long-run-leak`).
 *
 * Default: STRESS_ITER=20 iterations so the file stays cheap in the suite.
 * Full campaign (what the report cites):
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=600 STRESS_OUT=/tmp/shared-types.json \
 *     pnpm --filter @pickle/shared-types exec vitest run test/longRunLeak.stress.test.ts
 * Replay one seed from the table:
 *   STRESS_REPLAY_SEED=<seed> pnpm --filter @pickle/shared-types exec vitest run \
 *     test/longRunLeak.stress.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_RETENTION_POLICY_V1, retentionDeadline } from "../src/index.js";
import {
  HEAP_SLOPE_BUDGET_PERCENT_PER_100,
  TIME_DRIFT_BUDGET_RATIO,
  collectNonFinite,
  fingerprint,
  noopScenario,
  readCampaignEnv,
  runCampaign,
  seedTable,
} from "../stress/long-run-leak/campaign.js";
import { sharedTypesScenario } from "../stress/long-run-leak/sharedTypesScenario.js";

const env = readCampaignEnv();
const fullCampaign = env.iterations >= 500;

/**
 * Reproduced defect the campaign keeps exercising (see the `it.fails` repro
 * below). Rows carrying ONLY these violations are still BROKEN in the JSON
 * table; the suite assertion excludes exactly this pattern so any other
 * violation fails the file. Delete both once retentionDeadline is fixed.
 */
const KNOWN_DEFECT_PATTERNS: readonly RegExp[] = [
  /^retention: invalid deadline for \w+ days=1000000000$/,
  /^non-finite output at \$\.retention\[\d+\]\.deadline = InvalidDate$/,
];
const isKnownDefect = (violation: string): boolean =>
  KNOWN_DEFECT_PATTERNS.some((pattern) => pattern.test(violation));

describe("shared-types long-run-leak campaign", () => {
  it(
    `holds every property across ${env.iterations} seeded iterations`,
    { timeout: 10 * 60 * 1000 },
    () => {
      // Harness floor first: same loop, no unit code, so the unit's heap slope
      // can be read net of what the campaign itself retains.
      const control = runCampaign({
        name: "control-noop",
        baseSeed: env.baseSeed,
        iterations: env.iterations,
        sampleEvery: env.sampleEvery,
        warmupIterations: Math.min(100, env.iterations),
        scenario: noopScenario,
      });
      const report = runCampaign({
        name: "shared-types",
        baseSeed: env.baseSeed,
        iterations: env.iterations,
        sampleEvery: env.sampleEvery,
        warmupIterations: Math.min(100, env.iterations),
        scenario: sharedTypesScenario,
      });
      if (env.outPath) {
        mkdirSync(dirname(env.outPath), { recursive: true });
        writeFileSync(
          env.outPath,
          JSON.stringify(
            {
              ...report,
              seedTable: seedTable(report),
              control: { heapAnalysis: control.heapAnalysis, heapSamples: control.heapSamples },
            },
            null,
            2,
          ),
        );
      }
      console.log(
        "SHARED_TYPES_LONG_RUN_LEAK " +
          JSON.stringify({
            iterations: report.iterations,
            gcAvailable: report.gcAvailable,
            wallMs: report.wallMs,
            heapAnalysis: report.heapAnalysis,
            controlHeapAnalysis: control.heapAnalysis,
            timingDrift: report.timingDrift,
            handleDelta: report.handleDelta,
            listenerDelta: report.listenerDelta,
            statsTotals: report.statsTotals,
            verdicts: report.verdicts,
          }),
      );

      const broken = report.rows.filter((row) => row.violations.some((v) => !isKnownDefect(v)));
      expect(
        broken.map((row) => `seed ${row.seed}: ${row.violations.join(" | ")}`),
        "BROKEN seeds (beyond the known retention defect)",
      ).toEqual([]);
      expect(report.verdicts.deterministic, "same seed → same fingerprint").toBe(true);
      expect(
        report.nonFinitePaths.filter((hit) => !/^\$\.retention\[\d+\]\.deadline$/.test(hit.path)),
        "NaN/Infinity in outputs (beyond the known retention defect)",
      ).toEqual([]);
      expect(report.handleDelta, "active handles back to baseline").toEqual({});
      expect(report.listenerDelta, "process listeners back to baseline").toEqual({});
      expect(report.statsTotals.voiceCorpus).toBeGreaterThan(0);

      if (fullCampaign) {
        // The assignment's campaign is only meaningful with a forced GC before
        // each heap sample; without --expose-gc it is not a pass.
        expect(report.gcAvailable, "run with NODE_OPTIONS=--expose-gc").toBe(true);
        expect(report.heapAnalysis.steadySamples).toBeGreaterThanOrEqual(3);
        expect(
          report.heapAnalysis.steadySlopePercentPer100Iterations,
          "steady-state heap slope % per 100 iterations",
        ).toBeLessThanOrEqual(HEAP_SLOPE_BUDGET_PERCENT_PER_100);
        expect(report.timingDrift.ratio, "final/first steady bucket p50 ratio").not.toBeNull();
        expect(report.timingDrift.ratio ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          TIME_DRIFT_BUDGET_RATIO,
        );
      }
    },
  );

  // Minimised from campaign seed 3546299114 (STRESS_SEED=20260904): a
  // user_controlled window of 1e9 days (well inside the int4 column range of
  // user_setting.local_video_retention_days) overflows the ECMAScript Date
  // range, so retentionDeadline returns an Invalid Date instead of null.
  // `it.fails` documents the desired contract; it errors once the defect is
  // fixed so the KNOWN_DEFECT_PATTERNS allowance above gets removed with it.
  it.fails("retentionDeadline returns null or a valid Date for any integer window", () => {
    const deadline = retentionDeadline(
      MEDIA_RETENTION_POLICY_V1.rules.raw_video,
      new Date("2026-01-01T00:00:00.000Z"),
      1_000_000_000,
    );
    expect(deadline === null || Number.isFinite(deadline.getTime())).toBe(true);
  });

  it.runIf(env.replaySeed !== null)("replays one recorded seed", () => {
    const seed = env.replaySeed ?? 0;
    const first = sharedTypesScenario(seed);
    const second = sharedTypesScenario(seed);
    console.log(
      "SHARED_TYPES_REPLAY " +
        JSON.stringify({
          seed,
          fingerprint: fingerprint(first.outputs),
          violations: first.violations,
          stats: first.stats,
          nonFinite: collectNonFinite(first.outputs),
        }),
    );
    expect(fingerprint(first.outputs)).toBe(fingerprint(second.outputs));
    expect(first.violations.filter((v) => !isKnownDefect(v))).toEqual([]);
  });
});
