/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — DriftMonitor / PSI.
 * `it(...)` = HELD; `it.fails(...)` = EXPECTED behaviour that is currently
 * broken (paired with an OBSERVED `it` pinning what really happens).
 *
 * SYNTHETIC FIXTURES ONLY — nothing here is production telemetry.
 */
import { describe, expect, it } from "vitest";
import {
  CATEGORICAL_DRIFT_METRICS,
  DRIFT_THRESHOLDS,
  DriftMonitor,
  NUMERIC_DRIFT_METRICS,
  RollingDistribution,
  computePsi,
  numericBinLabel,
} from "../src/drift.js";

function reference(monitor: DriftMonitor, n = 100): void {
  for (let i = 0; i < n; i++) {
    monitor.record({
      deviceModel: i % 2 === 0 ? "synthetic-a" : "synthetic-b",
      strokeType: "forehand_drive",
      fps: 30,
      latencyMs: 400,
    });
  }
  monitor.freezeReference();
}

describe("S3 — 100-sample reference vs 100-sample current containing an UNSEEN category", () => {
  it("HELD: one unseen category among 100 → PSI finite, reported as drift (never NaN/Infinity)", () => {
    // Window of exactly 100 so the 100 new records fully replace the reference.
    const fresh = new DriftMonitor(100);
    reference(fresh);
    for (let i = 0; i < 100; i++) {
      fresh.record({
        deviceModel: i === 0 ? "synthetic-UNSEEN" : i % 2 === 0 ? "synthetic-a" : "synthetic-b",
      });
    }
    const result = fresh.test("device_model");
    expect("psi" in result).toBe(true);
    if (!("psi" in result)) return;
    expect(Number.isFinite(result.psi)).toBe(true);
    expect(result.currentSamples).toBe(100);
    expect(result.referenceSamples).toBe(100);
    // 1% mass moving into a bin the reference never saw: PSI ≈ 0.01·ln(0.01/1e-6) ≈ 0.09 + rest.
    expect(result.psi).toBeGreaterThan(0.05);
    expect(result.psi).toBeLessThan(1);
    expect(["stable", "warning", "drift"]).toContain(result.severity);
  });

  it("HELD: ALL 100 current samples in an unseen category → PSI finite and severity=drift", () => {
    const monitor = new DriftMonitor(100);
    reference(monitor);
    for (let i = 0; i < 100; i++) monitor.record({ deviceModel: "synthetic-UNSEEN" });
    const result = monitor.test("device_model");
    expect("psi" in result).toBe(true);
    if (!("psi" in result)) return;
    expect(Number.isFinite(result.psi)).toBe(true);
    expect(result.severity).toBe("drift");
    expect(result.psi).toBeGreaterThan(DRIFT_THRESHOLDS.psiDrift);
  });

  it("HELD: computePsi is symmetric-finite for disjoint supports and zero for identical ones", () => {
    const a = { x: 100 };
    const b = { y: 100 };
    expect(Number.isFinite(computePsi(a, b))).toBe(true);
    expect(computePsi(a, b)).toBeCloseTo(computePsi(b, a), 12);
    expect(computePsi(a, a)).toBe(0);
    expect(computePsi({}, b)).toBe(0);
    expect(computePsi(a, {})).toBe(0);
  });

  it("HELD: smoothing=0 with disjoint support is the only way to get a non-finite PSI (documented escape hatch)", () => {
    expect(Number.isFinite(computePsi({ x: 100 }, { y: 100 }, 0))).toBe(false);
  });

  it("HELD: numericBinLabel edges — value exactly on an edge goes to the upper bin; -Infinity/Infinity land in the outer bins", () => {
    expect(numericBinLabel("fps", 30)).toBe("[30,48)");
    expect(numericBinLabel("fps", 29.999)).toBe("[24,30)");
    expect(numericBinLabel("fps", -Infinity)).toBe("<15");
    expect(numericBinLabel("fps", Infinity)).toBe(">=60");
    for (const metric of NUMERIC_DRIFT_METRICS) {
      expect(numericBinLabel(metric, Number.MAX_VALUE).startsWith(">=")).toBe(true);
      expect(numericBinLabel(metric, -Number.MAX_VALUE).startsWith("<")).toBe(true);
    }
  });

  it("HELD: NaN / ±Infinity numeric observations are ignored (not binned)", () => {
    const monitor = new DriftMonitor();
    monitor.record({ fps: NaN, latencyMs: Infinity, coverageFrac: -Infinity });
    expect(monitor.snapshot("fps").totalSamples).toBe(0);
    expect(monitor.snapshot("latency_ms").totalSamples).toBe(0);
    expect(monitor.snapshot("coverage_frac").totalSamples).toBe(0);
  });
});

