import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
  type ApiSloTargets,
  type QueueSloConfig,
  type SloEvaluation,
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
 * SEEDED RANDOMIZED LONG-RUN over the SLO recorder / evaluator / queue monitor.
 *
 * Model-checked invariants (src/index.ts doc comments), checked after every step
 * against an independent reference model:
 *  S1  counters are monotonic and exact: requestCount, fiveXxCount (status>=500),
 *      mediaFiveXxCount (5xx on routes starting with /v1/media).
 *  S2  availability = 1 - 5xx/total and fiveXxRate = 5xx/total; both null until
 *      the first request; availability + fiveXxRate === 1 (within 1e-12).
 *  S3  latency windows are bounded sliding windows: count() <= capacity, the
 *      nearest-rank percentiles equal the model over the last `capacity` VALID
 *      samples, and p50 <= p95 <= p99.
 *  S4  non-finite or negative latency samples are dropped (never enter the window).
 *  S5  evaluateApiSlos returns the six SLOs in fixed order; status is
 *      met/breached exactly by observed-vs-target, not_evaluable iff observed is
 *      null or (rate SLOs) requestCount < minRequestSamples, and every
 *      not_evaluable carries a reason.
 *  S6  poolSaturation = (total - idle + waiting) / maxSize when maxSize > 0, else null.
 *  S7  no NaN/Infinity anywhere in snapshot or evaluations for finite inputs
 *      (NaN/±Infinity latencies are the near-legal inputs that S4 must absorb).
 *  Q1  QueueSloMonitor: idle cycles count consecutive observations with visible
 *      work (depth>0 or jobsSeen>0) and jobsHandled===0, reset otherwise;
 *      oldest_job_age_exceeded fires iff age > max (max !== null);
 *      no_progress fires iff idleCycles >= stalledAfterIdleCycles (age check wins).
 *  D   same seed → identical trace (kit-level).
 */

type Action =
  | { kind: "request"; route: number; status: number; latency: number }
  | { kind: "db"; latency: number }
  | { kind: "pool"; total: number; idle: number; waiting: number; max: number | null }
  | { kind: "evaluate"; targets: number }
  | { kind: "queue"; depth: number; age: number | null; handled: number; seen: number };

const ROUTES = ["/v1/media/upload", "/v1/media", "/v1/shots", "/healthz", "/v1/mediaX"];
const LATENCIES = [0, 1, 12.5, 250, 499.999, 500, 500.001, 1999, 2000, 2001, 15000];
const WEIRD_LATENCIES = [
  -1,
  -0.0001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function randomLatency(rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.1) return rng.pick(WEIRD_LATENCIES);
  if (roll < 0.4) return rng.pick(LATENCIES);
  return rng.float(0, 3000);
}

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.45) {
      actions.push({
        kind: "request",
        route: rng.int(ROUTES.length),
        status: rng.pick([200, 201, 204, 400, 404, 429, 499, 500, 502, 503, 599]),
        latency: randomLatency(rng),
      });
    } else if (roll < 0.6) {
      actions.push({ kind: "db", latency: randomLatency(rng) });
    } else if (roll < 0.7) {
      const total = rng.int(21);
      actions.push({
        kind: "pool",
        total,
        idle: rng.int(total + 1),
        waiting: rng.int(5),
        max: rng.bool(0.15) ? null : rng.bool(0.1) ? 0 : rng.range(1, 25),
      });
    } else if (roll < 0.85) {
      actions.push({ kind: "evaluate", targets: rng.int(4) });
    } else {
      actions.push({
        kind: "queue",
        depth: rng.pick([-1, 0, 0, 1, 3, 50]),
        age: rng.bool(0.2)
          ? null
          : rng.pick([0, 1000, 14 * 60 * 1000, 15 * 60 * 1000, 15 * 60 * 1000 + 1, 60 * 60 * 1000]),
        handled: rng.pick([0, 0, 1, 2]),
        seen: rng.pick([0, 1, 2, 5]),
      });
    }
  }
  return actions;
}

const TARGET_SETS: readonly ApiSloTargets[] = [
  DEFAULT_API_SLO_TARGETS,
  { ...DEFAULT_API_SLO_TARGETS, minRequestSamples: 1 },
  { ...DEFAULT_API_SLO_TARGETS, minRequestSamples: 10, p95LatencyMs: 250, maxPoolSaturation: 0.5 },
  { ...DEFAULT_API_SLO_TARGETS, minRequestSamples: 0, availability: 1, maxFiveXxRate: 0 },
];

