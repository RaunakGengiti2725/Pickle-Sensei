import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  DEFAULT_QUEUE_SLO_CONFIG,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
} from "../src/index.js";

describe("LatencyWindow", () => {
  it("computes nearest-rank percentiles", () => {
    const w = new LatencyWindow(100);
    for (let i = 1; i <= 100; i++) w.record(i);
    expect(w.percentile(50)).toBe(50);
    expect(w.percentile(95)).toBe(95);
    expect(w.percentile(99)).toBe(99);
    expect(w.count()).toBe(100);
  });

  it("returns null when empty and slides the window when full", () => {
    const w = new LatencyWindow(3);
    expect(w.percentile(95)).toBeNull();
    w.record(1);
    w.record(2);
    w.record(3);
    w.record(1000); // evicts 1
    expect(w.percentile(99)).toBe(1000);
    expect(w.percentile(50)).toBe(3);
  });

  it("ignores non-finite and negative samples", () => {
    const w = new LatencyWindow(10);
    w.record(Number.NaN);
    w.record(-5);
    w.record(Number.POSITIVE_INFINITY);
    expect(w.count()).toBe(0);
  });
});

describe("ApiSloRecorder", () => {
  it("tracks availability, 5xx rate, latency, and media failures", () => {
    const r = new ApiSloRecorder();
    for (let i = 0; i < 98; i++)
      r.recordRequest({ route: "/v1/health", statusCode: 200, latencyMs: 10 });
    r.recordRequest({ route: "/v1/media/uploads", statusCode: 503, latencyMs: 20 });
    r.recordRequest({ route: "/v1/catalog/shot-types", statusCode: 500, latencyMs: 30 });
    const s = r.snapshot();
    expect(s.requestCount).toBe(100);
    expect(s.fiveXxCount).toBe(2);
    expect(s.availability).toBeCloseTo(0.98);
    expect(s.fiveXxRate).toBeCloseTo(0.02);
    expect(s.mediaFiveXxCount).toBe(1);
    expect(s.latency.p50).toBe(10);
  });

  it("reports null availability and no pool before any observation", () => {
    const s = new ApiSloRecorder().snapshot();
    expect(s.availability).toBeNull();
    expect(s.fiveXxRate).toBeNull();
    expect(s.pool).toBeNull();
    expect(s.poolSaturation).toBeNull();
    expect(s.dbLatency.p95).toBeNull();
  });

  it("computes pool saturation from busy/max", () => {
    const r = new ApiSloRecorder();
    r.recordPoolSample({ totalCount: 8, idleCount: 2, waitingCount: 2, maxSize: 10 });
    expect(r.snapshot().poolSaturation).toBeCloseTo(0.8);
    r.recordPoolSample({ totalCount: 8, idleCount: 2, waitingCount: 2, maxSize: null });
    expect(r.snapshot().poolSaturation).toBeNull();
  });
});