describe("S3b — category labels that collide with Object.prototype", () => {
  const PROTO_LABELS = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"];

  it("OBSERVED: a current-only category named `toString` makes computePsi return NaN, and DriftMonitor.test reports severity=stable", () => {
    const monitor = new DriftMonitor(100);
    reference(monitor);
    for (let i = 0; i < 100; i++) monitor.record({ deviceModel: "toString" });
    const result = monitor.test("device_model");
    expect("psi" in result).toBe(true);
    if (!("psi" in result)) return;
    expect(Number.isNaN(result.psi)).toBe(true);
    expect(result.severity).toBe("stable");
    // …and alerts() therefore emits NOTHING for a 100%-shifted population.
    const alerts = monitor.alerts("2026-09-04T12:00:00.000Z");
    expect(alerts.filter((a) => a.metric === "device_model")).toHaveLength(0);
  });

  it.fails(
    "EXPECTED: a 100%-shifted current population is reported as drift regardless of the label text",
    () => {
      for (const label of PROTO_LABELS) {
        const monitor = new DriftMonitor(100);
        reference(monitor);
        for (let i = 0; i < 100; i++) monitor.record({ deviceModel: label });
        const result = monitor.test("device_model");
        expect("psi" in result).toBe(true);
        if (!("psi" in result)) return;
        expect(Number.isFinite(result.psi)).toBe(true);
        expect(result.severity).toBe("drift");
      }
    },
  );

  it("OBSERVED: which prototype-colliding labels poison PSI (NaN) vs. behave", () => {
    const outcome: Record<string, string> = {};
    for (const label of PROTO_LABELS) {
      const psi = computePsi({ a: 100 }, { [label]: 100 });
      outcome[label] = Number.isNaN(psi) ? "NaN" : Number.isFinite(psi) ? "finite" : "infinite";
    }
    // `__proto__` survives because Object.fromEntries/computed keys define an
    // OWN property; the function-valued prototype members do not.
    expect(outcome).toEqual({
      toString: "NaN",
      constructor: "NaN",
      valueOf: "NaN",
      hasOwnProperty: "NaN",
      __proto__: "finite",
    });
  });

  it("HELD: RollingDistribution keeps exact counts for prototype-named labels (the Map layer is safe)", () => {
    const dist = new RollingDistribution("device_model", 10);
    for (const label of PROTO_LABELS) dist.addCategory(label);
    const snap = dist.snapshot();
    expect(snap.totalSamples).toBe(PROTO_LABELS.length);
    for (const label of PROTO_LABELS) {
      expect(Object.prototype.hasOwnProperty.call(snap.counts, label)).toBe(true);
      expect(snap.counts[label]).toBe(1);
    }
  });
});

describe("S3c — rolling-window eviction and huge inputs", () => {
  it("HELD: eviction keeps counts consistent with totalSamples after 50k mixed categories (seeded)", () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const dist = new RollingDistribution("stroke_type", 1000);
    const labels = ["a", "b", "c", "d", "e", "f", "g"];
    for (let i = 0; i < 50_000; i++)
      dist.addCategory(labels[Math.floor(rnd() * labels.length)] ?? "a");
    const snap = dist.snapshot();
    expect(snap.totalSamples).toBe(1000);
    expect(Object.values(snap.counts).reduce((x, y) => x + y, 0)).toBe(1000);
    for (const v of Object.values(snap.counts)) expect(v).toBeGreaterThan(0);
  });

  it("HELD: a window of exactly minSamples is evaluable; minSamples-1 is not, for every metric", () => {
    const monitor = new DriftMonitor(100);
    for (let i = 0; i < 99; i++) {
      monitor.record({
        deviceModel: "a",
        osVersion: "o",
        envelopeVerdict: "SUPPORTED",
        strokeType: "s",
        fps: 30,
        resolutionShortSidePx: 1080,
        playerApparentSizeFrac: 0.2,
        coverageFrac: 0.8,
        abstentionRate: 0.1,
        latencyMs: 400,
        targetLockSuccessRate: 0.9,
        eventDensityPerMin: 4,
        paddleVisibilityFrac: 0.8,
      });
    }
    monitor.freezeReference();
    for (const metric of [...CATEGORICAL_DRIFT_METRICS, ...NUMERIC_DRIFT_METRICS]) {
      const r = monitor.test(metric);
      expect("reason" in r && r.reason).toBe("insufficient_reference_samples");
    }
    monitor.record({
      deviceModel: "a",
      osVersion: "o",
      envelopeVerdict: "SUPPORTED",
      strokeType: "s",
      fps: 30,
      resolutionShortSidePx: 1080,
      playerApparentSizeFrac: 0.2,
      coverageFrac: 0.8,
      abstentionRate: 0.1,
      latencyMs: 400,
      targetLockSuccessRate: 0.9,
      eventDensityPerMin: 4,
      paddleVisibilityFrac: 0.8,
    });
    monitor.freezeReference();
    for (const metric of [...CATEGORICAL_DRIFT_METRICS, ...NUMERIC_DRIFT_METRICS]) {
      const r = monitor.test(metric);
      expect("psi" in r).toBe(true);
      if ("psi" in r) expect(r.psi).toBe(0);
    }
  });

  it("HELD: freezeReference snapshots are decoupled from later records (reference does not drift with the window)", () => {
    const monitor = new DriftMonitor(100);
    reference(monitor);
    const before = monitor.test("device_model");
    for (let i = 0; i < 100; i++) monitor.record({ deviceModel: "z" });
    const after = monitor.test("device_model");
    expect("psi" in before && before.psi).toBe(0);
    expect("psi" in after && after.referenceSamples).toBe(100);
    expect("psi" in after && after.severity).toBe("drift");
  });
});
