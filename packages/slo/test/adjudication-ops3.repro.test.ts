import { describe, expect, it } from "vitest";
import { DEFAULT_API_SLO_TARGETS, evaluateApiSlos, type ApiSloSnapshot } from "../src/index.js";

/**
 * Adjudication repro (stress area packages-ops-3, baseline 1fb0efd7).
 * Root cause: `evaluateApiSlos` guards only `null`, so a non-finite observed
 * value or target compares as an ordinary number and yields "met".
 *
 * Replayed seeds (tools/stress/boundary-malformed, origin/devin/stress-pkg-ops-bundle-boundary-malformed):
 *   2404907450 — targets.maxPoolSaturation = Infinity, poolSaturation = 5
 *   4166837063 — latency.p95 = -Infinity
 *
 * These tests assert the EXPECTED contract (non-finite → not_evaluable) and
 * therefore FAIL on 1fb0efd7.
 */

function snapshot(overrides: Partial<ApiSloSnapshot> = {}): ApiSloSnapshot {
  return {
    requestCount: 1000,
    fiveXxCount: 0,
    availability: 1,
    fiveXxRate: 0,
    latency: { p50: 10, p95: 20, p99: 30, sampleCount: 1000 },
    dbLatency: { p50: 5, p95: 10, p99: 20, sampleCount: 1000 },
    pool: { totalCount: 10, idleCount: 5, waitingCount: 0, maxSize: 10 },
    poolSaturation: 0.5,
    mediaFiveXxCount: 0,
    ...overrides,
  };
}

describe("slo: non-finite inputs are not_evaluable, never met", () => {
  it("seed 2404907450: Infinity target for pool saturation", () => {
    const evals = evaluateApiSlos(snapshot({ poolSaturation: 5 }), {
      ...DEFAULT_API_SLO_TARGETS,
      maxPoolSaturation: Number.POSITIVE_INFINITY,
    });
    expect(evals.find((e) => e.slo === "pool_saturation")?.status).toBe("not_evaluable");
  });

  it("seed 4166837063: -Infinity observed p95 latency", () => {
    const evals = evaluateApiSlos(
      snapshot({ latency: { p50: 10, p95: Number.NEGATIVE_INFINITY, p99: 30, sampleCount: 1000 } }),
      DEFAULT_API_SLO_TARGETS,
    );
    expect(evals.find((e) => e.slo === "api_latency_p95")?.status).toBe("not_evaluable");
  });
});
