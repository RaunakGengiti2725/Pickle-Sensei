import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_QUEUE_SLO_CONFIG,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
  type QueueCycleObservation,
} from "../src/index.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against QueueSloMonitor
 * and the API SLO evaluator: unobservable backends, exact boundaries, clock
 * skew, NaN/Infinity, and long idle runs. HELD cases assert the safe
 * behaviour; FINDING cases pin what the code does today so the repro is
 * executable and the expected behaviour is stated in the name.
 */

const CONFIG = {
  ...DEFAULT_QUEUE_SLO_CONFIG,
  stalledAfterIdleCycles: 3,
  maxOldestJobAgeMs: 900_000,
};

describe("attack: QueueSloMonitor with an unobservable backend", () => {
  it("FINDING (documented gap): depth=null, jobsSeen=0, oldestJobAgeMs=null for 10 cycles → never alerts, idle counter never moves", () => {
    // `depth: null` violates the type (number) but is what a backend that
    // cannot report depth might hand over at runtime (JSON null). With
    // jobsSeen=0 and age unknown there is NO signal the monitor can use:
    // stall detection is silently disabled and `null` (no alert) is
    // indistinguishable from "healthy". The API SLO side exposes
    // `not_evaluable` for this; the queue monitor has no such surface.
    const monitor = new QueueSloMonitor(CONFIG);
    const observation = {
      depth: null,
      jobsSeen: 0,
      jobsHandled: 0,
      oldestJobAgeMs: null,
    } as unknown as QueueCycleObservation;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      expect(monitor.observe(observation)).toBeNull();
      expect(monitor.consecutiveIdleCycles()).toBe(0);
    }
  });

  it("FINDING (documented gap): depth=-1 (backend cannot report) + jobsSeen=0 + age null → stall undetectable for 1000 cycles", () => {
    // -1 is the DOCUMENTED "cannot report depth" sentinel. Combined with an
    // SQS backend that cannot report oldest-job age, a worker that receives
    // nothing (e.g. wrong queue URL, revoked IAM permission) is "healthy"
    // forever. Expected: a typed not_evaluable / unobservable surface.
    const monitor = new QueueSloMonitor(CONFIG);
    for (let cycle = 0; cycle < 1000; cycle += 1) {
      expect(
        monitor.observe({ depth: -1, jobsSeen: 0, jobsHandled: 0, oldestJobAgeMs: null }),
      ).toBeNull();
    }
    expect(monitor.consecutiveIdleCycles()).toBe(0);
  });

  it("HELD: depth=-1 but jobsSeen>0 with nothing handled still trips no_progress", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    let alert = null;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      alert = monitor.observe({ depth: -1, jobsSeen: 2, jobsHandled: 0, oldestJobAgeMs: null });
    }
    expect(alert?.reason).toBe("no_progress");
    expect(alert?.consecutiveIdleCycles).toBe(3);
  });

  it("HELD: depth=NaN behaves like 'no work visible' (no alert) — NaN never compares > 0", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      expect(
        monitor.observe({ depth: Number.NaN, jobsSeen: 0, jobsHandled: 0, oldestJobAgeMs: null }),
      ).toBeNull();
    }
  });
});

