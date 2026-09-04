/**
 * Adversarial pass 3 (tester #4) — @pickle/slo.
 *
 * Attacks: monotonic-counter dilution (a total outage that the availability
 * SLO can never see once the process has history), corrupt/degenerate pool
 * samples, NaN/negative status codes and latencies, NaN percentile, queue
 * monitor with clock skew / negative counters / NaN age, 100k rapid samples.
 *
 * Tests named REPRO pin the observed (broken or questionable) behaviour;
 * the paired `it.fails` test states the expected behaviour so the pin flips
 * loudly when the code is fixed.
 */
import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  DEFAULT_QUEUE_SLO_CONFIG,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
} from "../src/index.js";

function ok(rec: ApiSloRecorder, n: number, latencyMs = 50): void {
  for (let i = 0; i < n; i++) rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs });
}
function bad(rec: ApiSloRecorder, n: number, latencyMs = 50): void {
  for (let i = 0; i < n; i++) rec.recordRequest({ route: "/v1/x", statusCode: 503, latencyMs });
}
function byId(rec: ApiSloRecorder) {
  return new Map(evaluateApiSlos(rec.snapshot()).map((e) => [e.slo, e]));
}

describe("availability counters are monotonic since construction", () => {
  it("REPRO: after 1,000,000 good requests, 4,999 CONSECUTIVE 5xx (a total outage) still reports availability + 5xx-rate as met", () => {
    const rec = new ApiSloRecorder();
    ok(rec, 1_000_000);
    bad(rec, 4_999);
    const m = byId(rec);
    expect(m.get("api_availability")!.status).toBe("met");
    expect(m.get("api_5xx_rate")!.status).toBe("met");
    expect(m.get("api_5xx_rate")!.observed).toBeLessThan(DEFAULT_API_SLO_TARGETS.maxFiveXxRate);
    // latency percentiles DO reflect the recent window — the two halves of the
    // snapshot describe different time horizons.
    expect(rec.snapshot().latency.sampleCount).toBe(1000);
  });

  it.fails(
    "EXPECTED: the rate SLOs are evaluated over a bounded recent window, so a 100%-failure stretch breaches (BROKEN, P2)",
    () => {
      const rec = new ApiSloRecorder();
      ok(rec, 1_000_000);
      bad(rec, 4_999);
      expect(byId(rec).get("api_availability")!.status).toBe("breached");
    },
  );

  it("the same outage at process start IS detected (the dilution needs history)", () => {
    const rec = new ApiSloRecorder();
    ok(rec, 100);
    bad(rec, 100);
    expect(byId(rec).get("api_availability")!.status).toBe("breached");
  });
});

describe("degenerate request inputs", () => {
  it("statusCode NaN / negative / 0 are counted as requests but never as 5xx (pin)", () => {
    const rec = new ApiSloRecorder();
    for (const statusCode of [Number.NaN, -1, 0, 499.9999]) {
      rec.recordRequest({ route: "/v1/x", statusCode, latencyMs: 1 });
    }
    const s = rec.snapshot();
    expect(s.requestCount).toBe(4);
    expect(s.fiveXxCount).toBe(0);
    expect(s.availability).toBe(1);
  });

  it("statusCode 599 and Infinity count as 5xx (>= 500 with no upper bound — pin)", () => {
    const rec = new ApiSloRecorder();
    rec.recordRequest({ route: "/v1/media/upload", statusCode: 599, latencyMs: 1 });
    rec.recordRequest({
      route: "/v1/media/upload",
      statusCode: Number.POSITIVE_INFINITY,
      latencyMs: 1,
    });
    const s = rec.snapshot();
    expect(s.fiveXxCount).toBe(2);
    expect(s.mediaFiveXxCount).toBe(2);
  });

  it("NaN / negative / Infinity latencies are dropped from the window but still count as requests", () => {
    const rec = new ApiSloRecorder();
    for (const latencyMs of [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs });
    }
    const s = rec.snapshot();
    expect(s.requestCount).toBe(4);
    expect(s.latency.sampleCount).toBe(0);
    expect(s.latency.p95).toBeNull();
    const m = byId(rec);
    expect(m.get("api_latency_p95")!.status).toBe("not_evaluable");
    expect(m.get("api_latency_p95")!.reason).toBe("no latency samples");
  });

  it("LatencyWindow.percentile(NaN) returns null instead of throwing (the (0,100] guard does not catch NaN — pin)", () => {
    const w = new LatencyWindow(10);
    w.record(1);
    w.record(2);
    expect(() => w.percentile(0)).toThrow();
    expect(() => w.percentile(100.0001)).toThrow();
    expect(w.percentile(Number.NaN)).toBeNull();
  });

  it("LatencyWindow(0) and LatencyWindow(NaN) are refused / behave sanely", () => {
    expect(() => new LatencyWindow(0)).toThrow(/capacity/);
    expect(() => new LatencyWindow(-1)).toThrow(/capacity/);
    // NaN < 1 is false → the constructor accepts a NaN capacity; the window
    // then reports count() = NaN (pin: the guard should reject non-integers)
    const w = new LatencyWindow(Number.NaN);
    w.record(5);
    w.record(7);
    expect(Number.isNaN(w.count())).toBe(true);
    expect(w.percentile(50)).toBe(5);
  });

  it("rapid repeats: 100k requests keep the window at exactly capacity and percentiles finite", () => {
    const rec = new ApiSloRecorder(1000);
    for (let i = 0; i < 100_000; i++) {
      rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: i % 977 });
    }
    const s = rec.snapshot();
    expect(s.latency.sampleCount).toBe(1000);
    expect(Number.isFinite(s.latency.p99)).toBe(true);
    expect(s.requestCount).toBe(100_000);
  });
});

