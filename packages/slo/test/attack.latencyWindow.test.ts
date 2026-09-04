/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — LatencyWindow and the
 * SLO evaluators. `it(...)` = HELD; `it.fails(...)` = EXPECTED behaviour that
 * is currently broken (paired with an OBSERVED `it`).
 */
import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
} from "../src/index.js";

describe("S7 — LatencyWindow(1) ring buffer", () => {
  it("HELD: percentile(100) after 1000 pushes is the LAST value; count() is 1", () => {
    const w = new LatencyWindow(1);
    for (let i = 1; i <= 1000; i++) w.record(i * 1.5);
    expect(w.count()).toBe(1);
    expect(w.percentile(100)).toBe(1500);
    expect(w.percentile(50)).toBe(1500);
    expect(w.percentile(0.0001)).toBe(1500);
  });

  it("HELD: capacity=2 after 1000 pushes holds exactly the last two samples", () => {
    const w = new LatencyWindow(2);
    for (let i = 1; i <= 1000; i++) w.record(i);
    expect(w.count()).toBe(2);
    expect(w.percentile(100)).toBe(1000);
    expect(w.percentile(50)).toBe(999);
  });

  it("HELD: percentile(0) on a NON-empty window throws; percentile(100.0001) and negative p throw", () => {
    const w = new LatencyWindow(1);
    w.record(5);
    expect(() => w.percentile(0)).toThrowError(/percentile p must be in \(0, 100\]/);
    expect(() => w.percentile(-1)).toThrowError(/percentile p must be in \(0, 100\]/);
    expect(() => w.percentile(100.0001)).toThrowError(/percentile p must be in \(0, 100\]/);
    expect(() => w.percentile(Infinity)).toThrowError(/percentile p must be in \(0, 100\]/);
  });

  it("OBSERVED: percentile(0) on an EMPTY window returns null instead of throwing (emptiness check precedes validation)", () => {
    const w = new LatencyWindow(1);
    expect(w.percentile(0)).toBeNull();
    expect(w.percentile(-5)).toBeNull();
    expect(w.percentile(101)).toBeNull();
    expect(w.percentile(NaN)).toBeNull();
  });

  it("OBSERVED: percentile(NaN) on a NON-empty window returns null — indistinguishable from 'no samples'", () => {
    const w = new LatencyWindow(1);
    w.record(5);
    expect(w.percentile(NaN)).toBeNull();
  });

  it.fails("EXPECTED: percentile(NaN) is rejected like every other out-of-range p", () => {
    const w = new LatencyWindow(1);
    w.record(5);
    expect(() => w.percentile(NaN)).toThrowError();
  });

  it("HELD: non-finite and negative latencies are ignored, zero is kept", () => {
    const w = new LatencyWindow(10);
    w.record(NaN);
    w.record(Infinity);
    w.record(-Infinity);
    w.record(-1);
    w.record(0);
    expect(w.count()).toBe(1);
    expect(w.percentile(100)).toBe(0);
  });

  it("HELD: capacity 0, negative, -Infinity are rejected at construction", () => {
    expect(() => new LatencyWindow(0)).toThrowError(/capacity must be >= 1/);
    expect(() => new LatencyWindow(-1)).toThrowError(/capacity must be >= 1/);
    expect(() => new LatencyWindow(-Infinity)).toThrowError(/capacity must be >= 1/);
  });

  it("OBSERVED: capacity=NaN is ACCEPTED (NaN < 1 is false); count() is NaN and every sample after the first is LOST (written to samples['NaN'])", () => {
    const w = new LatencyWindow(NaN);
    w.record(1);
    w.record(2);
    w.record(3);
    expect(Number.isNaN(w.count())).toBe(true);
    // samples.length < NaN is false → samples[cursor=0]=1, cursor=(0+1)%NaN=NaN,
    // then samples[NaN] is a stray string-keyed property percentile() never reads.
    expect(w.percentile(100)).toBe(1);
    const raw = (w as unknown as { samples: number[] & { NaN?: number } }).samples;
    expect(raw.length).toBe(1);
    expect(raw.NaN).toBe(3);
  });

  it("OBSERVED: a fractional capacity (2.5) is ACCEPTED and writes samples at fractional indices that percentile() never sees", () => {
    const w = new LatencyWindow(2.5);
    for (let i = 1; i <= 8; i++) w.record(i);
    expect(w.count()).toBe(2.5);
    const seen = (w as unknown as { samples: number[] }).samples;
    // Array length stays 3 while "0.5"/"1.5" become string-keyed properties.
    expect(seen.length).toBe(3);
    expect(Object.keys(seen).some((k) => k.includes("."))).toBe(true);
  });

  it.fails("EXPECTED: capacity must be a positive INTEGER", () => {
    expect(() => new LatencyWindow(NaN)).toThrowError();
    expect(() => new LatencyWindow(2.5)).toThrowError();
  });

  it("HELD: nearest-rank percentiles on 1..1000 match the textbook definition", () => {
    const w = new LatencyWindow(1000);
    const shuffled = Array.from({ length: 1000 }, (_, i) => i + 1);
    let seed = 42;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j] as number, shuffled[i] as number];
    }
    for (const v of shuffled) w.record(v);
    expect(w.percentile(50)).toBe(500);
    expect(w.percentile(95)).toBe(950);
    expect(w.percentile(99)).toBe(990);
    expect(w.percentile(100)).toBe(1000);
    expect(w.percentile(0.1)).toBe(1);
  });

  it("OBSERVED: percentile(99.9) over 1..1000 returns 1000, not 999 — (99.9/100)*1000 = 999.0000000000001 and ceil rounds up", () => {
    const w = new LatencyWindow(1000);
    for (let i = 1; i <= 1000; i++) w.record(i);
    expect((99.9 / 100) * 1000).toBeGreaterThan(999);
    expect(w.percentile(99.9)).toBe(1000);
  });

  it.fails(
    "EXPECTED: nearest-rank p99.9 of 1..1000 is 999 (rank = ceil(p*n/100) computed without the fp artefact)",
    () => {
      const w = new LatencyWindow(1000);
      for (let i = 1; i <= 1000; i++) w.record(i);
      expect(w.percentile(99.9)).toBe(999);
    },
  );

  it("HELD: wrap-around keeps the window at exactly `capacity` most-recent samples (capacity 1000, 3500 pushes)", () => {
    const w = new LatencyWindow(1000);
    for (let i = 1; i <= 3500; i++) w.record(i);
    expect(w.count()).toBe(1000);
    expect(w.percentile(0.1)).toBe(2501);
    expect(w.percentile(100)).toBe(3500);
  });
});