describe("attack: oldestJobAgeMs boundary is strict (>)", () => {
  it("HELD: age exactly equal to maxOldestJobAgeMs → no alert", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    expect(
      monitor.observe({
        depth: 1,
        jobsSeen: 1,
        jobsHandled: 1,
        oldestJobAgeMs: CONFIG.maxOldestJobAgeMs,
      }),
    ).toBeNull();
  });

  it("HELD: age = maxOldestJobAgeMs + 1 → immediate oldest_job_age_exceeded alert (even with progress)", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    const alert = monitor.observe({
      depth: 1,
      jobsSeen: 1,
      jobsHandled: 1,
      oldestJobAgeMs: CONFIG.maxOldestJobAgeMs + 1,
    });
    expect(alert).not.toBeNull();
    expect(alert?.reason).toBe("oldest_job_age_exceeded");
    expect(alert?.oldestJobAgeMs).toBe(CONFIG.maxOldestJobAgeMs + 1);
    expect(alert?.consecutiveIdleCycles).toBe(0);
  });

  it("HELD: age = max + Number.EPSILON-scale (sub-ms float) still alerts, age = max - 1 does not", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    expect(
      monitor.observe({
        depth: 1,
        jobsSeen: 1,
        jobsHandled: 1,
        oldestJobAgeMs: CONFIG.maxOldestJobAgeMs - 1,
      }),
    ).toBeNull();
    expect(
      monitor.observe({
        depth: 1,
        jobsSeen: 1,
        jobsHandled: 1,
        oldestJobAgeMs: CONFIG.maxOldestJobAgeMs + 0.001,
      })?.reason,
    ).toBe("oldest_job_age_exceeded");
  });

  it("HELD: default config boundary — 15 min exactly is quiet, 15 min + 1 ms alerts", () => {
    const monitor = new QueueSloMonitor();
    const max = DEFAULT_QUEUE_SLO_CONFIG.maxOldestJobAgeMs!;
    expect(max).toBe(15 * 60 * 1000);
    expect(
      monitor.observe({ depth: 3, jobsSeen: 1, jobsHandled: 1, oldestJobAgeMs: max }),
    ).toBeNull();
    expect(
      monitor.observe({ depth: 3, jobsSeen: 1, jobsHandled: 1, oldestJobAgeMs: max + 1 })?.reason,
    ).toBe("oldest_job_age_exceeded");
  });

  it("HELD: Infinity age alerts; negative age (clock skew: job 'from the future') is quiet", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    expect(
      monitor.observe({ depth: 1, jobsSeen: 1, jobsHandled: 1, oldestJobAgeMs: Infinity })?.reason,
    ).toBe("oldest_job_age_exceeded");
    expect(
      monitor.observe({ depth: 1, jobsSeen: 1, jobsHandled: 1, oldestJobAgeMs: -3_600_000 }),
    ).toBeNull();
  });

  it("FINDING (documented gap): NaN age never alerts — indistinguishable from a healthy young queue", () => {
    // A backend that returns NaN (e.g. Number(undefined) from a missing
    // CloudWatch attribute) is treated exactly like a fresh queue.
    const monitor = new QueueSloMonitor(CONFIG);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      expect(
        monitor.observe({ depth: 5, jobsSeen: 1, jobsHandled: 1, oldestJobAgeMs: Number.NaN }),
      ).toBeNull();
    }
  });

  it("HELD: maxOldestJobAgeMs=null disables ONLY the age check; no_progress still fires", () => {
    const monitor = new QueueSloMonitor({ ...CONFIG, maxOldestJobAgeMs: null });
    expect(
      monitor.observe({ depth: 1, jobsSeen: 1, jobsHandled: 1, oldestJobAgeMs: 1e12 }),
    ).toBeNull();
    let alert = null;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      alert = monitor.observe({ depth: 1, jobsSeen: 1, jobsHandled: 0, oldestJobAgeMs: 1e12 });
    }
    expect(alert?.reason).toBe("no_progress");
  });
});

describe("attack: idle-cycle bookkeeping under interleavings", () => {
  it("HELD: 2 idle, 1 progress, 2 idle never alerts (counter resets); the third consecutive idle does", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    const idle: QueueCycleObservation = {
      depth: 4,
      jobsSeen: 4,
      jobsHandled: 0,
      oldestJobAgeMs: 10,
    };
    const progress: QueueCycleObservation = {
      depth: 3,
      jobsSeen: 4,
      jobsHandled: 1,
      oldestJobAgeMs: 10,
    };
    expect(monitor.observe(idle)).toBeNull();
    expect(monitor.observe(idle)).toBeNull();
    expect(monitor.observe(progress)).toBeNull();
    expect(monitor.observe(idle)).toBeNull();
    expect(monitor.observe(idle)).toBeNull();
    expect(monitor.observe(idle)?.reason).toBe("no_progress");
  });

  it("HELD: alert repeats on every idle cycle after the threshold and the counter keeps growing", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    const idle: QueueCycleObservation = {
      depth: 4,
      jobsSeen: 4,
      jobsHandled: 0,
      oldestJobAgeMs: null,
    };
    for (let cycle = 1; cycle <= 50; cycle += 1) {
      const alert = monitor.observe(idle);
      if (cycle < 3) expect(alert).toBeNull();
      else expect(alert?.consecutiveIdleCycles).toBe(cycle);
    }
  });

  it("HELD: an empty cycle (depth 0, nothing seen) resets a near-threshold idle streak", () => {
    const monitor = new QueueSloMonitor(CONFIG);
    const idle: QueueCycleObservation = {
      depth: 4,
      jobsSeen: 4,
      jobsHandled: 0,
      oldestJobAgeMs: null,
    };
    monitor.observe(idle);
    monitor.observe(idle);
    monitor.observe({ depth: 0, jobsSeen: 0, jobsHandled: 0, oldestJobAgeMs: null });
    expect(monitor.consecutiveIdleCycles()).toBe(0);
    expect(monitor.observe(idle)).toBeNull();
  });

  it("FINDING (documented gap): stalledAfterIdleCycles=0 alerts no_progress on a completely empty queue", () => {
    // Misconfiguration path: with threshold 0 the `>=` check fires even
    // when idleCycles is 0 — i.e. on an EMPTY queue with no work at all.
    // Expected: the constructor rejects stalledAfterIdleCycles < 1.
    const monitor = new QueueSloMonitor({ ...CONFIG, stalledAfterIdleCycles: 0 });
    const alert = monitor.observe({ depth: 0, jobsSeen: 0, jobsHandled: 0, oldestJobAgeMs: null });
    expect(alert?.reason).toBe("no_progress");
    expect(alert?.consecutiveIdleCycles).toBe(0);
  });
});

