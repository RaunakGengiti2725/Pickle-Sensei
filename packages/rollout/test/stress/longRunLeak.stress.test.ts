import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  HEALTH_METRIC_IDS,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  forceRollback,
  isTerminal,
  type HealthInputs,
  type HealthMetricId,
  type MetricObservation,
  type OverallHealth,
  type RolloutState,
  type RolloutStatus,
} from "../../src/index.js";
import {
  SeededRng,
  type IterationOutcome,
  type Json,
  digestOf,
  nonFinitePaths,
  nondeterministicSeeds,
  runLeakCampaign,
  stressIterations,
  summarizeReport,
  writeReportIfRequested,
} from "../../../../tools/stress/leakHarness.js";

/**
 * LONG-RUN LEAK lens for @pickle/rollout. Every iteration drives one rollout
 * from creation to a terminal state (or a window cap) with seeded synthetic
 * health windows and checks the package against an independent reference
 * model of the frozen criteria. STRESS_ITER=500 for the full campaign.
 */

const ITER = stressIterations(60);
const BASE_SEED = 0x2011_0001;
const MAX_WINDOWS = 40;

function randomObservation(rng: SeededRng, id: HealthMetricId): MetricObservation | null {
  if (rng.chance(0.1)) return null;
  const roll = rng.next();
  let value: number;
  if (roll < 0.03) value = Number.NaN;
  else if (roll < 0.05) value = Number.POSITIVE_INFINITY;
  else if (id === "analysis_latency_p95_ms") value = rng.int(1000, 30_000);
  else value = rng.next() * (rng.chance(0.2) ? 1.5 : 1);
  const sampleCount = rng.chance(0.05) ? rng.next() * 300 : rng.int(0, 600);
  return { value, sampleCount };
}

function randomInputs(rng: SeededRng, bias: "healthy" | "random"): HealthInputs {
  const out: Partial<Record<HealthMetricId, MetricObservation | null>> = {};
  for (const id of HEALTH_METRIC_IDS) {
    if (bias === "healthy" && rng.chance(0.8)) {
      const criterion = FROZEN_HEALTH_CRITERIA_V1.metrics.find((m) => m.id === id);
      if (criterion === undefined) throw new Error(`missing criterion ${id}`);
      const value =
        criterion.direction === "at_most"
          ? criterion.threshold * rng.next()
          : criterion.threshold + (1 - criterion.threshold) * rng.next();
      out[id] = { value, sampleCount: criterion.minSampleCount + rng.int(0, 500) };
    } else {
      out[id] = randomObservation(rng, id);
    }
  }
  return out as HealthInputs;
}

function fullyHealthyInputs(): HealthInputs {
  const out: Partial<Record<HealthMetricId, MetricObservation>> = {};
  for (const criterion of FROZEN_HEALTH_CRITERIA_V1.metrics) {
    out[criterion.id] = {
      value: criterion.threshold,
      sampleCount: criterion.minSampleCount,
    };
  }
  return out as HealthInputs;
}

/** Reference model of the frozen criteria, written independently of the package. */
function referenceOverall(inputs: HealthInputs): OverallHealth {
  let allHealthy = true;
  for (const criterion of FROZEN_HEALTH_CRITERIA_V1.metrics) {
    const obs = inputs[criterion.id];
    if (
      obs === null ||
      !Number.isFinite(obs.value) ||
      !Number.isInteger(obs.sampleCount) ||
      obs.sampleCount < criterion.minSampleCount
    ) {
      allHealthy = false;
      continue;
    }
    const ok =
      criterion.direction === "at_most"
        ? obs.value <= criterion.threshold
        : obs.value >= criterion.threshold;
    if (!ok) return "UNHEALTHY";
  }
  return allHealthy ? "HEALTHY" : "NOT_EVALUABLE";
}

interface ReferenceState {
  stage: number;
  status: RolloutStatus;
  active: string;
}

