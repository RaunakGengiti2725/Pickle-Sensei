import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  HEALTH_METRIC_IDS,
  ROLLOUT_STAGES_V1,
  ROLLOUT_STATUSES,
  TRANSITION_ACTIONS,
  applyHealthWindow,
  assertFrozenCriteria,
  createRollout,
  evaluateHealth,
  forceRollback,
  type HealthCriteria,
  type HealthInputs,
  type HealthReport,
  type RolloutState,
} from "../src/index.js";
import {
  campaignTimeoutMs,
  campaignVerdict,
  findNonFinite,
  isFiniteNumber,
  outputDir,
  runCampaign,
  runGuarded,
  typedShapeGap,
  writeReport,
  type KnownGap,
  type StressCase,
} from "../../../tools/stress/boundary-malformed/harness.js";
import {
  describeValue,
  materialize,
  planMutations,
  type FieldSpec,
} from "../../../tools/stress/boundary-malformed/payloads.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/rollout.
 *
 * The rollout controller consumes telemetry (`HealthInputs`), a persisted
 * `RolloutState` and the frozen `HealthCriteria`. Malformed versions of all
 * three are generated; the safety properties asserted on every call:
 *   - never a native TypeError out of `applyHealthWindow` / `evaluateHealth`;
 *   - a returned state has a legal stage/status, a monotonically numbered
 *     transition log, and `activeVersion` equal to the known-good version
 *     unless the rollout is `complete`;
 *   - a health report never contains NaN/Infinity and never says HEALTHY for
 *     a metric whose observation was malformed or missing;
 *   - the frozen-criteria pin rejects any criteria whose canonical hash moved;
 *   - inputs are never mutated (pure functions).
 *
 * Scale: STRESS_ITER (default 60). Replay one row: STRESS_REPLAY=<seed>.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const STAGES: readonly number[] = ROLLOUT_STAGES_V1;
const STATUSES: readonly string[] = ROLLOUT_STATUSES;
const ACTIONS: readonly string[] = TRANSITION_ACTIONS;
const METRIC_IDS: readonly string[] = HEALTH_METRIC_IDS;

const HEALTHY_INPUTS: HealthInputs = {
  crash_rate: { value: 0.001, sampleCount: 5000 },
  analysis_completion_rate: { value: 0.99, sampleCount: 5000 },
  analysis_latency_p95_ms: { value: 1200, sampleCount: 5000 },
  capture_success_rate: { value: 0.98, sampleCount: 5000 },
  abstention_rate: { value: 0.05, sampleCount: 5000 },
  silent_failure_rate: { value: 0.0, sampleCount: 5000 },
};

const INPUT_FIELDS: FieldSpec[] = HEALTH_METRIC_IDS.flatMap((id): FieldSpec[] => [
  { path: [id], kind: "object" },
  { path: [id, "value"], kind: "number" },
  { path: [id, "sampleCount"], kind: "number" },
]);

const STATE_FIELDS: FieldSpec[] = [
  { path: ["rolloutId"], kind: "string" },
  { path: ["modelId"], kind: "string" },
  { path: ["candidateVersion"], kind: "string" },
  { path: ["knownGoodVersion"], kind: "string" },
  { path: ["activeVersion"], kind: "string" },
  { path: ["stagePercent"], kind: "number" },
  { path: ["status"], kind: "enum" },
  { path: ["criteriaId"], kind: "string" },
  { path: ["transitions"], kind: "array" },
  { path: ["transitions", 0], kind: "object" },
  { path: ["transitions", 0, "seq"], kind: "number" },
  { path: ["transitions", 0, "action"], kind: "enum" },
  { path: ["transitions", 0, "toStagePercent"], kind: "number" },
  { path: ["transitions", 0, "occurredAtMs"], kind: "number" },
];

const CRITERIA_FIELDS: FieldSpec[] = [
  { path: ["id"], kind: "string" },
  { path: ["schemaVersion"], kind: "number" },
  { path: ["metrics"], kind: "array" },
  { path: ["metrics", 0], kind: "object" },
  { path: ["metrics", 0, "id"], kind: "enum" },
  { path: ["metrics", 0, "direction"], kind: "enum" },
  { path: ["metrics", 0, "threshold"], kind: "number" },
  { path: ["metrics", 0, "minSampleCount"], kind: "number" },
  { path: ["metrics", 5, "threshold"], kind: "number" },
];