describe("attack: LatencyWindow / ApiSloRecorder numeric edges", () => {
  it("HELD: -0 latency is recorded (it is 0), Infinity/NaN/negative are dropped", () => {
    const w = new LatencyWindow(10);
    w.record(-0);
    w.record(Infinity);
    w.record(Number.NaN);
    w.record(-1);
    expect(w.count()).toBe(1);
    expect(w.percentile(50) === 0).toBe(true); // -0 == 0
  });

  it("HELD: percentile(100) is the max, percentile(0)/(101) throw", () => {
    const w = new LatencyWindow(10);
    [5, 1, 9].forEach((v) => w.record(v));
    expect(w.percentile(100)).toBe(9);
    expect(() => w.percentile(0)).toThrow();
    expect(() => w.percentile(101)).toThrow();
  });

  it("HELD: capacity < 1 throws; capacity 1 slides correctly", () => {
    expect(() => new LatencyWindow(0)).toThrow();
    const w = new LatencyWindow(1);
    w.record(5);
    w.record(7);
    expect(w.count()).toBe(1);
    expect(w.percentile(50)).toBe(7);
  });

  it("FINDING (documented gap): fractional capacity (2.5) makes count() report a non-integer sample count", () => {
    // capacity is not validated as an integer; samples.length caps at 3 but
    // count() returns 2.5 once the window is "filled".
    const w = new LatencyWindow(2.5);
    w.record(1);
    w.record(2);
    w.record(3);
    w.record(4);
    expect(w.count()).toBe(2.5);
  });

  it("HELD: a 5xx storm with requestCount below minRequestSamples stays not_evaluable, never 'met'", () => {
    const rec = new ApiSloRecorder();
    for (let i = 0; i < 99; i += 1) {
      rec.recordRequest({ route: "/v1/media/upload", statusCode: 500, latencyMs: 10 });
    }
    const evals = evaluateApiSlos(rec.snapshot());
    const availability = evals.find((e) => e.slo === "api_availability");
    expect(availability?.status).toBe("not_evaluable");
    expect(evals.some((e) => e.status === "met" && e.slo === "api_availability")).toBe(false);
    rec.recordRequest({ route: "/v1/media/upload", statusCode: 500, latencyMs: 10 });
    expect(evaluateApiSlos(rec.snapshot()).find((e) => e.slo === "api_availability")?.status).toBe(
      "breached",
    );
  });

  it("HELD: a pool sample with idleCount > totalCount (corrupt) yields negative busy → saturation ≤ 0, never breached; maxSize 0 → not_evaluable", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({ totalCount: 2, idleCount: 5, waitingCount: 0, maxSize: 10 });
    const s = rec.snapshot();
    expect(s.poolSaturation).toBeLessThanOrEqual(0);
    rec.recordPoolSample({ totalCount: 2, idleCount: 0, waitingCount: 0, maxSize: 0 });
    expect(rec.snapshot().poolSaturation).toBeNull();
    expect(evaluateApiSlos(rec.snapshot()).find((e) => e.slo === "pool_saturation")?.status).toBe(
      "not_evaluable",
    );
  });
});
