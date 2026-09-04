import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  DEFAULT_QUEUE_SLO_CONFIG,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
  type ApiSloSnapshot,
  type ApiSloTargets,
  type PoolSaturationSample,
  type QueueCycleObservation,
  type QueueSloConfig,
} from "../src/index.js";
import {
  campaignTimeoutMs,
  campaignVerdict,
  findNonFinite,
  findOwnProtoKeys,
  outputDir,
  runCampaign,
  runGuarded,
  stableJson,
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
 * Boundary / malformed-input stress campaign for @pickle/slo.
 *
 * SLO recorders sit on the request path: a malformed sample (NaN latency,
 * negative counts, a non-numeric status code, a hostile route string) must
 * never throw into the request handler and must never poison the snapshot
 * with NaN/Infinity or a percentile outside the recorded range. The
 * evaluator and the queue monitor are fed malformed snapshots/observations
 * and their verdicts are checked for finiteness and legal status values.
 *
 * Scale: STRESS_ITER (default 60). Replay one row: STRESS_REPLAY=<seed>.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const STATUS_SET = ["met", "breached", "not_evaluable"];

interface SloBase {
  requests: { route: string; statusCode: number; latencyMs: number }[];
  dbLatencies: number[];
  pool: PoolSaturationSample;
  snapshot: ApiSloSnapshot;
  targets: ApiSloTargets;
  queueConfig: QueueSloConfig;
  observations: QueueCycleObservation[];
  windowCapacity: number;
  percentile: number;
  /** Which argument the mutations apply to. */
  target:
    "requests" | "pool" | "db" | "snapshot" | "targets" | "observations" | "config" | "window";
}

function healthySnapshot(): ApiSloSnapshot {
  const recorder = new ApiSloRecorder(64);
  for (let i = 0; i < 120; i += 1) {
    recorder.recordRequest({ route: "/v1/me/access", statusCode: 200, latencyMs: 40 + i });
    recorder.recordDbLatency(5 + (i % 7));
  }
  recorder.recordRequest({ route: "/v1/media/upload", statusCode: 503, latencyMs: 900 });
  recorder.recordPoolSample({ totalCount: 10, idleCount: 6, waitingCount: 0, maxSize: 20 });
  return recorder.snapshot();
}

function baseFor(target: SloBase["target"]): SloBase {
  return {
    target,
    requests: [
      { route: "/v1/me/access", statusCode: 200, latencyMs: 42 },
      { route: "/v1/media/upload", statusCode: 503, latencyMs: 950 },
      { route: "/v1/shots/sync", statusCode: 429, latencyMs: 12 },
    ],
    dbLatencies: [3, 7.5, 12],
    pool: { totalCount: 10, idleCount: 6, waitingCount: 0, maxSize: 20 },
    snapshot: healthySnapshot(),
    targets: DEFAULT_API_SLO_TARGETS,
    queueConfig: DEFAULT_QUEUE_SLO_CONFIG,
    observations: [
      { depth: 5, oldestJobAgeMs: 30_000, jobsHandled: 0, jobsSeen: 5 },
      { depth: 5, oldestJobAgeMs: 60_000, jobsHandled: 0, jobsSeen: 5 },
      { depth: 4, oldestJobAgeMs: 90_000, jobsHandled: 1, jobsSeen: 5 },
    ],
    windowCapacity: 16,
    percentile: 95,
  };
}

const REQUEST_FIELDS: FieldSpec[] = [0, 1, 2].flatMap((i): FieldSpec[] => [
  { path: [i], kind: "object" },
  { path: [i, "route"], kind: "string" },
  { path: [i, "statusCode"], kind: "number" },
  { path: [i, "latencyMs"], kind: "number" },
]);

const POOL_FIELDS: FieldSpec[] = [
  { path: ["totalCount"], kind: "number" },
  { path: ["idleCount"], kind: "number" },
  { path: ["waitingCount"], kind: "number" },
  { path: ["maxSize"], kind: "number" },
];

function snapshotProblems(snap: ApiSloSnapshot, label: string): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(snap.requestCount) || snap.requestCount < 0) {
    problems.push(`${label}.requestCount=${describeValue(snap.requestCount)}`);
  }
  if (
    !Number.isInteger(snap.fiveXxCount) ||
    snap.fiveXxCount < 0 ||
    snap.fiveXxCount > snap.requestCount
  ) {
    problems.push(
      `${label}.fiveXxCount=${describeValue(snap.fiveXxCount)} of ${describeValue(snap.requestCount)}`,
    );
  }
  if (snap.mediaFiveXxCount > snap.fiveXxCount)
    problems.push(`${label}.mediaFiveXxCount > fiveXxCount`);
  if (snap.availability !== null && (snap.availability < 0 || snap.availability > 1)) {
    problems.push(`${label}.availability=${describeValue(snap.availability)}`);
  }
  if (snap.fiveXxRate !== null && (snap.fiveXxRate < 0 || snap.fiveXxRate > 1)) {
    problems.push(`${label}.fiveXxRate=${describeValue(snap.fiveXxRate)}`);
  }
  for (const key of ["latency", "dbLatency"] as const) {
    const pct = snap[key];
    if (!Number.isInteger(pct.sampleCount) || pct.sampleCount < 0) {
      problems.push(`${label}.${key}.sampleCount=${describeValue(pct.sampleCount)}`);
    }
    if (pct.sampleCount === 0 && (pct.p50 !== null || pct.p95 !== null || pct.p99 !== null)) {
      problems.push(`${label}.${key} percentiles without samples`);
    }
    if (pct.p50 !== null && pct.p95 !== null && pct.p99 !== null) {
      if (pct.p50 > pct.p95 || pct.p95 > pct.p99)
        problems.push(`${label}.${key} percentiles not monotonic`);
      if (pct.p50 < 0) problems.push(`${label}.${key} negative latency`);
    }
  }
  if (snap.poolSaturation !== null && snap.poolSaturation < 0) {
    problems.push(`${label}.poolSaturation negative (${describeValue(snap.poolSaturation)})`);
  }
  problems.push(...findNonFinite(snap, label));
  problems.push(...findOwnProtoKeys(snap, label).map((p) => `own proto key persisted at ${p}`));
  return problems;
}