describe("evaluateApiSlos", () => {
  it("marks rate SLOs not_evaluable below the sample floor — never a fake pass", () => {
    const r = new ApiSloRecorder();
    for (let i = 0; i < 5; i++)
      r.recordRequest({ route: "/v1/health", statusCode: 200, latencyMs: 5 });
    const evals = evaluateApiSlos(r.snapshot());
    const availability = evals.find((e) => e.slo === "api_availability");
    expect(availability?.status).toBe("not_evaluable");
    expect(availability?.reason).toMatch(/fewer than/);
  });

  it("breaches availability and 5xx-rate when errors exceed target", () => {
    const r = new ApiSloRecorder();
    for (let i = 0; i < 90; i++)
      r.recordRequest({ route: "/v1/health", statusCode: 200, latencyMs: 5 });
    for (let i = 0; i < 10; i++)
      r.recordRequest({ route: "/v1/health", statusCode: 500, latencyMs: 5 });
    const evals = evaluateApiSlos(r.snapshot(), DEFAULT_API_SLO_TARGETS);
    expect(evals.find((e) => e.slo === "api_availability")?.status).toBe("breached");
    expect(evals.find((e) => e.slo === "api_5xx_rate")?.status).toBe("breached");
    expect(evals.find((e) => e.slo === "api_latency_p95")?.status).toBe("met");
  });

  it("marks db latency and pool saturation not_evaluable without a pool", () => {
    const r = new ApiSloRecorder();
    for (let i = 0; i < 200; i++)
      r.recordRequest({ route: "/v1/health", statusCode: 200, latencyMs: 5 });
    const evals = evaluateApiSlos(r.snapshot());
    expect(evals.find((e) => e.slo === "db_latency_p95")?.status).toBe("not_evaluable");
    expect(evals.find((e) => e.slo === "pool_saturation")?.status).toBe("not_evaluable");
  });

  it("breaches db latency and pool saturation past their targets", () => {
    const r = new ApiSloRecorder();
    for (let i = 0; i < 200; i++)
      r.recordRequest({ route: "/v1/health", statusCode: 200, latencyMs: 5 });
    r.recordDbLatency(5000);
    r.recordPoolSample({ totalCount: 10, idleCount: 0, waitingCount: 5, maxSize: 10 });
    const evals = evaluateApiSlos(r.snapshot());
    expect(evals.find((e) => e.slo === "db_latency_p95")?.status).toBe("breached");
    expect(evals.find((e) => e.slo === "pool_saturation")?.status).toBe("breached");
  });
});

describe("QueueSloMonitor", () => {
  const config = { queue: "media", stalledAfterIdleCycles: 3, maxOldestJobAgeMs: 60_000 };

  it("raises a typed no_progress alert after consecutive idle cycles with visible work", () => {
    const m = new QueueSloMonitor(config);
    expect(m.observe({ depth: 2, oldestJobAgeMs: 100, jobsHandled: 0, jobsSeen: 2 })).toBeNull();
    expect(m.observe({ depth: 2, oldestJobAgeMs: 200, jobsHandled: 0, jobsSeen: 2 })).toBeNull();
    const alert = m.observe({ depth: 2, oldestJobAgeMs: 300, jobsHandled: 0, jobsSeen: 2 });
    expect(alert).toEqual({
      kind: "queue_stalled",
      queue: "media",
      reason: "no_progress",
      depth: 2,
      oldestJobAgeMs: 300,
      consecutiveIdleCycles: 3,
    });
  });

  it("resets the idle counter when jobs complete", () => {
    const m = new QueueSloMonitor(config);
    m.observe({ depth: 2, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 2 });
    m.observe({ depth: 2, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 2 });
    m.observe({ depth: 1, oldestJobAgeMs: null, jobsHandled: 1, jobsSeen: 2 });
    expect(m.consecutiveIdleCycles()).toBe(0);
    expect(m.observe({ depth: 1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 1 })).toBeNull();
  });

  it("does not alert on an empty queue", () => {
    const m = new QueueSloMonitor(config);
    for (let i = 0; i < 10; i++) {
      expect(m.observe({ depth: 0, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 0 })).toBeNull();
    }
  });

  it("alerts immediately when the oldest job exceeds the age limit", () => {
    const m = new QueueSloMonitor(config);
    const alert = m.observe({ depth: 1, oldestJobAgeMs: 61_000, jobsHandled: 5, jobsSeen: 6 });
    expect(alert?.reason).toBe("oldest_job_age_exceeded");
  });

  it("stays honest when the backend cannot report age (SQS without CloudWatch)", () => {
    const m = new QueueSloMonitor(DEFAULT_QUEUE_SLO_CONFIG);
    // Age unknown: only the no_progress path can fire, and its alert carries
    // oldestJobAgeMs: null rather than a made-up number.
    m.observe({ depth: 1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 1 });
    m.observe({ depth: 1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 1 });
    const alert = m.observe({ depth: 1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 1 });
    expect(alert?.reason).toBe("no_progress");
    expect(alert?.oldestJobAgeMs).toBeNull();
  });
});
