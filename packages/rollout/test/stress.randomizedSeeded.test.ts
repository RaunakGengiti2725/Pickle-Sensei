import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  HEALTH_METRIC_IDS,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  assertFrozenCriteria,
  createRollout,
  evaluateHealth,
  forceRollback,
  healthCriteriaSha256,
  isTerminal,
  type HealthCriteria,
  type HealthInputs,
  type HealthMetricId,
  type MetricObservation,
  type RolloutState,
} from "../src/index.js";
import {
  check,
  describeFailures,
  executeSteps,
  findNonFinite,
  readStressEnv,
  runCampaign,
  type Rng,
} from "../../../tools/stress-kit/kit.js";

/**
 * SEEDED RANDOMIZED LONG-RUN over the staged-rollout state machine.
 *
 * Model-checked invariants (rollout.ts / healthCriteria.ts doc comments):
 *  I1  SAFETY — exposure (stagePercent) only increases on an overall-HEALTHY
 *      window, and only to the next rung of ROLLOUT_STAGES_V1.
 *  I2  NOT_EVALUABLE ⇒ pause at the same stage; UNHEALTHY ⇒ rolled_back.
 *  I3  activeVersion === knownGoodVersion until status === complete, and
 *      equals knownGoodVersion forever after a rollback; knownGoodVersion is
 *      immutable.
 *  I4  terminal states (rolled_back / complete) reject applyHealthWindow and
 *      forceRollback with a throw and no state change.
 *  I5  transitions are append-only with contiguous seq 0..n, and every
 *      transition's from/to matches the state before/after.
 *  I6  health verdicts: null / non-finite / non-integer-sample / thin
 *      observations are NOT_EVALUABLE — never HEALTHY; overall is HEALTHY iff
 *      every metric is HEALTHY, UNHEALTHY iff any metric is UNHEALTHY.
 *  I7  a criteria set whose canonical SHA-256 differs from the frozen pin is
 *      refused (no threshold can be loosened).
 *  I8  no NaN/Infinity in any state produced from finite inputs (NaN
 *      observation values are legal near-invalid INPUT; they must surface
 *      only inside the `detail` string, never as numbers in the state).
 *  I9  same seed → identical trace (kit-level).
 */

type ObsKind =
  "absent" | "thin" | "nan" | "infinite" | "fractionalSamples" | "breach" | "boundary" | "ok";

type Action =
  | { kind: "window"; obs: ObsKind[]; magnitude: number[] }
  | { kind: "forceRollback" }
  | { kind: "tamperedCriteria"; field: "threshold" | "minSampleCount" | "id" }
  | { kind: "afterTerminal" };

const OBS_KINDS: readonly ObsKind[] = [
  "absent",
  "thin",
  "nan",
  "infinite",
  "fractionalSamples",
  "breach",
  "boundary",
  "ok",
];

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.82) {
      // Bias toward all-healthy windows so long runs actually climb the ladder.
      const allOk = rng.bool(0.45);
      actions.push({
        kind: "window",
        obs: HEALTH_METRIC_IDS.map(() => (allOk ? "ok" : rng.pick(OBS_KINDS))),
        magnitude: HEALTH_METRIC_IDS.map(() => rng.next()),
      });
    } else if (roll < 0.88) {
      actions.push({ kind: "forceRollback" });
    } else if (roll < 0.94) {
      actions.push({
        kind: "tamperedCriteria",
        field: rng.pick(["threshold", "minSampleCount", "id"]),
      });
    } else {
      actions.push({ kind: "afterTerminal" });
    }
  }
  return actions;
}

const criterionFor = (id: HealthMetricId) => {
  const criterion = FROZEN_HEALTH_CRITERIA_V1.metrics.find((m) => m.id === id);
  if (criterion === undefined) throw new Error(`missing criterion ${id}`);
  return criterion;
};

function observationFor(
  id: HealthMetricId,
  kind: ObsKind,
  magnitude: number,
): MetricObservation | null {
  const c = criterionFor(id);
  const samples = c.minSampleCount + Math.floor(magnitude * 400);
  const sign = c.direction === "at_most" ? 1 : -1;
  switch (kind) {
    case "absent":
      return null;
    case "thin":
      return { value: c.threshold, sampleCount: Math.floor(magnitude * c.minSampleCount) };
    case "nan":
      return { value: Number.NaN, sampleCount: samples };
    case "infinite":
      return { value: sign * Number.POSITIVE_INFINITY, sampleCount: samples };
    case "fractionalSamples":
      return { value: c.threshold, sampleCount: c.minSampleCount + 0.5 };
    case "breach":
      return {
        value: c.threshold + sign * (0.001 + magnitude * Math.abs(c.threshold)),
        sampleCount: samples,
      };
    case "boundary":
      return { value: c.threshold, sampleCount: c.minSampleCount };
    case "ok":
      return {
        value: c.threshold - sign * magnitude * Math.abs(c.threshold) * 0.5,
        sampleCount: samples,
      };
  }
}

