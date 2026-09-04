/**
 * Adversarial pass 3 — SLO sample-floor invariants.
 *
 * With exactly minRequestSamples-1 requests, ALL 5xx, the rate SLOs must be
 * not_evaluable — never "breached" (false alarm) and never "met" (fabricated
 * pass). The 100th request flips them to a real evaluation.
 */
import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  LatencyWindow,
  evaluateApiSlos,
  type ApiSloSnapshot,
} from "../src/index.js";

const RATE_SLOS = ["api_availability", "api_5xx_rate"] as const;

function allFiveXx(count: number, route = "/v1/media/upload"): ApiSloRecorder {
  const rec = new ApiSloRecorder();
  for (let i = 0; i < count; i++) rec.recordRequest({ route, statusCode: 503, latencyMs: 5 });
  return rec;
}

describe("attack3: evaluateApiSlos at minRequestSamples-1, all 5xx", () => {
  const n = DEFAULT_API_SLO_TARGETS.minRequestSamples - 1;

  it(`exactly ${DEFAULT_API_SLO_TARGETS.minRequestSamples - 1} × 503 → both rate SLOs not_evaluable with a reason`, () => {
    const snap = allFiveXx(n).snapshot();
    expect(snap.requestCount).toBe(n);
    expect(snap.fiveXxRate).toBe(1);
    expect(snap.availability).toBe(0);
    const evals = evaluateApiSlos(snap);
    for (const slo of RATE_SLOS) {
      const e = evals.find((x) => x.slo === slo)!;
      expect(e.status, `${slo} observed=${e.observed}`).toBe("not_evaluable");
      expect(e.status).not.toBe("breached");
      expect(e.status).not.toBe("met");
      expect(e.reason).toBe(
        `fewer than ${DEFAULT_API_SLO_TARGETS.minRequestSamples} requests observed`,
      );
    }
  });

  it("the very next (100th) 503 flips both to breached — the floor is exact, not off by one", () => {
    const rec = allFiveXx(n);
    rec.recordRequest({ route: "/v1/x", statusCode: 500, latencyMs: 1 });
    const evals = evaluateApiSlos(rec.snapshot());
    for (const slo of RATE_SLOS) {
      expect(evals.find((x) => x.slo === slo)!.status).toBe("breached");
    }
  });

  it("99 × 5xx cannot be laundered into 'met' by mixing in 2xx below the floor", () => {
    const rec = allFiveXx(n - 50);
    for (let i = 0; i < 50; i++)
      rec.recordRequest({ route: "/v1/ok", statusCode: 200, latencyMs: 1 });
    const evals = evaluateApiSlos(rec.snapshot());
    for (const slo of RATE_SLOS)
      expect(evals.find((x) => x.slo === slo)!.status).toBe("not_evaluable");
  });

  it("minRequestSamples=0 / negative / NaN targets are not a silent 'always evaluable' backdoor", () => {
    const snap = allFiveXx(0).snapshot(); // zero requests
    for (const min of [0, -1, Number.NaN]) {
      const evals = evaluateApiSlos(snap, { ...DEFAULT_API_SLO_TARGETS, minRequestSamples: min });
      for (const slo of RATE_SLOS) {
        const e = evals.find((x) => x.slo === slo)!;
        expect(e.status, `min=${min} ${slo}`).toBe("not_evaluable");
      }
    }
  });

  it("a hand-built snapshot with requestCount=99 but fiveXxCount=1e6 (corrupt state) is still not_evaluable", () => {
    const corrupt: ApiSloSnapshot = {
      ...allFiveXx(n).snapshot(),
      fiveXxCount: 1_000_000,
      availability: -10_000,
      fiveXxRate: 10_101,
    };
    const evals = evaluateApiSlos(corrupt);
    for (const slo of RATE_SLOS)
      expect(evals.find((x) => x.slo === slo)!.status).toBe("not_evaluable");
  });

  it("NaN / Infinity latency samples are dropped and do not corrupt p95/p99", () => {
    const rec = new ApiSloRecorder(10);
    rec.recordRequest({ route: "/v1/a", statusCode: 200, latencyMs: Number.NaN });
    rec.recordRequest({ route: "/v1/a", statusCode: 200, latencyMs: Number.POSITIVE_INFINITY });
    rec.recordRequest({ route: "/v1/a", statusCode: 200, latencyMs: -1 });
    rec.recordRequest({ route: "/v1/a", statusCode: 200, latencyMs: 7 });
    const snap = rec.snapshot();
    expect(snap.requestCount).toBe(4);
    expect(snap.latency.sampleCount).toBe(1);
    expect(snap.latency.p95).toBe(7);
    expect(snap.latency.p99).toBe(7);
  });

  it("LatencyWindow sliding window: count() is exact at the capacity boundary and after wrap", () => {
    const w = new LatencyWindow(3);
    w.record(1);
    w.record(2);
    w.record(3);
    expect(w.count()).toBe(3);
    w.record(4); // wraps, evicts 1
    expect(w.count()).toBe(3);
    expect(w.percentile(100)).toBe(4);
    expect(w.percentile(1)).toBe(2);
  });

  it("LatencyWindow.percentile rejects p outside (0,100] (0, 101, NaN)", () => {
    const w = new LatencyWindow(3);
    w.record(1);
    expect(() => w.percentile(0)).toThrow();
    expect(() => w.percentile(101)).toThrow();
    // NaN: `p <= 0 || p > 100` is false for NaN → must not silently return a
    // real sample as if it were a percentile (null or throw are both fine).
    let out: number | null | "threw" = "threw";
    try {
      out = w.percentile(Number.NaN);
    } catch {
      out = "threw";
    }
    expect(out === null || out === "threw", `percentile(NaN)=${String(out)}`).toBe(true);
  });

  it("status code boundaries: 499 is not a 5xx, 500 and 599 are, 600 is counted too (documenting)", () => {
    const rec = new ApiSloRecorder();
    rec.recordRequest({ route: "/v1/a", statusCode: 499, latencyMs: 1 });
    expect(rec.snapshot().fiveXxCount).toBe(0);
    rec.recordRequest({ route: "/v1/a", statusCode: 500, latencyMs: 1 });
    rec.recordRequest({ route: "/v1/a", statusCode: 599, latencyMs: 1 });
    expect(rec.snapshot().fiveXxCount).toBe(2);
  });

  it("pool saturation with maxSize=0 or negative busy does not become breached/met by division artefacts", () => {
    const rec = new ApiSloRecorder();
    rec.recordPoolSample({ totalCount: 5, idleCount: 5, waitingCount: 0, maxSize: 0 });
    expect(rec.snapshot().poolSaturation).toBeNull();
    expect(evaluateApiSlos(rec.snapshot()).find((e) => e.slo === "pool_saturation")!.status).toBe(
      "not_evaluable",
    );
    rec.recordPoolSample({ totalCount: 0, idleCount: 10, waitingCount: 0, maxSize: 10 });
    // busy = -10 → saturation -1 → "met" — a corrupt sample masquerading as healthy
    const sat = rec.snapshot().poolSaturation;
    expect(sat === null || sat >= 0, `poolSaturation=${sat}`).toBe(true);
  });
});