describe("corrupt pool samples", () => {
  it("REPRO: idleCount > totalCount (corrupt sample) yields a NEGATIVE saturation that is reported as met", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({ totalCount: 2, idleCount: 10, waitingCount: 0, maxSize: 10 });
    const e = byId(rec).get("pool_saturation")!;
    expect(e.observed).toBeLessThan(0);
    expect(e.status).toBe("met");
  });

  it("waitingCount alone can exceed 100% saturation (busy = total - idle + waiting) → breached", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({ totalCount: 10, idleCount: 10, waitingCount: 50, maxSize: 10 });
    const e = byId(rec).get("pool_saturation")!;
    expect(e.observed).toBe(5);
    expect(e.status).toBe("breached");
  });

  it("maxSize NaN / 0 / negative / null → not_evaluable with the documented reason (never a fake pass)", () => {
    for (const maxSize of [Number.NaN, 0, -3, null]) {
      const rec = new ApiSloRecorder();
      rec.recordPoolSample({ totalCount: 10, idleCount: 0, waitingCount: 0, maxSize });
      const e = byId(rec).get("pool_saturation")!;
      expect(e.status, String(maxSize)).toBe("not_evaluable");
      expect(e.reason).toBe("pool not sampled or max size unknown");
    }
  });

  it("maxSize Infinity → saturation 0 → met (pin)", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({
      totalCount: 10,
      idleCount: 0,
      waitingCount: 0,
      maxSize: Number.POSITIVE_INFINITY,
    });
    expect(byId(rec).get("pool_saturation")!.status).toBe("met");
  });

  it("only the LAST pool sample counts — a healthy sample after an exhausted one erases the exhaustion", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({ totalCount: 10, idleCount: 0, waitingCount: 40, maxSize: 10 });
    rec.recordPoolSample({ totalCount: 10, idleCount: 10, waitingCount: 0, maxSize: 10 });
    expect(byId(rec).get("pool_saturation")!.status).toBe("met");
  });
});

describe("evaluateApiSlos with hostile targets", () => {
  it("minRequestSamples: 0 with zero requests is still not_evaluable (availability null)", () => {
    const rec = new ApiSloRecorder();
    const m = new Map(
      evaluateApiSlos(rec.snapshot(), { ...DEFAULT_API_SLO_TARGETS, minRequestSamples: 0 }).map(
        (e) => [e.slo, e],
      ),
    );
    expect(m.get("api_availability")!.status).toBe("not_evaluable");
  });

  it("minRequestSamples: NaN makes EVERY rate SLO permanently not_evaluable (requestCount >= NaN is false) — pin", () => {
    const rec = new ApiSloRecorder();
    ok(rec, 1000);
    const m = new Map(
      evaluateApiSlos(rec.snapshot(), {
        ...DEFAULT_API_SLO_TARGETS,
        minRequestSamples: Number.NaN,
      }).map((e) => [e.slo, e]),
    );
    expect(m.get("api_availability")!.status).toBe("not_evaluable");
    expect(m.get("api_5xx_rate")!.status).toBe("not_evaluable");
  });

  it("every evaluation carries observed/target and a reason iff not_evaluable", () => {
    const rec = new ApiSloRecorder();
    ok(rec, 10);
    for (const e of evaluateApiSlos(rec.snapshot())) {
      expect(typeof e.target).toBe("number");
      if (e.status === "not_evaluable") expect(e.reason).toBeTruthy();
      else expect(e.reason).toBeUndefined();
    }
  });
});