function referenceStep(
  ref: ReferenceState,
  overall: OverallHealth,
  known: string,
  cand: string,
): ReferenceState {
  if (overall === "UNHEALTHY") return { stage: 0, status: "rolled_back", active: known };
  if (overall === "NOT_EVALUABLE") return { ...ref, status: "paused" };
  const index = ROLLOUT_STAGES_V1.indexOf(ref.stage as (typeof ROLLOUT_STAGES_V1)[number]);
  const next = ROLLOUT_STAGES_V1[index + 1];
  if (next === undefined) return { ...ref, status: "complete", active: cand };
  return { stage: next, status: "in_progress", active: ref.active };
}

function checkStateInvariants(state: RolloutState, problems: string[]): void {
  problems.push(...nonFinitePaths(state, "state"));
  state.transitions.forEach((t, i) => {
    if (t.seq !== i) problems.push(`transition seq ${t.seq} at index ${i}`);
    if (t.health !== null && t.health.criteriaSha256 !== FROZEN_HEALTH_CRITERIA_V1_SHA256) {
      problems.push(`health report hashed against non-frozen criteria at seq ${t.seq}`);
    }
  });
  if (state.status !== "complete" && state.activeVersion !== state.knownGoodVersion) {
    problems.push(`active=${state.activeVersion} while status=${state.status}`);
  }
  if (state.status === "complete" && state.activeVersion !== state.candidateVersion) {
    problems.push("complete rollout not serving the candidate");
  }
  if (state.status === "rolled_back" && state.stagePercent !== 0) {
    problems.push(`rolled back with stage ${state.stagePercent}`);
  }
  if (state.criteriaId !== FROZEN_HEALTH_CRITERIA_V1.id) problems.push("criteriaId drifted");
}

function rolloutIteration(seed: number): IterationOutcome {
  const rng = new SeededRng(seed);
  const known = `model-v${rng.int(1, 99)}`;
  const cand = `${known}-rc${rng.int(1, 999)}`;
  let state = createRollout({
    rolloutId: `SYNTHETIC-TEST-FIXTURE.rollout-${seed.toString(16)}`,
    modelId: "SYNTHETIC-TEST-FIXTURE.model",
    candidateVersion: cand,
    knownGoodVersion: known,
    nowMs: 1_700_000_000_000 + rng.int(0, 1_000_000),
  });
  let ref: ReferenceState = { stage: state.stagePercent, status: state.status, active: known };
  const problems: string[] = [];
  const bias = rng.chance(0.5) ? "healthy" : "random";
  let windows = 0;
  let killSwitch = false;
  let nowMs = state.transitions[0]?.occurredAtMs ?? 0;

  while (!isTerminal(state) && windows < MAX_WINDOWS) {
    nowMs += rng.int(60_000, 3_600_000);
    if (rng.chance(0.03)) {
      state = forceRollback(state, nowMs);
      ref = { stage: 0, status: "rolled_back", active: known };
      killSwitch = true;
    } else {
      const inputs = randomInputs(rng, bias);
      const expected = referenceOverall(inputs);
      const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
      if (report.overall !== expected) {
        problems.push(`window ${windows}: package=${report.overall} reference=${expected}`);
      }
      problems.push(...nonFinitePaths(report, `report[${windows}]`));
      state = applyHealthWindow(state, inputs, nowMs);
      ref = referenceStep(ref, expected, known, cand);
    }
    windows += 1;
    if (
      state.stagePercent !== ref.stage ||
      state.status !== ref.status ||
      state.activeVersion !== ref.active
    ) {
      problems.push(
        `window ${windows}: package stage=${state.stagePercent}/${state.status}/${state.activeVersion} ` +
          `reference ${ref.stage}/${ref.status}/${ref.active}`,
      );
    }
    checkStateInvariants(state, problems);
  }

  if (isTerminal(state)) {
    let threw = false;
    try {
      applyHealthWindow(state, randomInputs(rng, "healthy"), nowMs + 1);
    } catch {
      threw = true;
    }
    if (!threw) problems.push("terminal rollout accepted a health window");
    try {
      forceRollback(state, nowMs + 1);
      problems.push("terminal rollout accepted forceRollback");
    } catch {
      // expected
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));

  const detail: Json = { bias, windows, killSwitch, transitions: state.transitions.length };
  return {
    outcome: `${state.status}@${state.stagePercent}`,
    digest: digestOf(state),
    retainables: [state, state.transitions],
    detail,
  };
}