/** Reference verdict model, independent of the implementation's control flow. */
function expectedVerdict(
  id: HealthMetricId,
  obs: MetricObservation | null,
): "HEALTHY" | "UNHEALTHY" | "NOT_EVALUABLE" {
  const c = criterionFor(id);
  if (obs === null || !Number.isFinite(obs.value) || !Number.isInteger(obs.sampleCount))
    return "NOT_EVALUABLE";
  if (obs.sampleCount < c.minSampleCount) return "NOT_EVALUABLE";
  const within = c.direction === "at_most" ? obs.value <= c.threshold : obs.value >= c.threshold;
  return within ? "HEALTHY" : "UNHEALTHY";
}

function checkState(state: RolloutState, model: Model): void {
  check(
    state.knownGoodVersion === model.knownGood,
    "I3 knownGood immutable",
    () => state.knownGoodVersion,
  );
  check(state.status === model.status, "I2 status", () => `${state.status} != ${model.status}`);
  check(
    state.stagePercent === model.stage,
    "I1 stage",
    () => `${state.stagePercent} != ${model.stage}`,
  );
  check(
    state.activeVersion === (model.status === "complete" ? model.candidate : model.knownGood),
    "I3 activeVersion",
    () => state.activeVersion,
  );
  check(
    state.transitions.every((t, i) => t.seq === i),
    "I5 contiguous seq",
    () => state.transitions.map((t) => t.seq).join(","),
  );
  check(state.transitions.length === model.transitions, "I5 transition count", () => "");
  for (let i = 1; i < state.transitions.length; i += 1) {
    const prev = state.transitions[i - 1]!;
    const cur = state.transitions[i]!;
    check(
      cur.fromStagePercent === prev.toStagePercent && cur.fromStatus === prev.toStatus,
      "I5 transition chain",
      () => `${i}: ${JSON.stringify(prev)} -> ${JSON.stringify(cur)}`,
    );
    if (cur.toStagePercent > cur.fromStagePercent) {
      const idx = ROLLOUT_STAGES_V1.indexOf(cur.fromStagePercent as 1);
      check(
        cur.health?.overall === "HEALTHY" && ROLLOUT_STAGES_V1[idx + 1] === cur.toStagePercent,
        "I1 promote only on HEALTHY to next rung",
        () => JSON.stringify(cur),
      );
    }
  }
  const last = state.transitions[state.transitions.length - 1]!;
  check(
    last.toStagePercent === state.stagePercent && last.toStatus === state.status,
    "I5 last transition",
    () => "",
  );
  check(
    isTerminal(state) === (state.status === "rolled_back" || state.status === "complete"),
    "I4 isTerminal",
    () => "",
  );
  // NaN observation values legitimately appear inside `detail` strings only.
  const nonFinite = findNonFinite(state);
  check(nonFinite === null, "I8 finite", () => nonFinite ?? "");
}

interface Model {
  candidate: string;
  knownGood: string;
  stage: 0 | 1 | 5 | 20 | 50 | 100;
  status: "in_progress" | "paused" | "rolled_back" | "complete";
  transitions: number;
}