function baseState(): RolloutState {
  let state = createRollout({
    rolloutId: "rollout-synthetic-01",
    modelId: "stroke-classifier",
    candidateVersion: "2.0.0",
    knownGoodVersion: "1.9.0",
    nowMs: 1_756_500_000_000,
  });
  state = applyHealthWindow(state, HEALTHY_INPUTS, 1_756_500_060_000);
  return state;
}

function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? `${v.toString()}n` : typeof v === "symbol" ? v.toString() : v,
  );
}

function validateReport(report: HealthReport, inputs: unknown): string[] {
  const problems: string[] = [];
  if (!["HEALTHY", "UNHEALTHY", "NOT_EVALUABLE"].includes(report.overall)) {
    problems.push(`overall=${describeValue(report.overall)}`);
  }
  if (report.criteriaSha256 !== FROZEN_HEALTH_CRITERIA_V1_SHA256) {
    problems.push("report carries a non-frozen criteria hash");
  }
  if (!Array.isArray(report.metrics) || report.metrics.length !== HEALTH_METRIC_IDS.length) {
    problems.push("metrics list is not one-per-frozen-metric");
    return problems;
  }
  const record =
    typeof inputs === "object" && inputs !== null ? (inputs as Record<string, unknown>) : {};
  for (const metric of report.metrics) {
    if (!METRIC_IDS.includes(metric.id))
      problems.push(`unknown metric id ${describeValue(metric.id)}`);
    const observation = record[metric.id];
    const wellFormed =
      typeof observation === "object" &&
      observation !== null &&
      Number.isFinite((observation as { value?: unknown }).value) &&
      Number.isInteger((observation as { sampleCount?: unknown }).sampleCount);
    if (metric.verdict === "HEALTHY" && !wellFormed) {
      problems.push(`${metric.id} HEALTHY on malformed/missing observation`);
    }
    if (metric.verdict !== "NOT_EVALUABLE" && !wellFormed) {
      problems.push(`${metric.id} ${metric.verdict} on malformed/missing observation`);
    }
  }
  if (report.overall === "HEALTHY" && report.metrics.some((m) => m.verdict !== "HEALTHY")) {
    problems.push("overall HEALTHY with a non-HEALTHY metric");
  }
  problems.push(...findNonFinite(report, "report"));
  return problems;
}

/** Absolute invariants of a rollout state ("is this a legal state at all?"). */
function stateShapeProblems(state: RolloutState, label: string): string[] {
  const problems: string[] = [];
  if (!STATUSES.includes(state.status))
    problems.push(`${label}.status=${describeValue(state.status)}`);
  if (state.stagePercent !== 0 && !STAGES.includes(state.stagePercent)) {
    problems.push(`${label}.stagePercent=${describeValue(state.stagePercent)}`);
  }
  if (state.status === "rolled_back" && state.stagePercent !== 0) {
    problems.push(`${label} rolled_back with non-zero stage`);
  }
  if (state.status !== "complete" && state.activeVersion !== state.knownGoodVersion) {
    problems.push(`${label}.activeVersion off known-good before completion`);
  }
  if (!Array.isArray(state.transitions)) problems.push(`${label}.transitions not an array`);
  return problems;
}

/**
 * Invariants of ONE applied transition, relative to the input state. Absolute
 * legality of the result is demanded when the input was legal; when it was
 * not, `applyHealthWindow` is expected to refuse it (`expectRefusal`) while
 * `forceRollback` may legitimately act on anything. Either way the machine
 * must never introduce a new non-finite value, mutate known-good, or skip a
 * transition.
 */