const recorderCase: StressCase<SloBase> = {
  api: "ApiSloRecorder.recordRequest/recordDbLatency/recordPoolSample/snapshot",
  surface: "typed",
  weight: 5,
  mutationRoot: (base) =>
    base.target === "requests"
      ? base.requests
      : base.target === "pool"
        ? base.pool
        : base.dbLatencies,
  generate(rng) {
    const roll = rng.next();
    const plan =
      roll < 0.6
        ? planMutations(rng, REQUEST_FIELDS, {
            jsonOnly: false,
            allowText: false,
            objectPaths: [[0], [1]],
          })
        : roll < 0.8
          ? planMutations(rng, POOL_FIELDS, {
              jsonOnly: false,
              allowText: false,
              objectPaths: [[]],
            })
          : planMutations(
              rng,
              [
                { path: [0], kind: "number" },
                { path: [1], kind: "number" },
                { path: [2], kind: "number" },
              ],
              { jsonOnly: false, allowText: false, objectPaths: [] },
            );
    return {
      category: plan.category,
      base: baseFor(roll < 0.6 ? "requests" : roll < 0.8 ? "pool" : "db"),
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const target = base.target;
    const recorder = new ApiSloRecorder(base.windowCapacity);
    // Seed with a few well-formed samples so percentile invariants are testable.
    for (const request of base.requests) recorder.recordRequest(request);
    for (const ms of base.dbLatencies) recorder.recordDbLatency(ms);
    recorder.recordPoolSample(base.pool);
    const before = recorder.snapshot();
    const mutated = materialize(
      target === "requests" ? base.requests : target === "pool" ? base.pool : base.dbLatencies,
      mutations,
    ).value;
    return runGuarded(
      () => {
        if (target === "requests") {
          const list = Array.isArray(mutated) ? mutated : [mutated];
          for (const request of list) {
            recorder.recordRequest(request as SloBase["requests"][number]);
          }
        } else if (target === "pool") {
          recorder.recordPoolSample(mutated as PoolSaturationSample);
        } else {
          const list = Array.isArray(mutated) ? mutated : [mutated];
          for (const ms of list) recorder.recordDbLatency(ms as number);
        }
        return recorder.snapshot();
      },
      (snap) => {
        const problems = snapshotProblems(snap, "snapshot");
        if (snap.requestCount < before.requestCount || snap.fiveXxCount < before.fiveXxCount) {
          problems.push("monotonic counters decreased");
        }
        return problems;
      },
    );
  },
};

const SNAPSHOT_FIELDS: FieldSpec[] = [
  { path: ["requestCount"], kind: "number" },
  { path: ["fiveXxCount"], kind: "number" },
  { path: ["availability"], kind: "number" },
  { path: ["fiveXxRate"], kind: "number" },
  { path: ["latency"], kind: "object" },
  { path: ["latency", "p50"], kind: "number" },
  { path: ["latency", "p95"], kind: "number" },
  { path: ["latency", "p99"], kind: "number" },
  { path: ["latency", "sampleCount"], kind: "number" },
  { path: ["dbLatency"], kind: "object" },
  { path: ["dbLatency", "p95"], kind: "number" },
  { path: ["pool"], kind: "object" },
  { path: ["pool", "maxSize"], kind: "number" },
  { path: ["poolSaturation"], kind: "number" },
  { path: ["mediaFiveXxCount"], kind: "number" },
];

const TARGET_FIELDS: FieldSpec[] = [
  { path: ["availability"], kind: "number" },
  { path: ["p95LatencyMs"], kind: "number" },
  { path: ["p99LatencyMs"], kind: "number" },
  { path: ["maxFiveXxRate"], kind: "number" },
  { path: ["dbP95LatencyMs"], kind: "number" },
  { path: ["maxPoolSaturation"], kind: "number" },
  { path: ["minRequestSamples"], kind: "number" },
];

const evaluateCase: StressCase<SloBase> = {
  api: "evaluateApiSlos",
  surface: "typed",
  weight: 4,
  mutationRoot: (base) => (base.target === "targets" ? base.targets : base.snapshot),
  generate(rng) {
    const onTargets = rng.chance(0.3);
    const plan = onTargets
      ? planMutations(rng, TARGET_FIELDS, { jsonOnly: false, allowText: false, objectPaths: [[]] })
      : planMutations(rng, SNAPSHOT_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[], ["latency"], ["pool"]],
        });
    return {
      category: plan.category,
      base: baseFor(onTargets ? "targets" : "snapshot"),
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const onTargets = base.target === "targets";
    const snapshot = onTargets
      ? base.snapshot
      : (materialize(base.snapshot, mutations).value as ApiSloSnapshot);
    const targets = onTargets
      ? (materialize(base.targets, mutations).value as ApiSloTargets)
      : base.targets;
    const before = stableJson([snapshot, targets]);
    const inputNonFinite = findNonFinite([snapshot, targets], "input").length > 0;
    const result = runGuarded(
      () => evaluateApiSlos(snapshot, targets),
      (evaluations) => {
        const problems: string[] = [];
        if (!Array.isArray(evaluations) || evaluations.length !== 6) {
          problems.push("did not return six evaluations");
          return problems;
        }
        for (const evaluation of evaluations) {
          if (!STATUS_SET.includes(evaluation.status)) {
            problems.push(`${evaluation.slo}.status=${describeValue(evaluation.status)}`);
          }
          // A malformed observed value may only ever fail CLOSED ("breached");
          // "met" against something that is not a finite number is a bypass.
          if (evaluation.status === "met" && !Number.isFinite(evaluation.observed)) {
            problems.push(`${evaluation.slo} met with non-finite observed`);
          }
          if (evaluation.status === "met" && !Number.isFinite(evaluation.target)) {
            problems.push(`${evaluation.slo} met against non-finite target`);
          }
        }
        if (!inputNonFinite) problems.push(...findNonFinite(evaluations, "evaluations"));
        return problems;
      },
    );
    if (stableJson([snapshot, targets]) !== before) result.violations.push("input-mutated");
    return result;
  },
};