function execute(actions: readonly Action[]) {
  let nowMs = 1_757_000_000_000;
  const tick = (): number => (nowMs += 60_000);
  const model: Model = {
    candidate: "SYNTHETIC-STRESS-cand",
    knownGood: "SYNTHETIC-STRESS-good",
    stage: 1,
    status: "in_progress",
    transitions: 1,
  };
  let state = createRollout({
    rolloutId: `SYNTHETIC-STRESS-${actions.length}`,
    modelId: "SYNTHETIC-STRESS-model",
    candidateVersion: model.candidate,
    knownGoodVersion: model.knownGood,
    nowMs: tick(),
  });
  checkState(state, model);

  const expectRejected = (fn: () => RolloutState, label: string): void => {
    const before = JSON.stringify(state);
    let thrown: unknown = null;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    check(thrown instanceof Error, label, () => `no throw`);
    check(JSON.stringify(state) === before, `${label} (no state change)`, () => "");
  };

  return executeSteps(actions, (action) => {
    if (action.kind === "tamperedCriteria") {
      const base = FROZEN_HEALTH_CRITERIA_V1;
      const tampered: HealthCriteria =
        action.field === "id"
          ? { ...base, id: "rollout-health-frozen-v1-loosened" }
          : {
              ...base,
              metrics: base.metrics.map((m, i) =>
                i === 0
                  ? action.field === "threshold"
                    ? { ...m, threshold: m.threshold * 10 }
                    : { ...m, minSampleCount: 1 }
                  : m,
              ),
            };
      let thrown = false;
      try {
        assertFrozenCriteria(tampered);
      } catch {
        thrown = true;
      }
      check(thrown, "I7 tampered criteria refused", () => healthCriteriaSha256(tampered));
      check(
        healthCriteriaSha256(FROZEN_HEALTH_CRITERIA_V1) === FROZEN_HEALTH_CRITERIA_V1_SHA256,
        "I7 pin",
        () => "",
      );
      const healthy: HealthInputs = Object.fromEntries(
        HEALTH_METRIC_IDS.map((id) => [id, observationFor(id, "ok", 0.5)]),
      ) as HealthInputs;
      if (!isTerminal(state)) {
        expectRejected(
          () => applyHealthWindow(state, healthy, tick(), tampered),
          "I7 tampered window refused",
        );
      }
      return { tampered: action.field };
    }
    if (action.kind === "afterTerminal") {
      if (!isTerminal(state)) return { afterTerminal: "skipped-not-terminal" };
      const inputs: HealthInputs = Object.fromEntries(
        HEALTH_METRIC_IDS.map((id) => [id, observationFor(id, "ok", 0.5)]),
      ) as HealthInputs;
      expectRejected(() => applyHealthWindow(state, inputs, tick()), "I4 terminal rejects window");
      expectRejected(() => forceRollback(state, tick()), "I4 terminal rejects forceRollback");
      return { afterTerminal: "rejected" };
    }
    if (action.kind === "forceRollback") {
      if (isTerminal(state)) {
        expectRejected(() => forceRollback(state, tick()), "I4 terminal rejects forceRollback");
        return { forceRollback: "rejected" };
      }
      state = forceRollback(state, tick());
      model.status = "rolled_back";
      model.stage = 0;
      model.transitions += 1;
      checkState(state, model);
      return { forceRollback: "ok" };
    }
    // window
    const inputs = Object.fromEntries(
      HEALTH_METRIC_IDS.map((id, i) => [
        id,
        observationFor(id, action.obs[i]!, action.magnitude[i]!),
      ]),
    ) as HealthInputs;
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    const verdicts = HEALTH_METRIC_IDS.map((id) => expectedVerdict(id, inputs[id]));
    for (const metric of report.metrics) {
      const idx = HEALTH_METRIC_IDS.indexOf(metric.id);
      check(
        metric.verdict === verdicts[idx],
        "I6 metric verdict",
        () => `${metric.id}: ${metric.verdict} != ${verdicts[idx]}`,
      );
    }
    const expectedOverall = verdicts.some((v) => v === "UNHEALTHY")
      ? "UNHEALTHY"
      : verdicts.every((v) => v === "HEALTHY")
        ? "HEALTHY"
        : "NOT_EVALUABLE";
    check(
      report.overall === expectedOverall,
      "I6 overall",
      () => `${report.overall} != ${expectedOverall}`,
    );
    check(
      report.criteriaSha256 === FROZEN_HEALTH_CRITERIA_V1_SHA256,
      "I7 report pin",
      () => report.criteriaSha256,
    );
    if (isTerminal(state)) {
      expectRejected(() => applyHealthWindow(state, inputs, tick()), "I4 terminal rejects window");
      return { window: expectedOverall, terminal: true };
    }
    const next = applyHealthWindow(state, inputs, tick());
    model.transitions += 1;
    if (expectedOverall === "UNHEALTHY") {
      model.status = "rolled_back";
      model.stage = 0;
    } else if (expectedOverall === "NOT_EVALUABLE") {
      model.status = "paused";
    } else {
      const idx = ROLLOUT_STAGES_V1.indexOf(model.stage as 1);
      const target = ROLLOUT_STAGES_V1[idx + 1];
      if (target === undefined) model.status = "complete";
      else {
        model.stage = target;
        model.status = "in_progress";
      }
    }
    state = next;
    checkState(state, model);
    return { window: expectedOverall, stage: state.stagePercent, status: state.status };
  });
}

const env = readStressEnv(300);

describe("rollout seeded randomized long-run", () => {
  it("invariants I1–I9 hold for every seed and every step; same seed → same trace", () => {
    const report = runCampaign<Action>({
      campaign: "rollout",
      env,
      minLength: 5,
      maxLength: 60,
      generate,
      execute,
    });
    expect(report.sequencesExecuted).toBe(env.iterations);
    expect(describeFailures(report)).toBe("");
    expect(report.broken + report.nondeterministic).toBe(0);
  });
});