function validateState(next: RolloutState, prev: RolloutState, expectRefusal: boolean): string[] {
  const problems: string[] = [];
  const prevProblems = stateShapeProblems(prev, "prev");
  if (prevProblems.length === 0) problems.push(...stateShapeProblems(next, "state"));
  else if (expectRefusal) problems.push(`illegal input state accepted: ${prevProblems.join("; ")}`);
  if (next.knownGoodVersion !== prev.knownGoodVersion) problems.push("knownGoodVersion changed");
  if (Array.isArray(prev.transitions)) {
    if (
      !Array.isArray(next.transitions) ||
      next.transitions.length !== prev.transitions.length + 1
    ) {
      problems.push("did not append exactly one transition");
    } else {
      const last = next.transitions[next.transitions.length - 1];
      const before = next.transitions[next.transitions.length - 2];
      if (last === undefined || !ACTIONS.includes(last.action)) {
        problems.push(`transition action ${describeValue(last?.action)}`);
      }
      if (
        last !== undefined &&
        before !== undefined &&
        isFiniteNumber(before.seq) &&
        last.seq !== before.seq + 1
      ) {
        problems.push(
          `transition seq ${describeValue(last.seq)} after ${describeValue(before.seq)}`,
        );
      }
      if (last !== undefined && last.toStatus !== next.status) {
        problems.push("last transition toStatus disagrees with state");
      }
      if (last !== undefined && last.toStagePercent !== next.stagePercent) {
        problems.push("last transition toStagePercent disagrees with state");
      }
    }
  }
  if (findNonFinite(prev, "state").length === 0) problems.push(...findNonFinite(next, "state"));
  return problems;
}

type CreateParams = Parameters<typeof createRollout>[0];

const CREATE_PARAMS: CreateParams = {
  rolloutId: "rollout-synthetic-02",
  modelId: "stroke-classifier",
  candidateVersion: "2.0.0",
  knownGoodVersion: "1.9.0",
  nowMs: 1_756_500_000_000,
};

interface RolloutBase {
  state: RolloutState;
  inputs: HealthInputs;
  criteria: HealthCriteria;
  create: CreateParams;
  target: "inputs" | "state" | "criteria" | "create";
}

function baseFor(target: RolloutBase["target"]): RolloutBase {
  return {
    state: baseState(),
    inputs: HEALTHY_INPUTS,
    criteria: FROZEN_HEALTH_CRITERIA_V1,
    create: CREATE_PARAMS,
    target,
  };
}

function mutationRoot(base: RolloutBase): unknown {
  return base[base.target];
}

const evaluateHealthCase: StressCase<RolloutBase> = {
  api: "evaluateHealth",
  surface: "typed",
  weight: 3,
  mutationRoot,
  generate(rng) {
    const onCriteria = rng.chance(0.3);
    const plan = onCriteria
      ? planMutations(rng, CRITERIA_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[], ["metrics", 0]],
          schemaPaths: [["schemaVersion"]],
        })
      : planMutations(rng, INPUT_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[], ["crash_rate"], ["silent_failure_rate"]],
        });
    return {
      category: plan.category,
      base: baseFor(onCriteria ? "criteria" : "inputs"),
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const inputs =
      base.target === "inputs"
        ? (materialize(base.inputs, mutations).value as HealthInputs)
        : base.inputs;
    const criteria =
      base.target === "criteria"
        ? (materialize(base.criteria, mutations).value as HealthCriteria)
        : base.criteria;
    const inputsBefore = snapshot(inputs);
    const criteriaBefore = snapshot(criteria);
    const result = runGuarded(
      () => evaluateHealth(inputs, criteria),
      (report) => validateReport(report, inputs),
    );
    if (snapshot(inputs) !== inputsBefore) result.violations.push("input-mutated: inputs");
    if (snapshot(criteria) !== criteriaBefore) result.violations.push("input-mutated: criteria");
    return result;
  },
};