const OBSERVATION_FIELDS: FieldSpec[] = [0, 1, 2].flatMap((i): FieldSpec[] => [
  { path: [i], kind: "object" },
  { path: [i, "depth"], kind: "number" },
  { path: [i, "oldestJobAgeMs"], kind: "number" },
  { path: [i, "jobsHandled"], kind: "number" },
  { path: [i, "jobsSeen"], kind: "number" },
]);

const QUEUE_CONFIG_FIELDS: FieldSpec[] = [
  { path: ["queue"], kind: "string" },
  { path: ["stalledAfterIdleCycles"], kind: "number" },
  { path: ["maxOldestJobAgeMs"], kind: "number" },
];

const queueMonitorCase: StressCase<SloBase> = {
  api: "QueueSloMonitor.observe",
  surface: "typed",
  weight: 3,
  mutationRoot: (base) => (base.target === "config" ? base.queueConfig : base.observations),
  generate(rng) {
    const onConfig = rng.chance(0.3);
    const plan = onConfig
      ? planMutations(rng, QUEUE_CONFIG_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[]],
        })
      : planMutations(rng, OBSERVATION_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[0], [1], [2]],
        });
    return {
      category: plan.category,
      base: baseFor(onConfig ? "config" : "observations"),
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const onConfig = base.target === "config";
    const config = onConfig
      ? (materialize(base.queueConfig, mutations).value as QueueSloConfig)
      : base.queueConfig;
    const observations = onConfig
      ? base.observations
      : (materialize(base.observations, mutations).value as unknown);
    const monitor = new QueueSloMonitor(config);
    return runGuarded(
      () => {
        const list = Array.isArray(observations) ? observations : [observations];
        const alerts = list.map((o) => monitor.observe(o as QueueCycleObservation));
        return { alerts, idle: monitor.consecutiveIdleCycles() };
      },
      (out) => {
        const problems: string[] = [];
        if (!Number.isInteger(out.idle) || out.idle < 0) {
          problems.push(`consecutiveIdleCycles=${describeValue(out.idle)}`);
        }
        for (const alert of out.alerts) {
          if (alert === null) continue;
          if (alert.kind !== "queue_stalled")
            problems.push(`alert.kind=${describeValue(alert.kind)}`);
          if (!["no_progress", "oldest_job_age_exceeded"].includes(alert.reason)) {
            problems.push(`alert.reason=${describeValue(alert.reason)}`);
          }
          if (typeof alert.queue !== "string") problems.push("alert.queue not a string");
          if (
            alert.reason === "no_progress" &&
            typeof config.stalledAfterIdleCycles === "number" &&
            alert.consecutiveIdleCycles < config.stalledAfterIdleCycles
          ) {
            problems.push("no_progress alert before the idle threshold");
          }
        }
        problems.push(...findNonFinite(out.alerts, "alerts"));
        return problems;
      },
    );
  },
};

