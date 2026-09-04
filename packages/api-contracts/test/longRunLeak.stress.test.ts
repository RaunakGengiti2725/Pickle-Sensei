/**
 * Long-run-leak stress campaign for @pickle/api-contracts (lens `long-run-leak`).
 *
 * Default: STRESS_ITER=20 iterations so the file stays cheap in the suite.
 * Full campaign (what the report cites):
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=600 STRESS_OUT=/tmp/api-contracts.json \
 *     pnpm --filter @pickle/api-contracts exec vitest run test/longRunLeak.stress.test.ts
 * Replay one seed from the table:
 *   STRESS_REPLAY_SEED=<seed> pnpm --filter @pickle/api-contracts exec vitest run \
 *     test/longRunLeak.stress.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEAP_SLOPE_BUDGET_PERCENT_PER_100,
  TIME_DRIFT_BUDGET_RATIO,
  collectNonFinite,
  fingerprint,
  noopScenario,
  readCampaignEnv,
  runCampaign,
  seedTable,
} from "../../shared-types/stress/long-run-leak/campaign.js";
import { apiContractsScenario } from "../stress/long-run-leak/apiContractsScenario.js";

const env = readCampaignEnv();
const fullCampaign = env.iterations >= 500;

describe("api-contracts long-run-leak campaign", () => {
  it(
    `holds every property across ${env.iterations} seeded iterations`,
    { timeout: 10 * 60 * 1000 },
    () => {
      const control = runCampaign({
        name: "control-noop",
        baseSeed: env.baseSeed,
        iterations: env.iterations,
        sampleEvery: env.sampleEvery,
        warmupIterations: Math.min(100, env.iterations),
        scenario: noopScenario,
      });
      const report = runCampaign({
        name: "api-contracts",
        baseSeed: env.baseSeed,
        iterations: env.iterations,
        sampleEvery: env.sampleEvery,
        warmupIterations: Math.min(100, env.iterations),
        scenario: apiContractsScenario,
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
        "API_CONTRACTS_LONG_RUN_LEAK " +
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

      const broken = report.rows.filter((row) => row.outcome === "BROKEN");
      expect(
        broken.map((row) => `seed ${row.seed}: ${row.violations.join(" | ")}`),
        "BROKEN seeds",
      ).toEqual([]);
      expect(report.verdicts.deterministic, "same seed → same fingerprint").toBe(true);
      expect(report.nonFinitePaths, "NaN/Infinity in outputs").toEqual([]);
      expect(report.handleDelta, "active handles back to baseline").toEqual({});
      expect(report.listenerDelta, "process listeners back to baseline").toEqual({});
      expect(report.statsTotals.shotParses).toBeGreaterThan(0);
      expect(report.statsTotals.openApiBytes).toBeGreaterThan(0);

      if (fullCampaign) {
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

  it.runIf(env.replaySeed !== null)("replays one recorded seed", () => {
    const seed = env.replaySeed ?? 0;
    const first = apiContractsScenario(seed);
    const second = apiContractsScenario(seed);
    console.log(
      "API_CONTRACTS_REPLAY " +
        JSON.stringify({
          seed,
          fingerprint: fingerprint(first.outputs),
          violations: first.violations,
          stats: first.stats,
          nonFinite: collectNonFinite(first.outputs),
        }),
    );
    expect(fingerprint(first.outputs)).toBe(fingerprint(second.outputs));
    expect(first.violations).toEqual([]);
  });
});
