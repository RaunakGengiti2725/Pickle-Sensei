import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  DEFAULT_QUEUE_SLO_CONFIG,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
  type ApiSloSnapshot,
  type QueueCycleObservation,
  type SloEvaluation,
} from "../../src/index.js";
import {
  SeededRng,
  type IterationOutcome,
  digestOf,
  nonFinitePaths,
  nondeterministicSeeds,
  runLeakCampaign,
  stressIterations,
  summarizeReport,
  writeReportIfRequested,
} from "../../../../tools/stress/leakHarness.js";

/**
 * LONG-RUN LEAK lens for @pickle/slo. Synthetic seeded streams only — no
 * production telemetry, no fixtures under datasets/. Default budget is small;
 * STRESS_ITER=500 runs the full campaign (STRESS_OUT=<dir> writes the JSON
 * seed → outcome table).
 */

const ITER = stressIterations(60);
const BASE_SEED = 0x5107_0001;
const SLO_STATUSES = new Set(["met", "breached", "not_evaluable"]);

function randomLatency(rng: SeededRng): number {
  const roll = rng.next();
  if (roll < 0.02) return Number.NaN;
  if (roll < 0.04) return Number.POSITIVE_INFINITY;
  if (roll < 0.06) return -rng.int(1, 1000);
  if (roll < 0.1) return rng.int(2000, 60_000);
  return rng.next() * 800;
}

function randomStatus(rng: SeededRng): number {
  const roll = rng.next();
  if (roll < 0.85) return 200;
  if (roll < 0.93) return rng.pick([400, 401, 404, 409, 429]);
  return rng.pick([500, 502, 503, 504]);
}

function randomObservation(rng: SeededRng): QueueCycleObservation {
  const depth = rng.chance(0.3) ? 0 : rng.int(0, 500);
  return {
    depth,
    oldestJobAgeMs: rng.chance(0.2) ? null : rng.int(0, 30 * 60 * 1000),
    jobsHandled: rng.chance(0.4) ? 0 : rng.int(0, 50),
    jobsSeen: rng.chance(0.3) ? 0 : rng.int(0, 60),
  };
}

function assertSnapshotSane(
  snapshot: ApiSloSnapshot,
  windowSize: number,
  problems: string[],
): void {
  problems.push(...nonFinitePaths(snapshot, "snapshot"));
  if (snapshot.latency.sampleCount > windowSize) {
    problems.push(`latency window overflowed: ${snapshot.latency.sampleCount} > ${windowSize}`);
  }
  if (snapshot.dbLatency.sampleCount > windowSize) {
    problems.push(`db window overflowed: ${snapshot.dbLatency.sampleCount} > ${windowSize}`);
  }
  if (snapshot.availability !== null && (snapshot.availability < 0 || snapshot.availability > 1)) {
    problems.push(`availability out of [0,1]: ${snapshot.availability}`);
  }
  if (snapshot.fiveXxCount > snapshot.requestCount) problems.push("fiveXx > requests");
  if (snapshot.mediaFiveXxCount > snapshot.fiveXxCount) problems.push("mediaFiveXx > fiveXx");
  const { p50, p95, p99 } = snapshot.latency;
  if (p50 !== null && p95 !== null && p99 !== null && !(p50 <= p95 && p95 <= p99)) {
    problems.push(`percentiles not monotone: ${p50} ${p95} ${p99}`);
  }
}

function assertEvaluationsSane(evaluations: SloEvaluation[], problems: string[]): void {
  if (evaluations.length !== 6) problems.push(`expected 6 evaluations, got ${evaluations.length}`);
  for (const evaluation of evaluations) {
    if (!SLO_STATUSES.has(evaluation.status)) problems.push(`bad status ${evaluation.status}`);
    problems.push(...nonFinitePaths(evaluation, `eval.${evaluation.slo}`));
    if (evaluation.status !== "not_evaluable" && evaluation.observed === null) {
      problems.push(`${evaluation.slo}: evaluable with null observed`);
    }
  }
}

