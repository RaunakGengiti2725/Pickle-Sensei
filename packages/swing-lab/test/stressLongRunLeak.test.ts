/**
 * Long-run leak stress campaign over swing-lab (classifiers, trackers, OOD
 * gate, coach gates, paddle worker lifecycle).
 *
 * Every unit is invoked STRESS_ITER times in this one process; the heap is
 * sampled after a forced GC every 50 iterations together with active
 * resources (`process.getActiveResourcesInfo()`) and process listener
 * counts, and every invocation is timed. Every row is replayable:
 *
 *   STRESS_ITER=500 STRESS_SEED=<campaignSeed> NODE_OPTIONS=--expose-gc \
 *     pnpm --filter @pickle/swing-lab exec vitest run test/stressLongRunLeak.test.ts
 *
 * Set STRESS_OUT=<dir> to write `<unit>.json` (seed → outcome table plus
 * checkpoints and verdicts) and `summary.json`. Default STRESS_ITER is small
 * so the suite stays fast; the campaign scale is 500.
 *
 * Replay ONE row from a table (its `seed` column), e.g. a failing one:
 *
 *   STRESS_UNIT=ball-tracker STRESS_REPLAY_SEED=<rowSeed> STRESS_REPLAY_TIMES=10 \
 *     pnpm --filter @pickle/swing-lab exec vitest run test/stressLongRunLeak.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEAK_SLOPE_PCT_PER_100,
  TIME_DRIFT_RATIO,
  replayIteration,
  runLongRunCampaign,
  type CampaignReport,
} from "./stress/leakHarness.js";
import { ALL_UNITS } from "./stress/units.js";

const ITERATIONS = Math.max(1, Number(process.env["STRESS_ITER"] ?? 60));
const CAMPAIGN_SEED = Number(process.env["STRESS_SEED"] ?? 20260904) >>> 0;
const OUT_DIR = process.env["STRESS_OUT"] ?? null;
const UNIT_FILTER = process.env["STRESS_UNIT"] ?? null;
const REPLAY_SEED = process.env["STRESS_REPLAY_SEED"];
const REPLAY_TIMES = Math.max(1, Number(process.env["STRESS_REPLAY_TIMES"] ?? 1));
// Spawning a child process per iteration dominates: budget generously.
const TIMEOUT_MS = 60_000 + ITERATIONS * 400;

const summaries: Array<Omit<CampaignReport, "rows" | "checkpoints" | "baseline">> = [];

function persist(report: CampaignReport) {
  const { rows: _rows, checkpoints: _checkpoints, baseline: _baseline, ...summary } = report;
  summaries.push(summary);
  if (!OUT_DIR) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${report.unit}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`);
}

const selectedUnits = UNIT_FILTER ? ALL_UNITS.filter((unit) => unit.id === UNIT_FILTER) : ALL_UNITS;

if (REPLAY_SEED !== undefined) {
  describe(`replay row seed ${REPLAY_SEED}`, () => {
    for (const unit of selectedUnits) {
      it(`${unit.id}: seed ${REPLAY_SEED} x${REPLAY_TIMES} passes and hashes identically`, async () => {
        const seed = Number(REPLAY_SEED) >>> 0;
        await unit.setup?.();
        try {
          const rows = [];
          for (let run = 0; run < REPLAY_TIMES; run += 1)
            rows.push(await replayIteration(unit, seed));
          const failures = rows.filter((row) => row.outcome === "fail");
          expect(
            failures.map((row) => row.detail),
            `${unit.id}: seed ${seed} failed ${failures.length}/${rows.length}`,
          ).toEqual([]);
          expect(new Set(rows.map((row) => row.hash)).size, "distinct output hashes").toBe(1);
        } finally {
          await unit.teardown?.();
        }
      });
    }
  });
} else {
  describe(`long-run leak campaign (${ITERATIONS} iterations/unit, seed ${CAMPAIGN_SEED})`, () => {
    const units = selectedUnits;
    expect(units.length).toBeGreaterThan(0);

    for (const unit of units) {
      it(
        `${unit.id}: no failures, deterministic, resources at baseline, heap slope <= ${LEAK_SLOPE_PCT_PER_100}%/100, no time drift > ${TIME_DRIFT_RATIO}x`,
        async () => {
          const report = await runLongRunCampaign(unit, {
            iterations: ITERATIONS,
            campaignSeed: CAMPAIGN_SEED,
            checkpointEvery: 50,
            replaySeeds: 10,
          });
          persist(report);

          expect(report.executed).toBe(ITERATIONS);
          const failed = report.rows.filter((row) => row.outcome === "fail");
          expect(
            failed.map((row) => `seed ${row.seed}: ${row.detail}`),
            `${unit.id}: failing seeds`,
          ).toEqual([]);
          expect(
            report.determinism.mismatches,
            `${unit.id}: same seed must replay identically`,
          ).toEqual([]);
          // Bounded abstention: the unit must commit for SOME seeded input (an
          // always-abstaining unit is a dead path), rate itself is reported.
          expect(report.abstentionRate, `${unit.id}: abstention rate`).toBeLessThan(1);
          expect(
            report.resources.leaked,
            `${unit.id}: active resources / listeners must return to baseline (delta ${JSON.stringify(report.resources.finalDelta)})`,
          ).toEqual({});
          expect(
            report.heap.verdict,
            `${unit.id}: heap slope ${report.heap.slopePctPer100.toFixed(2)}%/100 iterations (monotone=${report.heap.monotone})`,
          ).not.toBe("leak");
          expect(
            report.time.verdict,
            `${unit.id}: invocation time ratio last/first block ${report.time.ratio.toFixed(2)}`,
          ).not.toBe("drift");
        },
        TIMEOUT_MS,
      );
    }
  });
}