describe("S7b — ApiSloRecorder / evaluateApiSlos edge inputs", () => {
  it("HELD: 99 requests are not_evaluable for rate SLOs; the 100th makes them evaluable", () => {
    const rec = new ApiSloRecorder();
    for (let i = 0; i < 99; i++)
      rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: 10 });
    let evals = evaluateApiSlos(rec.snapshot());
    expect(evals.find((e) => e.slo === "api_availability")?.status).toBe("not_evaluable");
    rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: 10 });
    evals = evaluateApiSlos(rec.snapshot());
    expect(evals.find((e) => e.slo === "api_availability")?.status).toBe("met");
    expect(evals.find((e) => e.slo === "api_5xx_rate")?.status).toBe("met");
  });

  it("HELD: exactly at the 5xx budget (0.5% of 1000) is met; one more 5xx breaches both rate SLOs", () => {
    const rec = new ApiSloRecorder();
    for (let i = 0; i < 995; i++)
      rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: 10 });
    for (let i = 0; i < 5; i++)
      rec.recordRequest({ route: "/v1/media/upload", statusCode: 503, latencyMs: 10 });
    let evals = evaluateApiSlos(rec.snapshot());
    expect(evals.find((e) => e.slo === "api_5xx_rate")?.status).toBe("met");
    expect(evals.find((e) => e.slo === "api_availability")?.status).toBe("met");
    expect(rec.snapshot().mediaFiveXxCount).toBe(5);
    rec.recordRequest({ route: "/v1/x", statusCode: 500, latencyMs: 10 });
    evals = evaluateApiSlos(rec.snapshot());
    expect(evals.find((e) => e.slo === "api_5xx_rate")?.status).toBe("breached");
    expect(evals.find((e) => e.slo === "api_availability")?.status).toBe("breached");
  });

  it("OBSERVED: statusCode NaN / 599 / 999 — NaN is not a 5xx; anything >= 500 (even 999) counts as 5xx", () => {
    const rec = new ApiSloRecorder();
    rec.recordRequest({ route: "/v1/x", statusCode: NaN, latencyMs: 1 });
    rec.recordRequest({ route: "/v1/x", statusCode: 599, latencyMs: 1 });
    rec.recordRequest({ route: "/v1/x", statusCode: 999, latencyMs: 1 });
    expect(rec.snapshot().fiveXxCount).toBe(2);
    expect(rec.snapshot().requestCount).toBe(3);
  });

  it("HELD: a latency SLO with a single sample IS evaluable (latency has no min-sample floor) — pinned", () => {
    const rec = new ApiSloRecorder();
    rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: 5000 });
    const evals = evaluateApiSlos(rec.snapshot());
    expect(evals.find((e) => e.slo === "api_latency_p95")?.status).toBe("breached");
    expect(evals.find((e) => e.slo === "api_latency_p99")?.status).toBe("breached");
  });

  it("OBSERVED: pool saturation can exceed 1 (waiting clients count as busy) and a zero-size pool is not_evaluable", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({ totalCount: 10, idleCount: 0, waitingCount: 5, maxSize: 10 });
    expect(rec.snapshot().poolSaturation).toBe(1.5);
    rec.recordPoolSample({ totalCount: 0, idleCount: 0, waitingCount: 0, maxSize: 0 });
    expect(rec.snapshot().poolSaturation).toBeNull();
    rec.recordPoolSample({ totalCount: 0, idleCount: 5, waitingCount: 0, maxSize: 10 });
    // idle > total → negative saturation is reported as "met" rather than rejected.
    expect(rec.snapshot().poolSaturation).toBe(-0.5);
    expect(evaluateApiSlos(rec.snapshot()).find((e) => e.slo === "pool_saturation")?.status).toBe(
      "met",
    );
  });

  it("HELD: default targets are internally consistent (availability + maxFiveXxRate == 1)", () => {
    expect(
      DEFAULT_API_SLO_TARGETS.availability + DEFAULT_API_SLO_TARGETS.maxFiveXxRate,
    ).toBeCloseTo(1, 12);
  });
});

