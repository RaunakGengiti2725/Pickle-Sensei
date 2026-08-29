import { describe, expect, it } from "vitest";
import {
  HEALTH_METRIC_IDS,
  FROZEN_HEALTH_CRITERIA_V1,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  forceRollback,
  isTerminal,
  type HealthInputs,
  type HealthMetricId,
  type MetricObservation,
  type RolloutState,
} from "../src/index.js";

/**
 * PROPERTIES over randomized health-window sequences:
 *
 * 1. SAFETY — exposure never increases on a window that is not overall
 *    HEALTHY. An unhealthy or non-evaluable metric (breach, missing data,
 *    thin samples, NaN) can never promote.
 * 2. ROLLBACK — whenever a rollout ends rolled_back, the active version is
 *    exactly the known-good predecessor recorded at creation, exposure is
 *    0%, and the state is terminal.
 * 3. LADDER — the stage only ever moves to the next rung of the frozen
 *    ladder (promote), stays (pause/resume bookkeeping), or drops to 0
 *    (rollback); it never skips a rung upward.
 *
 * Deterministic seeded LCG so the sweep is reproducible.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const criterionFor = (id: HealthMetricId) => {
  const criterion = FROZEN_HEALTH_CRITERIA_V1.metrics.find((m) => m.id === id);
  if (criterion === undefined) throw new Error(`Missing criterion for ${id}`);
  return criterion;
};

/** A random observation: absent, thin, malformed, breached, or in-range. */
function randomObservation(id: HealthMetricId, rand: () => number): MetricObservation | null {
  const criterion = criterionFor(id);
  const roll = rand();
  if (roll < 0.15) return null;
  if (roll < 0.3) {
    return {
      value: criterion.threshold,
      sampleCount: Math.floor(rand() * criterion.minSampleCount),
    };
  }
  if (roll < 0.35) return { value: Number.NaN, sampleCount: criterion.minSampleCount };
  const samples = criterion.minSampleCount + Math.floor(rand() * 500);
  const breach = rand() < 0.4;
  const magnitude = rand() * criterion.threshold;
  const value =
    criterion.direction === "at_most"
      ? breach
        ? criterion.threshold + magnitude + Number.EPSILON
        : rand() * criterion.threshold
      : breach
        ? Math.max(0, criterion.threshold - magnitude - Number.EPSILON)
        : criterion.threshold + rand() * (1 - criterion.threshold);
  return { value, sampleCount: samples };
}

function randomInputs(rand: () => number): HealthInputs {
  const entries = HEALTH_METRIC_IDS.map((id) => [id, randomObservation(id, rand)] as const);
  return Object.fromEntries(entries) as Record<HealthMetricId, MetricObservation | null>;
}

function freshRollout(runId: number): RolloutState {
  return createRollout({
    rolloutId: `prop-${runId}`,
    modelId: "scorer.sm-v1",
    candidateVersion: "candidate-v2",
    knownGoodVersion: "known-good-v1",
    nowMs: 0,
  });
}

const RUNS = 300;
const WINDOWS_PER_RUN = 12;

describe("rollout safety properties", () => {
  it("never increases exposure on a window that is not overall HEALTHY", () => {
    const rand = lcg(0xc0ffee);
    for (let run = 0; run < RUNS; run += 1) {
      let state = freshRollout(run);
      for (let step = 0; step < WINDOWS_PER_RUN && !isTerminal(state); step += 1) {
        const inputs = randomInputs(rand);
        const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
        const before = state.stagePercent;
        state = applyHealthWindow(state, inputs, step + 1);
        if (report.overall !== "HEALTHY") {
          expect(state.stagePercent).toBeLessThanOrEqual(before);
          expect(state.status === "complete").toBe(false);
        }
        if (report.overall === "NOT_EVALUABLE") {
          expect(state.status).toBe("paused");
          expect(state.stagePercent).toBe(before);
        }
        if (report.overall === "UNHEALTHY") {
          expect(state.status).toBe("rolled_back");
        }
      }
    }
  });

  it("a window with ANY absent metric can never promote (absent is never healthy)", () => {
    const rand = lcg(0xbadcafe);
    for (let run = 0; run < RUNS; run += 1) {
      let state = freshRollout(run);
      for (let step = 0; step < WINDOWS_PER_RUN && !isTerminal(state); step += 1) {
        const inputs = randomInputs(rand);
        const dropIndex = Math.floor(rand() * HEALTH_METRIC_IDS.length);
        const dropped = HEALTH_METRIC_IDS[dropIndex];
        if (dropped === undefined) throw new Error("unreachable");
        const withGap: HealthInputs = { ...inputs, [dropped]: null };
        const before = state.stagePercent;
        state = applyHealthWindow(state, withGap, step + 1);
        expect(state.stagePercent).toBeLessThanOrEqual(before);
        expect(state.status === "complete").toBe(false);
      }
    }
  });

  it("rollback — health-driven or kill switch — always lands on the recorded predecessor", () => {
    const rand = lcg(0x5eed);
    for (let run = 0; run < RUNS; run += 1) {
      let state = freshRollout(run);
      for (let step = 0; step < WINDOWS_PER_RUN && !isTerminal(state); step += 1) {
        state =
          rand() < 0.1
            ? forceRollback(state, step + 1)
            : applyHealthWindow(state, randomInputs(rand), step + 1);
      }
      if (state.status === "rolled_back") {
        expect(state.activeVersion).toBe("known-good-v1");
        expect(state.stagePercent).toBe(0);
        expect(() => applyHealthWindow(state, randomInputs(rand), 999)).toThrow(/terminal/);
      }
      if (state.status === "complete") {
        expect(state.activeVersion).toBe("candidate-v2");
      }
      if (!isTerminal(state)) {
        // Still mid-rollout: the candidate must not yet own all traffic.
        expect(state.activeVersion).toBe("known-good-v1");
      }
    }
  });

  it("the stage ladder is never skipped upward and transitions log every move", () => {
    const rand = lcg(0xfeed5);
    const ladder: readonly number[] = ROLLOUT_STAGES_V1;
    for (let run = 0; run < RUNS; run += 1) {
      let state = freshRollout(run);
      for (let step = 0; step < WINDOWS_PER_RUN && !isTerminal(state); step += 1) {
        state = applyHealthWindow(state, randomInputs(rand), step + 1);
      }
      for (let i = 1; i < state.transitions.length; i += 1) {
        const prev = state.transitions[i - 1];
        const curr = state.transitions[i];
        if (prev === undefined || curr === undefined) throw new Error("unreachable");
        expect(curr.seq).toBe(prev.seq + 1);
        expect(curr.fromStagePercent).toBe(prev.toStagePercent);
        expect(curr.fromStatus).toBe(prev.toStatus);
        if (curr.toStagePercent > curr.fromStagePercent) {
          expect(ladder.indexOf(curr.toStagePercent)).toBe(
            ladder.indexOf(curr.fromStagePercent) + 1,
          );
          expect(curr.health?.overall).toBe("HEALTHY");
        }
      }
    }
  });
});