/** Fresh recorder + monitor per iteration: the mount/unmount shape of the lens. */
function freshUnitIteration(seed: number): IterationOutcome {
  const rng = new SeededRng(seed);
  const windowSize = rng.int(1, 2048);
  const requests = rng.int(0, 3000);
  const recorder = new ApiSloRecorder(windowSize);
  const monitor = new QueueSloMonitor({
    ...DEFAULT_QUEUE_SLO_CONFIG,
    stalledAfterIdleCycles: rng.int(1, 6),
    maxOldestJobAgeMs: rng.chance(0.2) ? null : rng.int(1000, 20 * 60 * 1000),
  });
  const problems: string[] = [];

  for (let i = 0; i < requests; i += 1) {
    recorder.recordRequest({
      route: rng.chance(0.15) ? "/v1/media/upload" : "/v1/shots",
      statusCode: randomStatus(rng),
      latencyMs: randomLatency(rng),
    });
    if (rng.chance(0.5)) recorder.recordDbLatency(randomLatency(rng));
    if (rng.chance(0.05)) {
      recorder.recordPoolSample({
        totalCount: rng.int(0, 20),
        idleCount: rng.int(0, 20),
        waitingCount: rng.int(0, 10),
        maxSize: rng.chance(0.2) ? null : rng.int(0, 20),
      });
    }
  }
  const snapshot = recorder.snapshot();
  assertSnapshotSane(snapshot, windowSize, problems);
  const evaluations = evaluateApiSlos(snapshot, {
    ...DEFAULT_API_SLO_TARGETS,
    minRequestSamples: rng.int(0, 500),
  });
  assertEvaluationsSane(evaluations, problems);

  const cycles = rng.int(1, 300);
  let alerts = 0;
  for (let c = 0; c < cycles; c += 1) {
    const alert = monitor.observe(randomObservation(rng));
    if (alert !== null) {
      alerts += 1;
      problems.push(...nonFinitePaths(alert, "alert"));
      if (alert.consecutiveIdleCycles !== monitor.consecutiveIdleCycles()) {
        problems.push("alert idle count diverges from monitor");
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));

  return {
    outcome: `${evaluations.filter((e) => e.status === "breached").length}breached/${alerts}alerts`,
    digest: digestOf({ snapshot, evaluations, alerts, idle: monitor.consecutiveIdleCycles() }),
    retainables: [recorder, monitor, snapshot, evaluations],
    detail: { windowSize, requests, cycles, alerts },
  };
}

describe("slo long-run leak (seeded, one process)", { timeout: 30_000 + ITER * 400 }, () => {
  it(`fresh recorder+monitor per iteration stays flat over ${ITER} iterations`, async () => {
    const report = await runLeakCampaign({
      name: "slo.fresh-unit",
      baseSeed: BASE_SEED,
      iterations: ITER,
      run: freshUnitIteration,
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

  it(`one long-lived recorder absorbs ${ITER}×1000 samples with a bounded window`, async () => {
    const windowSize = 512;
    const recorder = new ApiSloRecorder(windowSize);
    const monitor = new QueueSloMonitor();
    const report = await runLeakCampaign({
      name: "slo.long-lived-recorder",
      baseSeed: BASE_SEED + 100_000,
      iterations: ITER,
      run: (seed) => {
        const rng = new SeededRng(seed);
        for (let i = 0; i < 1000; i += 1) {
          recorder.recordRequest({
            route: "/v1/shots",
            statusCode: randomStatus(rng),
            latencyMs: randomLatency(rng),
          });
          recorder.recordDbLatency(randomLatency(rng));
        }
        monitor.observe(randomObservation(rng));
        const snapshot = recorder.snapshot();
        const problems: string[] = [];
        assertSnapshotSane(snapshot, windowSize, problems);
        if (snapshot.latency.sampleCount !== windowSize) {
          problems.push(`window not full after 1000 records: ${snapshot.latency.sampleCount}`);
        }
        assertEvaluationsSane(evaluateApiSlos(snapshot), problems);
        if (problems.length > 0) throw new Error(problems.join("; "));
        return {
          outcome: `req=${snapshot.requestCount}`,
          digest: digestOf(snapshot),
          retainables: [snapshot],
        };
      },
    });
    const path = writeReportIfRequested(report);
    console.log(summarizeReport(report), path ?? "");

    expect(report.gcForced).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.retained.maxAtAnyCheckpoint).toBe(0);
    expect(report.handles.grown).toEqual({});
    // Monotonic counter spans the harness warm-up iteration plus every seeded one.
    expect(recorder.snapshot().requestCount).toBe((ITER + 1) * 1000);
    if (ITER >= 200) {
      expect(report.heap.monotoneIncreasing && report.heap.slopePctPer100 > 5).toBe(false);
    }
  });

  it("same seed → same digest (determinism), and rejected samples never enter the window", () => {
    const seeds = Array.from({ length: Math.min(ITER, 25) }, (_, i) => BASE_SEED + i);
    expect(nondeterministicSeeds(seeds, freshUnitIteration)).toEqual([]);

    const window = new LatencyWindow(3);
    window.record(Number.NaN);
    window.record(Number.NEGATIVE_INFINITY);
    window.record(-1);
    expect(window.count()).toBe(0);
    expect(window.percentile(50)).toBeNull();
    for (let i = 0; i < 10; i += 1) window.record(i);
    expect(window.count()).toBe(3);
    expect(window.percentile(100)).toBe(9);
  });
});
