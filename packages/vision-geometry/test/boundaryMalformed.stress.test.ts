import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { rng, scenarioSeed } from "./stress/boundaryMalformed/rng.js";
import {
  runCampaign,
  runIteration,
  type CampaignReport,
} from "./stress/boundaryMalformed/runner.js";
import { primeScenarios, SCENARIOS } from "./stress/boundaryMalformed/scenarios.js";

/**
 * Boundary/malformed-input stress campaign for @pickle/vision-geometry.
 *
 * Suite default: STRESS_ITER=12 seeds × 12 scenarios (fast). Full campaign:
 *   STRESS_ITER=300 STRESS_OUT=artifacts/stress-boundary/campaign.json \
 *     pnpm --filter @pickle/vision-geometry test -- boundaryMalformed
 * Replay one iteration with its input/output dumped to STRESS_OUT:
 *   STRESS_REPLAY=contact_estimator:17 STRESS_OUT=/tmp/replay.json pnpm --filter …
 *
 * Every violation is a contract breach: a malformed input must produce a
 * typed outcome (Result failure / abstention / UNKNOWN) — never a throw,
 * never NaN/Infinity in the output, never a mutated argument or polluted
 * prototype — and the same seed must replay identically.
 *
 * Reproduced defects are catalogued in `stress/boundaryMalformed/knownGaps.ts`
 * and pinned by `boundaryMalformed.knownGaps.test.ts`; violations a catalogue
 * entry explains stay BROKEN in the report but do not fail this test — only an
 * unexplained violation (a new defect) does.
 */

const ITERATIONS = Number.parseInt(process.env.STRESS_ITER ?? "12", 10);
const OUT = process.env.STRESS_OUT;
const REPLAY = process.env.STRESS_REPLAY;
/** Comma-separated scenario ids to restrict the campaign (default: all). */
const ONLY = process.env.STRESS_SCENARIO?.split(",").filter(Boolean);
const VERBOSE = process.env.STRESS_VERBOSE === "1";
/** Comma-separated replay handles to re-run STRESS_RERUN_N times (flake check). */
const RERUN = process.env.STRESS_RERUN?.split(",").filter(Boolean) ?? [];
const RERUN_N = Number.parseInt(process.env.STRESS_RERUN_N ?? "10", 10);

function writeJson(path: string, value: unknown): string {
  const absolute = resolve(process.cwd(), path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(value, null, 2));
  return absolute;
}

describe("stress: boundary/malformed inputs (seeded, replayable)", () => {
  beforeAll(async () => {
    await primeScenarios();
  });

  if (REPLAY) {
    it(`replays ${REPLAY}`, async () => {
      const [scenarioId, seedText] = REPLAY.split(":");
      const scenario = SCENARIOS.find((entry) => entry.id === scenarioId);
      expect(scenario, `unknown scenario ${String(scenarioId)}`).toBeDefined();
      const seed = Number.parseInt(seedText ?? "1", 10);
      if (process.env.STRESS_DRY === "1") {
        const built = scenario!.build(rng(scenarioSeed(scenario!.id, seed)), seed);
        console.warn(JSON.stringify(built.mutations, null, 2));
        return;
      }
      const detail = await runIteration(scenario!, seed);
      if (OUT) writeJson(OUT, detail);
      console.warn(JSON.stringify({ ...detail, input: detail.input.slice(0, 4000) }, null, 2));
    });
    return;
  }

  if (RERUN.length > 0) {
    it(
      `re-runs ${RERUN.length} replay handle(s) ${RERUN_N}× and reports the failure rate`,
      async () => {
        const rows: Array<{
          replay: string;
          runs: number;
          broken: number;
          rate: number;
          outcomes: string[];
          violations: string[];
          mutations: unknown;
        }> = [];
        for (const handle of RERUN) {
          const [scenarioId, seedText] = handle.split(":");
          const scenario = SCENARIOS.find((entry) => entry.id === scenarioId);
          expect(scenario, `unknown scenario ${String(scenarioId)}`).toBeDefined();
          const seed = Number.parseInt(seedText ?? "1", 10);
          const outcomes: string[] = [];
          const violations = new Set<string>();
          let mutations: unknown = null;
          for (let run = 0; run < RERUN_N; run += 1) {
            const detail = await runIteration(scenario!, seed);
            outcomes.push(detail.outcome);
            for (const violation of detail.violations) violations.add(violation);
            mutations = detail.mutations;
          }
          const broken = outcomes.filter((outcome) => outcome === "broken").length;
          rows.push({
            replay: handle,
            runs: RERUN_N,
            broken,
            rate: broken / RERUN_N,
            outcomes,
            violations: [...violations].sort(),
            mutations,
          });
        }
        if (OUT) writeJson(OUT, rows);
        for (const row of rows) console.warn(`${row.replay} broken ${row.broken}/${row.runs}`);
        // Every rerun of a handle must agree — a flaky boundary defect is a second defect.
        for (const row of rows) expect(new Set(row.outcomes).size, `${row.replay} flaky`).toBe(1);
      },
      20 * 60 * 1000,
    );
    return;
  }

  const selected = ONLY ? SCENARIOS.filter((scenario) => ONLY.includes(scenario.id)) : SCENARIOS;

  it(
    `holds the boundary contract over ${ITERATIONS} seeds × ${selected.length} scenarios`,
    async () => {
      const report: CampaignReport = await runCampaign(selected, ITERATIONS, (record) => {
        if (VERBOSE) {
          console.warn(
            `${record.replay} ${record.outcome} ${record.durationMs}ms ${record.result}${
              record.violations.length ? ` :: ${record.violations.join(" | ")}` : ""
            }`,
          );
        }
      });
      if (OUT) {
        const path = writeJson(OUT, report);
        console.warn(
          `stress report → ${path} (${report.executed} executed, ${report.held} held, ${report.broken} broken [${report.brokenUnexplained} unexplained], ${report.typeViolation} type_violation, ${report.hazard} hazard)`,
        );
      }
      expect(report.executed).toBeGreaterThan(0);
      for (const scenario of report.scenarios) expect(scenario.executed).toBeGreaterThan(0);

      const unexplained = report.records.filter((record) => record.unexplained.length > 0);
      expect(
        unexplained.map((record) => `${record.replay} ${record.unexplained.join(" | ")}`),
      ).toEqual([]);
      expect(report.brokenUnexplained).toBe(0);
    },
    20 * 60 * 1000,
  );
});