describe("S7c — QueueSloMonitor", () => {
  it("HELD: idle streak resets on any handled job; oldest-age alert fires regardless of streak", () => {
    const m = new QueueSloMonitor({
      queue: "q",
      stalledAfterIdleCycles: 3,
      maxOldestJobAgeMs: 1000,
    });
    expect(m.observe({ depth: 1, oldestJobAgeMs: 10, jobsHandled: 0, jobsSeen: 1 })).toBeNull();
    expect(m.observe({ depth: 1, oldestJobAgeMs: 10, jobsHandled: 0, jobsSeen: 1 })).toBeNull();
    expect(m.observe({ depth: 1, oldestJobAgeMs: 10, jobsHandled: 1, jobsSeen: 1 })).toBeNull();
    expect(m.consecutiveIdleCycles()).toBe(0);
    const alert = m.observe({ depth: 0, oldestJobAgeMs: 1001, jobsHandled: 5, jobsSeen: 5 });
    expect(alert?.reason).toBe("oldest_job_age_exceeded");
  });

  it("OBSERVED: depth=-1 (backend cannot report) with jobsSeen=0 never counts as visible work — a fully opaque backend can never alert on no_progress", () => {
    const m = new QueueSloMonitor({
      queue: "q",
      stalledAfterIdleCycles: 1,
      maxOldestJobAgeMs: null,
    });
    for (let i = 0; i < 10; i++) {
      expect(
        m.observe({ depth: -1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 0 }),
      ).toBeNull();
    }
    expect(m.consecutiveIdleCycles()).toBe(0);
  });

  it("OBSERVED: NaN oldestJobAgeMs never alerts (NaN > limit is false) — an instrumentation bug silences the age check", () => {
    const m = new QueueSloMonitor({
      queue: "q",
      stalledAfterIdleCycles: 100,
      maxOldestJobAgeMs: 1,
    });
    expect(m.observe({ depth: 1, oldestJobAgeMs: NaN, jobsHandled: 0, jobsSeen: 1 })).toBeNull();
  });
});