describe("QueueSloMonitor under skew and corruption", () => {
  const cfg = { ...DEFAULT_QUEUE_SLO_CONFIG, stalledAfterIdleCycles: 3, maxOldestJobAgeMs: 1000 };

  it("negative oldestJobAgeMs (clock skew) never alerts on age; NaN age never alerts either (pin)", () => {
    const m = new QueueSloMonitor(cfg);
    expect(
      m.observe({ depth: 1, oldestJobAgeMs: -5_000_000, jobsHandled: 1, jobsSeen: 1 }),
    ).toBeNull();
    expect(
      m.observe({ depth: 1, oldestJobAgeMs: Number.NaN, jobsHandled: 1, jobsSeen: 1 }),
    ).toBeNull();
    expect(
      m.observe({ depth: 1, oldestJobAgeMs: Number.POSITIVE_INFINITY, jobsHandled: 1, jobsSeen: 1 })
        ?.reason,
    ).toBe("oldest_job_age_exceeded");
  });

  it("REPRO: jobsHandled = -1 (corrupt counter) with visible work RESETS the idle counter — a stall can be masked by a negative count", () => {
    const m = new QueueSloMonitor(cfg);
    m.observe({ depth: 5, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 5 });
    m.observe({ depth: 5, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 5 });
    expect(m.consecutiveIdleCycles()).toBe(2);
    expect(m.observe({ depth: 5, oldestJobAgeMs: null, jobsHandled: -1, jobsSeen: 5 })).toBeNull();
    expect(m.consecutiveIdleCycles()).toBe(0);
  });

  it("NaN jobsHandled also resets the idle counter (NaN === 0 is false) — pin", () => {
    const m = new QueueSloMonitor(cfg);
    m.observe({ depth: 5, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 5 });
    m.observe({ depth: 5, oldestJobAgeMs: null, jobsHandled: Number.NaN, jobsSeen: 5 });
    expect(m.consecutiveIdleCycles()).toBe(0);
  });

  it("depth -1 (unknown) with jobsSeen 0 is 'no work visible' forever — documented honesty, never a fake stall", () => {
    const m = new QueueSloMonitor(cfg);
    for (let i = 0; i < 100; i++) {
      expect(
        m.observe({ depth: -1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 0 }),
      ).toBeNull();
    }
    expect(m.consecutiveIdleCycles()).toBe(0);
  });

  it("stalledAfterIdleCycles: 0 alerts on the very first idle-with-work cycle AND on an empty queue (idle 0 >= 0) — pin", () => {
    const m = new QueueSloMonitor({ ...cfg, stalledAfterIdleCycles: 0 });
    const a = m.observe({ depth: 0, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 0 });
    expect(a?.reason).toBe("no_progress");
    expect(a?.consecutiveIdleCycles).toBe(0);
  });

  it("rapid repeats: 10k idle cycles keep alerting every cycle with a monotonically increasing counter", () => {
    const m = new QueueSloMonitor(cfg);
    let alerts = 0;
    for (let i = 1; i <= 10_000; i++) {
      const a = m.observe({ depth: 3, oldestJobAgeMs: 10, jobsHandled: 0, jobsSeen: 3 });
      if (a) {
        alerts++;
        expect(a.consecutiveIdleCycles).toBe(i);
      }
    }
    expect(alerts).toBe(10_000 - 2);
  });

  it("age alert takes precedence over no_progress and carries the live idle count", () => {
    const m = new QueueSloMonitor(cfg);
    for (let i = 0; i < 5; i++)
      m.observe({ depth: 3, oldestJobAgeMs: 10, jobsHandled: 0, jobsSeen: 3 });
    const a = m.observe({ depth: 3, oldestJobAgeMs: 5000, jobsHandled: 0, jobsSeen: 3 })!;
    expect(a.reason).toBe("oldest_job_age_exceeded");
    expect(a.consecutiveIdleCycles).toBe(6);
  });
});
