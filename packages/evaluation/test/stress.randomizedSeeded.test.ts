/**
 * Seeded randomized model check over the `@pickle/evaluation` public API
 * (lens: randomized-seeded, unit: pkg-evaluation). See test/stress/model.ts
 * for the action grammar and invariants I1-I9.
 *
 * Default campaign is small so it lives in the suite; scale it with
 *   STRESS_ITER=2000 STRESS_SEED_BASE=20260904 pnpm --filter @pickle/evaluation test
 * or run test/stress/campaign.ts directly for a JSON results table.
 */
import { describe, expect, it } from "vitest";
import { runCampaign } from "./stress/campaign.js";
import {
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  committedFixtures,
  executeSequence,
  generateActions,
  runSeed,
  shrinkFailure,
  shrinkSteps,
  type Step,
} from "./stress/model.js";
import { SeededRng, deriveSeed, digest } from "./stress/seededRng.js";

const ITERATIONS = Number.parseInt(process.env.STRESS_ITER ?? "24", 10);
const SEED_BASE = Number.parseInt(process.env.STRESS_SEED_BASE ?? "20260904", 10) >>> 0;

function describeFailure(row: {
  seed: number;
  failure: { message: string; step: number } | null;
  minimized: { length: number } | null;
}): string {
  return `seed ${row.seed} step ${row.failure?.step ?? "?"} (minimized to ${row.minimized?.length ?? "?"} steps): ${row.failure?.message ?? "nondeterministic trace"}`;
}

describe("stress: seeded randomized sequences over the evaluation public API", () => {
  it("committed baseline + tolerances validate and compare clean against themselves", () => {
    const { baseline, config } = committedFixtures();
    const outcome = executeSequence(1, "committed", [
      { rngSeed: 1, action: { kind: "summary.resetCandidate" } },
      { rngSeed: 2, action: { kind: "violations.select", count: 3, includeUnknown: true } },
      { rngSeed: 3, action: { kind: "swing.setOverrides", overrides: {} } },
      { rngSeed: 4, action: { kind: "manifest.addCases", n: 5, players: 2 } },
      { rngSeed: 5, action: { kind: "metrics.addCalibration", n: 12, mode: "uniform" } },
    ]);
    expect(outcome.failure).toBeNull();
    expect(outcome.steps).toBe(5);
    expect(Object.keys(config.metrics).length).toBeGreaterThan(0);
    expect(baseline.benches.length).toBeGreaterThan(0);
  });

  it("generates replayable sequences of length 5..60 whose steps are a pure function of the seed", () => {
    const rng = new SeededRng(0xc0ffee);
    for (let index = 0; index < 200; index += 1) {
      const seed = rng.int(0, 0xffffffff);
      const a = generateActions(seed);
      const b = generateActions(seed);
      expect(a.steps.length).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
      expect(a.steps.length).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
      expect(digest(a)).toBe(digest(b));
    }
  });

  it("the shrinker finds a minimal failing subsequence (harness self-check)", () => {
    const isMarker = (step: Step): boolean =>
      step.action.kind === "metrics.setBinCount" && step.action.binCount === 3;
    const steps = generateActions(deriveSeed(SEED_BASE, 0)).steps.filter((step) => !isMarker(step));
    const marker: Step = { rngSeed: 7, action: { kind: "metrics.setBinCount", binCount: 3 } };
    const withMarker = [...steps.slice(0, 20), marker, ...steps.slice(20)];
    const fails = (candidate: Step[]): boolean => candidate.some(isMarker);
    const shrunk = shrinkSteps(withMarker, fails);
    expect(shrunk).toEqual([marker]);
    // A sequence that does not fail is returned intact by shrinkFailure.
    const seed = deriveSeed(SEED_BASE, 0);
    const { start, steps: full } = generateActions(seed);
    expect(executeSequence(seed, start, full).ok).toBe(true);
    expect(shrinkFailure(seed, start, full, "none")).toEqual(full);
  });

  it(`holds I1-I9 across ${ITERATIONS} seeded sequences and replays every seed deterministically`, () => {
    const result = runCampaign({ iterations: ITERATIONS, seedBase: SEED_BASE, reruns: 3 });
    expect(result.scenariosExecuted).toBe(ITERATIONS);
    const failures = result.rows.filter((row) => row.outcome !== "ok");
    expect(failures.map(describeFailure), "failing seeds").toEqual([]);
    expect(result.nondeterministicSeeds).toEqual([]);
    for (const row of result.rows) {
      expect(row.stepsCompleted).toBe(row.length);
      expect(row.replayDigest).toBe(row.traceDigest);
    }
  }, 600_000);

  it("replays a single seed on demand (STRESS_REPLAY_SEED)", () => {
    const raw = process.env.STRESS_REPLAY_SEED;
    if (!raw) return;
    const outcome = runSeed(Number.parseInt(raw, 10) >>> 0);
    expect(outcome.failure, JSON.stringify(outcome.failure, null, 2)).toBeNull();
  });
});