const WINDOW = 16;
const QUEUE_CONFIG: QueueSloConfig = {
  queue: "media",
  stalledAfterIdleCycles: 3,
  maxOldestJobAgeMs: 15 * 60 * 1000,
};

class ModelWindow {
  readonly samples: number[] = [];
  constructor(private readonly capacity: number) {}
  record(v: number): void {
    if (!Number.isFinite(v) || v < 0) return;
    this.samples.push(v);
    if (this.samples.length > this.capacity) this.samples.shift();
  }
  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(Math.ceil((p / 100) * sorted.length), sorted.length) - 1]!;
  }
}

function checkEvaluation(
  evaluation: SloEvaluation,
  observed: number | null,
  ok: boolean,
  evaluable: boolean,
): void {
  check(
    evaluation.observed === observed ||
      (observed !== null &&
        evaluation.observed !== null &&
        Math.abs(evaluation.observed - observed) < 1e-12),
    "S5 observed",
    () => `${evaluation.slo}: ${String(evaluation.observed)} != ${String(observed)}`,
  );
  const expected = !evaluable ? "not_evaluable" : ok ? "met" : "breached";
  check(
    evaluation.status === expected,
    "S5 status",
    () => `${evaluation.slo}: ${evaluation.status} != ${expected}`,
  );
  check(
    evaluation.status !== "not_evaluable" ||
      (typeof evaluation.reason === "string" && evaluation.reason.length > 0),
    "S5 reason",
    () => evaluation.slo,
  );
}