const applyWindowCase: StressCase<RolloutBase> = {
  api: "applyHealthWindow",
  surface: "typed",
  weight: 5,
  mutationRoot,
  generate(rng) {
    const roll = rng.next();
    const target: RolloutBase["target"] =
      roll < 0.5 ? "inputs" : roll < 0.85 ? "state" : "criteria";
    const plan =
      target === "inputs"
        ? planMutations(rng, INPUT_FIELDS, {
            jsonOnly: false,
            allowText: false,
            objectPaths: [[], ["crash_rate"], ["abstention_rate"]],
          })
        : target === "state"
          ? planMutations(rng, STATE_FIELDS, {
              jsonOnly: false,
              allowText: false,
              objectPaths: [[], ["transitions", 0]],
            })
          : planMutations(rng, CRITERIA_FIELDS, {
              jsonOnly: false,
              allowText: false,
              objectPaths: [[], ["metrics", 0]],
              schemaPaths: [["schemaVersion"]],
            });
    return { category: plan.category, base: baseFor(target), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const inputs =
      base.target === "inputs"
        ? (materialize(base.inputs, mutations).value as HealthInputs)
        : base.inputs;
    const state =
      base.target === "state"
        ? (materialize(base.state, mutations).value as RolloutState)
        : base.state;
    const criteria =
      base.target === "criteria"
        ? (materialize(base.criteria, mutations).value as HealthCriteria)
        : base.criteria;
    const before = [snapshot(inputs), snapshot(state), snapshot(criteria)].join("|");
    const result = runGuarded(
      () => applyHealthWindow(state, inputs, 1_756_500_120_000, criteria),
      (next) => {
        const problems = validateState(next, state, true);
        const last = next.transitions[next.transitions.length - 1];
        if (last?.health) problems.push(...validateReport(last.health, inputs));
        if (last?.health?.overall !== "HEALTHY" && next.stagePercent > state.stagePercent) {
          problems.push("promoted without a HEALTHY window");
        }
        return problems;
      },
    );
    if ([snapshot(inputs), snapshot(state), snapshot(criteria)].join("|") !== before) {
      result.violations.push("input-mutated");
    }
    return result;
  },
};

const forceRollbackCase: StressCase<RolloutBase> = {
  api: "forceRollback",
  surface: "typed",
  weight: 1,
  mutationRoot,
  generate(rng) {
    const plan = planMutations(rng, STATE_FIELDS, {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[], ["transitions", 0]],
    });
    return { category: plan.category, base: baseFor("state"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const state = materialize(base.state, mutations).value as RolloutState;
    const before = snapshot(state);
    const result = runGuarded(
      () => forceRollback(state, 1_756_500_120_000),
      (next) => {
        const problems = validateState(next, state, false);
        if (next.status !== "rolled_back") problems.push("forceRollback did not roll back");
        if (next.activeVersion !== state.knownGoodVersion) {
          problems.push("forceRollback did not land on known-good");
        }
        return problems;
      },
    );
    if (snapshot(state) !== before) result.violations.push("input-mutated: state");
    return result;
  },
};

const createCase: StressCase<RolloutBase> = {
  api: "createRollout",
  surface: "typed",
  weight: 1,
  mutationRoot,
  generate(rng) {
    const plan = planMutations(
      rng,
      [
        { path: ["rolloutId"], kind: "string" },
        { path: ["modelId"], kind: "string" },
        { path: ["candidateVersion"], kind: "string" },
        { path: ["knownGoodVersion"], kind: "string" },
        { path: ["nowMs"], kind: "number" },
      ],
      { jsonOnly: false, allowText: false, objectPaths: [[]] },
    );
    return { category: plan.category, base: baseFor("create"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const { value } = materialize(base.create, mutations);
    return runGuarded(
      () => createRollout(value as CreateParams),
      (state) => {
        const problems: string[] = [];
        if (state.status !== "in_progress" || state.stagePercent !== ROLLOUT_STAGES_V1[0]) {
          problems.push("fresh rollout not at first stage / in_progress");
        }
        if (state.activeVersion !== state.knownGoodVersion)
          problems.push("activeVersion != known-good");
        if (state.candidateVersion === state.knownGoodVersion)
          problems.push("candidate == known-good");
        if (typeof state.rolloutId !== "string" || typeof state.modelId !== "string") {
          problems.push("non-string ids accepted");
        }
        problems.push(...findNonFinite(state, "state"));
        return problems;
      },
    );
  },
};

const assertFrozenCase: StressCase<RolloutBase> = {
  api: "assertFrozenCriteria",
  surface: "typed",
  weight: 1,
  mutationRoot,
  generate(rng) {
    const plan = planMutations(rng, CRITERIA_FIELDS, {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[], ["metrics", 0]],
      schemaPaths: [["schemaVersion"]],
    });
    return { category: plan.category, base: baseFor("criteria"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const criteria = materialize(base.criteria, mutations).value as HealthCriteria;
    return runGuarded(
      () => assertFrozenCriteria(criteria),
      () => {
        // Independent restatement of "identical to frozen v1" over the pinned fields.
        const problems: string[] = [];
        if (criteria.id !== FROZEN_HEALTH_CRITERIA_V1.id) problems.push("accepted foreign id");
        if (criteria.schemaVersion !== 1) problems.push("accepted non-v1 schemaVersion");
        if (
          !Array.isArray(criteria.metrics) ||
          criteria.metrics.length !== HEALTH_METRIC_IDS.length
        ) {
          problems.push("accepted criteria with a different metric count");
          return problems;
        }
        for (const [index, frozen] of FROZEN_HEALTH_CRITERIA_V1.metrics.entries()) {
          const m = criteria.metrics[index];
          if (
            m === undefined ||
            m.id !== frozen.id ||
            m.direction !== frozen.direction ||
            m.threshold !== frozen.threshold ||
            m.minSampleCount !== frozen.minSampleCount ||
            m.title !== frozen.title
          ) {
            problems.push(`accepted criteria whose metric ${index} differs from frozen`);
          }
        }
        return problems;
      },
    );
  },
};

/* ------------------------------------------------------------------------ */
/* Known gaps (reproduced, documented behaviour — see the campaign report)   */
/* ------------------------------------------------------------------------ */

const KNOWN_GAPS: KnownGap[] = [
  {
    id: "ROLLOUT-MISSING-METRIC-CRASH",
    finding:
      "healthCriteria.ts evaluateMetric() treats only `null` as a missing observation; a " +
      "HealthInputs object that simply lacks a metric key yields `undefined` and " +
      "evaluateHealth()/applyHealthWindow() crash with a native TypeError instead of " +
      "reporting NOT_EVALUABLE.",
    matches: (row) =>
      (row.api === "evaluateHealth" || row.api === "applyHealthWindow") &&
      row.outcome === "crash-native" &&
      row.errorName === "TypeError" &&
      row.detail.includes("(reading 'value')") &&
      row.violations.length === 0 &&
      row.minimized !== null &&
      row.minimized.length > 0 &&
      row.minimized.every((m) => m.startsWith("delete ")),
  },
  {
    id: "ROLLOUT-NONFINITE-NOW",
    finding:
      "createRollout() accepts a non-finite `nowMs` (NaN / ±Infinity) and stamps it into the " +
      "first transition's occurredAtMs.",
    matches: (row) =>
      row.api === "createRollout" &&
      row.outcome === "returned-invalid" &&
      /occurredAtMs=(NaN|-?Infinity)/.test(row.detail) &&
      row.violations.length === 0 &&
      row.minimized !== null &&
      row.minimized.every((m) => m.startsWith("set nowMs = ")),
  },
  {
    id: "ROLLOUT-ERR-ECHO-UNBOUNDED",
    finding:
      "assertFrozenCriteria() echoes the caller-supplied criteria id verbatim into its error " +
      "message; a 64 KiB+ id yields a 64 KiB+ (up to 1 MiB observed) error string.",
    matches: (row) =>
      (row.outcome === "rejected-error" || row.outcome === "rejected-typed") &&
      row.detail.startsWith("Error: Health criteria ") &&
      row.violations.length > 0 &&
      row.violations.every((v) => v.startsWith("oversized-error-message")),
  },
  typedShapeGap(
    "ROLLOUT-TYPED-NO-GUARDS",
    "rollout.ts / healthCriteria.ts apply no runtime guards to their typed inputs: a state, " +
      "inputs or criteria object of the wrong runtime shape ends in a native TypeError or " +
      "is carried through into the returned state.",
  ),
  {
    id: "ROLLOUT-STATE-UNVALIDATED",
    finding:
      "applyHealthWindow() does not validate the incoming RolloutState: an illegal " +
      "stagePercent / status / activeVersion is accepted and carried into the next " +
      "transition (an unknown stagePercent even 'promotes' to ROLLOUT_STAGES_V1[0] because " +
      "nextStage() maps indexOf() === -1 to index 0).",
    matches: (row) =>
      row.api === "applyHealthWindow" &&
      row.outcome === "returned-invalid" &&
      row.detail.startsWith("illegal input state accepted: ") &&
      row.violations.length === 0,
  },
];

describe("rollout boundary/malformed stress", () => {
  it(
    "never promotes on malformed telemetry and never crashes natively",
    () => {
      const report = runCampaign<RolloutBase>({
        pkg: "rollout",
        cases: [
          evaluateHealthCase,
          applyWindowCase,
          forceRollbackCase,
          createCase,
          assertFrozenCase,
        ],
        knownGaps: KNOWN_GAPS,
      });
      const path = writeReport(report, outputDir(REPO_ROOT));
      expect(campaignVerdict(report, path)).toBeNull();
    },
    campaignTimeoutMs(),
  );
});