const latencyWindowCase: StressCase<SloBase> = {
  api: "LatencyWindow",
  surface: "typed",
  weight: 2,
  mutationRoot: (base) => ({
    capacity: base.windowCapacity,
    samples: [10, 20, 30, 40, 50],
    p: base.percentile,
  }),
  generate(rng) {
    const plan = planMutations(
      rng,
      [
        { path: ["capacity"], kind: "number" },
        { path: ["samples", 0], kind: "number" },
        { path: ["samples", 3], kind: "number" },
        { path: ["p"], kind: "number" },
      ],
      { jsonOnly: false, allowText: false, objectPaths: [["samples"]] },
    );
    return { category: plan.category, base: baseFor("window"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const { value } = materialize(
      { capacity: base.windowCapacity, samples: [10, 20, 30, 40, 50], p: base.percentile },
      mutations,
    );
    const args = value as { capacity: number; samples: unknown; p: number };
    return runGuarded(
      () => {
        const window = new LatencyWindow(args.capacity);
        const list = Array.isArray(args.samples) ? Array.from(args.samples) : [args.samples];
        for (const sample of list) window.record(sample as number);
        return { count: window.count(), pct: window.percentile(args.p), recorded: list };
      },
      (out) => {
        const problems: string[] = [];
        if (!Number.isInteger(out.count) || out.count < 0)
          problems.push(`count=${describeValue(out.count)}`);
        const finiteNonNegative = out.recorded.filter(
          (s): s is number => typeof s === "number" && Number.isFinite(s) && s >= 0,
        );
        if (out.count > finiteNonNegative.length) {
          problems.push(`count ${out.count} exceeds ${finiteNonNegative.length} valid samples`);
        }
        if (out.pct !== null) {
          if (!Number.isFinite(out.pct)) problems.push(`percentile=${describeValue(out.pct)}`);
          if (!finiteNonNegative.includes(out.pct))
            problems.push("percentile not among recorded samples");
        } else if (out.count > 0) {
          problems.push("null percentile with samples present");
        }
        return problems;
      },
    );
  },
};

/* ------------------------------------------------------------------------ */
/* Known gaps (reproduced, documented behaviour — see the campaign report)   */
/* ------------------------------------------------------------------------ */

const RECORDER_API = "ApiSloRecorder.recordRequest/recordDbLatency/recordPoolSample/snapshot";

const KNOWN_GAPS: KnownGap[] = [
  typedShapeGap(
    "SLO-TYPED-NO-GUARDS",
    "index.ts applies no runtime guard to its typed arguments: a non-string route crashes " +
      "recordRequest (`route.startsWith is not a function`), a snapshot without `latency` " +
      "crashes evaluateApiSlos, a Symbol pool count crashes snapshot(), and a non-numeric " +
      "LatencyWindow capacity / percentile `p` passes the `< 1` / `(0, 100]` checks (NaN " +
      "comparisons are false) and yields a non-integer count() or a null percentile.",
  ),
  {
    id: "SLO-EVAL-NONFINITE-FAIL-OPEN",
    finding:
      "evaluateApiSlos() compares observed vs target with plain `<=` / `>=` and never checks " +
      "finiteness, so a snapshot value of -Infinity (or a target of +Infinity) evaluates to " +
      "'met' — the SLO is silently satisfied by a non-finite number instead of being reported " +
      "not_evaluable/breached.",
    matches: (row) =>
      row.api === "evaluateApiSlos" &&
      row.outcome === "returned-invalid" &&
      row.violations.length === 0 &&
      row.detail
        .split("; ")
        .every((p) => / met (with non-finite observed|against non-finite target)$/.test(p)),
  },
  {
    id: "SLO-POOL-SAMPLE-UNVALIDATED",
    finding:
      "ApiSloRecorder.recordPoolSample() stores the sample verbatim (own __proto__ keys " +
      "included) and snapshot() derives poolSaturation = (total - idle + waiting) / maxSize " +
      "without validating the counts: a missing/non-numeric count yields poolSaturation = NaN " +
      "and a fractional/inconsistent count yields a negative saturation. evaluateApiSlos() then " +
      "fails CLOSED (NaN <= target is false → 'breached'), so the SLO is not bypassed, but the " +
      "non-finite value is emitted in the snapshot.",
    matches: (row) =>
      row.api === RECORDER_API &&
      row.outcome === "returned-invalid" &&
      row.violations.length === 0 &&
      row.detail.includes("pool"),
  },
];

describe("slo boundary/malformed stress", () => {
  it(
    "never throws from the recorder path and never emits NaN/Infinity verdicts",
    () => {
      const report = runCampaign<SloBase>({
        pkg: "slo",
        cases: [recorderCase, evaluateCase, queueMonitorCase, latencyWindowCase],
        knownGaps: KNOWN_GAPS,
      });
      const path = writeReport(report, outputDir(REPO_ROOT));
      expect(campaignVerdict(report, path)).toBeNull();
    },
    campaignTimeoutMs(),
  );
});