describe("rollout long-run leak (seeded, one process)", { timeout: 30_000 + ITER * 400 }, () => {
  it(`drives ${ITER} seeded rollouts against a reference model without retaining state`, async () => {
    const report = await runLeakCampaign({
      name: "rollout.lifecycle",
      baseSeed: BASE_SEED,
      iterations: ITER,
      run: rolloutIteration,
    });
    const path = writeReportIfRequested(report);
    console.log(summarizeReport(report), path ?? "");

    expect(report.gcForced).toBe(true);
    expect(report.iterations).toBe(ITER);
    expect(report.failures).toEqual([]);
    expect(report.retained.maxAtAnyCheckpoint).toBe(0);
    expect(report.handles.grown).toEqual({});
    if (ITER >= 200) {
      expect(report.heap.monotoneIncreasing && report.heap.slopePctPer100 > 5).toBe(false);
    }
  });

  it(`one long-lived rollout paused ${ITER} times keeps a linear, finite transition log`, async () => {
    let state = createRollout({
      rolloutId: "SYNTHETIC-TEST-FIXTURE.rollout-long-lived",
      modelId: "SYNTHETIC-TEST-FIXTURE.model",
      candidateVersion: "v2",
      knownGoodVersion: "v1",
      nowMs: 1_700_000_000_000,
    });
    const report = await runLeakCampaign({
      name: "rollout.long-lived-paused",
      baseSeed: BASE_SEED + 100_000,
      iterations: ITER,
      run: (seed, iteration) => {
        const rng = new SeededRng(seed);
        // Never-evaluable windows: every metric either missing or under-sampled.
        const inputs = Object.fromEntries(
          HEALTH_METRIC_IDS.map((id) => [
            id,
            rng.chance(0.5) ? null : { value: rng.next(), sampleCount: rng.int(0, 50) },
          ]),
        ) as HealthInputs;
        const before = state;
        state = applyHealthWindow(state, inputs, 1_700_000_000_000 + (iteration + 1) * 60_000);
        const problems: string[] = [];
        if (state.status !== "paused" || state.stagePercent !== ROLLOUT_STAGES_V1[0]) {
          problems.push(`expected paused@1, got ${state.status}@${state.stagePercent}`);
        }
        if (before.transitions.length + 1 !== state.transitions.length) {
          problems.push("transition log did not grow by exactly one");
        }
        if (before.status !== "in_progress" && before.status !== "paused") {
          problems.push(`previous state mutated to ${before.status}`);
        }
        checkStateInvariants(state, problems);
        if (problems.length > 0) throw new Error(problems.join("; "));
        return {
          outcome: `${state.status}@${state.stagePercent}`,
          digest: digestOf(state.transitions[state.transitions.length - 1]),
          retainables: [before],
        };
      },
    });
    const path = writeReportIfRequested(report);
    console.log(summarizeReport(report), path ?? "");

    expect(report.gcForced).toBe(true);
    expect(report.failures).toEqual([]);
    // Immutable updates: every superseded state must be collectable.
    expect(report.retained.maxAtAnyCheckpoint).toBe(0);
    expect(report.handles.grown).toEqual({});
    expect(state.transitions.length).toBe(ITER + 2);
    // One healthy window resumes AND promotes off the paused stage.
    const resumed = applyHealthWindow(state, fullyHealthyInputs(), 1_800_000_000_000);
    expect(resumed.status).toBe("in_progress");
    expect(resumed.stagePercent).toBe(ROLLOUT_STAGES_V1[1]);
    expect(resumed.transitions.at(-1)?.action).toBe("resume");
  });

  it("same seed → identical terminal state digest", () => {
    const seeds = Array.from({ length: Math.min(ITER, 25) }, (_, i) => BASE_SEED + i);
    expect(nondeterministicSeeds(seeds, rolloutIteration)).toEqual([]);
  });
});
