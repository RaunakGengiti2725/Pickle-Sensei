/**
 * Adversarial pass 3 — drift / PSI poisoning.
 *
 * computePsi is the statistic every drift alert is derived from. A NaN or
 * negative count must be REJECTED, not folded into a NaN PSI: NaN compares
 * false against every threshold, so a poisoned window would be classified
 * "stable" — the one silent failure mode a drift monitor must never have.
 */
import { describe, expect, it } from "vitest";
import {
  DRIFT_THRESHOLDS,
  DriftMonitor,
  RollingDistribution,
  computePsi,
  numericBinLabel,
} from "../src/drift.js";

describe("attack3: computePsi with non-finite / invalid counts", () => {
  it("computePsi({a:NaN},{a:1}) rejects rather than returning NaN", () => {
    let result: number | null = null;
    let threw = false;
    try {
      result = computePsi({ a: Number.NaN }, { a: 1 });
    } catch {
      threw = true;
    }
    if (!threw) {
      // Observed value recorded for the report.
      expect(result, "computePsi returned instead of throwing").not.toBeNaN();
    }
    expect(threw).toBe(true);
  });

  it("computePsi with an Infinity count rejects rather than returning NaN", () => {
    expect(() => computePsi({ a: Number.POSITIVE_INFINITY }, { a: 1 })).toThrow();
  });

  it("computePsi with a negative count rejects rather than returning NaN", () => {
    // Negative + smoothing → log of a negative ratio → NaN.
    expect(() => computePsi({ a: -5, b: 5 }, { a: 5, b: 5 })).toThrow();
  });

  it("computePsi with smoothing=0 and a one-sided bin must not return ±Infinity", () => {
    const psi = computePsi({ a: 10, b: 0 }, { a: 5, b: 5 }, 0);
    expect(Number.isFinite(psi)).toBe(true);
  });

  it("computePsi with smoothing=NaN rejects", () => {
    expect(() => computePsi({ a: 10 }, { a: 10 }, Number.NaN)).toThrow();
  });
});

describe("attack3: RollingDistribution / DriftMonitor with Infinity", () => {
  it("RollingDistribution has no numeric record(); DriftMonitor.record drops non-finite numerics", () => {
    const monitor = new DriftMonitor();
    monitor.record({ fps: Number.POSITIVE_INFINITY });
    monitor.record({ fps: Number.NaN });
    monitor.record({ fps: Number.NEGATIVE_INFINITY });
    expect(monitor.snapshot("fps").totalSamples).toBe(0);
  });

  it("numericBinLabel(NaN) must not silently land in a real bin", () => {
    // Exported helper; NaN compares false against every edge so it falls
    // through to the top bin — a NaN observation would be counted as ">=60".
    const label = numericBinLabel("fps", Number.NaN);
    expect(label).not.toBe(">=60");
  });

  it("a poisoned reference window (NaN count) must not classify the metric as stable", () => {
    // Simulate a corrupted frozen reference (e.g. deserialized from JSON
    // with a NaN→null→NaN round trip) by poking the private map via a
    // type-erased handle. This is the only way NaN can reach test(); the
    // assertion is that the classifier refuses, not that the map is reachable.
    const monitor = new DriftMonitor();
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++) monitor.record({ fps: 30 });
    monitor.freezeReference();
    const internals = monitor as unknown as {
      reference: Map<
        string,
        { metric: string; totalSamples: number; counts: Record<string, number> }
      >;
    };
    internals.reference.set("fps", {
      metric: "fps",
      totalSamples: DRIFT_THRESHOLDS.minSamples,
      counts: { "[30,48)": Number.NaN },
    });
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++) monitor.record({ fps: 10 });
    let result: ReturnType<DriftMonitor["test"]> | null = null;
    let threw = false;
    try {
      result = monitor.test("fps");
    } catch {
      threw = true;
    }
    // Acceptable outcomes: throw, or a not-evaluable result, or a real
    // (finite) PSI. NOT acceptable: psi=NaN classified "stable" (which also
    // makes alerts() emit nothing — the poisoned metric goes dark).
    if (!threw && result && !("reason" in result)) {
      expect(result.psi, `severity=${result.severity}`).not.toBeNaN();
    }
    const alerts = monitor.alerts("2026-09-04T00:00:00Z").filter((a) => a.metric === "fps");
    if (!threw) expect(alerts.length, "poisoned fps metric emitted no alert").toBeGreaterThan(0);
  });

  it("RollingDistribution eviction keeps counts consistent under rapid churn (seed 1337)", () => {
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const dist = new RollingDistribution("device_model", 50);
    const labels = ["a", "b", "c", "d"];
    for (let i = 0; i < 10_000; i++) dist.addCategory(labels[Math.floor(rand() * 4)]!);
    const snap = dist.snapshot();
    expect(snap.totalSamples).toBe(50);
    expect(Object.values(snap.counts).reduce((x, y) => x + y, 0)).toBe(50);
    for (const v of Object.values(snap.counts)) expect(v).toBeGreaterThan(0);
  });
});