function execute(actions: readonly Action[]) {
  const recorder = new ApiSloRecorder(WINDOW);
  const queue = new QueueSloMonitor(QUEUE_CONFIG);
  const model = {
    requests: 0,
    fiveXx: 0,
    media: 0,
    latency: new ModelWindow(WINDOW),
    db: new ModelWindow(WINDOW),
    pool: null as Action | null,
    idle: 0,
  };

  const checkSnapshot = () => {
    const s = recorder.snapshot();
    check(
      s.requestCount === model.requests &&
        s.fiveXxCount === model.fiveXx &&
        s.mediaFiveXxCount === model.media,
      "S1 counters",
      () => JSON.stringify(s),
    );
    if (model.requests === 0) {
      check(
        s.availability === null && s.fiveXxRate === null,
        "S2 null before first request",
        () => "",
      );
    } else {
      check(
        s.availability !== null &&
          s.fiveXxRate !== null &&
          Math.abs(s.availability - (1 - model.fiveXx / model.requests)) < 1e-12 &&
          Math.abs(s.availability + s.fiveXxRate - 1) < 1e-12,
        "S2 availability",
        () => JSON.stringify(s),
      );
    }
    for (const [name, actual, expected] of [
      ["latency", s.latency, model.latency],
      ["dbLatency", s.dbLatency, model.db],
    ] as const) {
      check(
        actual.p50 === expected.percentile(50) &&
          actual.p95 === expected.percentile(95) &&
          actual.p99 === expected.percentile(99),
        "S3 percentiles",
        () => `${name}: ${JSON.stringify(actual)} model=${JSON.stringify(expected.samples)}`,
      );
      check(
        actual.sampleCount === expected.samples.length && actual.sampleCount <= WINDOW,
        "S3 count",
        () => `${name}: ${actual.sampleCount} != ${expected.samples.length}`,
      );
      check(
        actual.p50 === null || (actual.p50 <= actual.p95! && actual.p95! <= actual.p99!),
        "S3 monotone",
        () => JSON.stringify(actual),
      );
    }
    const pool = model.pool;
    if (pool === null || pool.kind !== "pool") {
      check(s.pool === null && s.poolSaturation === null, "S6 no pool", () => "");
    } else {
      const busy = pool.total - pool.idle + pool.waiting;
      const expected = pool.max !== null && pool.max > 0 ? busy / pool.max : null;
      check(
        s.poolSaturation === expected,
        "S6 saturation",
        () => `${String(s.poolSaturation)} != ${String(expected)}`,
      );
    }
    const nonFinite = findNonFinite(s);
    check(nonFinite === null, "S7 finite snapshot", () => nonFinite ?? "");
    return s;
  };

  return executeSteps(actions, (action) => {
    switch (action.kind) {
      case "request": {
        const route = ROUTES[action.route]!;
        recorder.recordRequest({ route, statusCode: action.status, latencyMs: action.latency });
        model.requests += 1;
        if (action.status >= 500) {
          model.fiveXx += 1;
          if (route.startsWith("/v1/media")) model.media += 1;
        }
        model.latency.record(action.latency);
        const s = checkSnapshot();
        return { request: action.status, count: s.latency.sampleCount };
      }
      case "db": {
        recorder.recordDbLatency(action.latency);
        model.db.record(action.latency);
        checkSnapshot();
        return { db: Number.isFinite(action.latency) && action.latency >= 0 ? "kept" : "dropped" };
      }
      case "pool": {
        recorder.recordPoolSample({
          totalCount: action.total,
          idleCount: action.idle,
          waitingCount: action.waiting,
          maxSize: action.max,
        });
        model.pool = action;
        const s = checkSnapshot();
        return { pool: s.poolSaturation };
      }
      case "evaluate": {
        const targets = TARGET_SETS[action.targets]!;
        const s = checkSnapshot();
        const evaluations = evaluateApiSlos(s, targets);
        check(
          evaluations.map((e) => e.slo).join(",") ===
            "api_availability,api_5xx_rate,api_latency_p95,api_latency_p99,db_latency_p95,pool_saturation",
          "S5 order",
          () => evaluations.map((e) => e.slo).join(","),
        );
        const enough = s.requestCount >= targets.minRequestSamples;
        checkEvaluation(
          evaluations[0]!,
          s.availability,
          (s.availability ?? 0) >= targets.availability,
          s.availability !== null && enough,
        );
        checkEvaluation(
          evaluations[1]!,
          s.fiveXxRate,
          (s.fiveXxRate ?? 1) <= targets.maxFiveXxRate,
          s.fiveXxRate !== null && enough,
        );
        checkEvaluation(
          evaluations[2]!,
          s.latency.p95,
          (s.latency.p95 ?? Infinity) <= targets.p95LatencyMs,
          s.latency.p95 !== null,
        );
        checkEvaluation(
          evaluations[3]!,
          s.latency.p99,
          (s.latency.p99 ?? Infinity) <= targets.p99LatencyMs,
          s.latency.p99 !== null,
        );
        checkEvaluation(
          evaluations[4]!,
          s.dbLatency.p95,
          (s.dbLatency.p95 ?? Infinity) <= targets.dbP95LatencyMs,
          s.dbLatency.p95 !== null,
        );
        checkEvaluation(
          evaluations[5]!,
          s.poolSaturation,
          (s.poolSaturation ?? Infinity) <= targets.maxPoolSaturation,
          s.poolSaturation !== null,
        );
        const nonFinite = findNonFinite(evaluations);
        check(nonFinite === null, "S7 finite evaluations", () => nonFinite ?? "");
        return { evaluate: evaluations.map((e) => e.status) };
      }
      case "queue": {
        const alert = queue.observe({
          depth: action.depth,
          oldestJobAgeMs: action.age,
          jobsHandled: action.handled,
          jobsSeen: action.seen,
        });
        const workVisible = action.depth > 0 || action.seen > 0;
        model.idle = workVisible && action.handled === 0 ? model.idle + 1 : 0;
        check(
          queue.consecutiveIdleCycles() === model.idle,
          "Q1 idle cycles",
          () => `${queue.consecutiveIdleCycles()} != ${model.idle}`,
        );
        const ageExceeded =
          QUEUE_CONFIG.maxOldestJobAgeMs !== null &&
          action.age !== null &&
          action.age > QUEUE_CONFIG.maxOldestJobAgeMs;
        const expectedReason = ageExceeded
          ? "oldest_job_age_exceeded"
          : model.idle >= QUEUE_CONFIG.stalledAfterIdleCycles
            ? "no_progress"
            : null;
        check(
          (alert?.reason ?? null) === expectedReason,
          "Q1 alert reason",
          () => `${String(alert?.reason)} != ${String(expectedReason)}`,
        );
        if (alert !== null) {
          check(
            alert.kind === "queue_stalled" &&
              alert.queue === QUEUE_CONFIG.queue &&
              alert.depth === action.depth &&
              alert.oldestJobAgeMs === action.age &&
              alert.consecutiveIdleCycles === model.idle,
            "Q1 alert payload",
            () => JSON.stringify(alert),
          );
        }
        return { queue: alert?.reason ?? null, idle: model.idle };
      }
    }
  });
}

const env = readStressEnv(300);

describe("slo seeded randomized long-run", () => {
  it("invariants S1–S7 and Q1 hold for every seed and every step; same seed → same trace", () => {
    const report = runCampaign<Action>({
      campaign: "slo",
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

  it("LatencyWindow rejects an out-of-range percentile once it holds samples", () => {
    const window = new LatencyWindow(4);
    window.record(1);
    expect(() => window.percentile(0)).toThrow();
    expect(() => window.percentile(101)).toThrow();
    expect(window.percentile(100)).toBe(1);
  });
});
