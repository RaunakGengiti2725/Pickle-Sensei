import { describe, expect, it } from "vitest";
import {
  CATEGORICAL_DRIFT_METRICS,
  DRIFT_THRESHOLDS,
  DRIFT_THRESHOLDS_VERSION,
  DriftMonitor,
  NUMERIC_DRIFT_METRICS,
  computePsi,
  numericBinLabel,
  type DriftObservation,
} from "../src/drift.js";

const at = "2026-08-29T12:00:00.000Z";

/**
 * SYNTHETIC TEST FIXTURES — these distributions are generated in-test to
 * exercise the drift statistic. They are NOT real production traffic, real
 * device telemetry, or real user data, and must never be cited as evidence
 * about the actual population.
 */
function syntheticObservation(kind: "stable" | "drifted", i: number): DriftObservation {
  if (kind === "stable") {
    return {
      deviceModel: i % 3 === 0 ? "synthetic-device-a" : "synthetic-device-b",
      osVersion: i % 2 === 0 ? "synthetic-os-17" : "synthetic-os-18",
      envelopeVerdict: i % 10 === 0 ? "DEGRADED" : "SUPPORTED",
      strokeType: i % 4 === 0 ? "backhand_drive" : "forehand_drive",
      fps: 30,
      resolutionShortSidePx: 1080,
      playerApparentSizeFrac: 0.25,
      coverageFrac: 0.8,
      abstentionRate: 0.08,
      latencyMs: 400,
      targetLockSuccessRate: 0.95,
      eventDensityPerMin: 4,
      paddleVisibilityFrac: 0.85,
    };
  }
  // Drifted synthetic population: new device fleet, low-fps low-res captures,
  // degraded verdicts, higher abstention and latency.
  return {
    deviceModel: "synthetic-device-c",
    osVersion: "synthetic-os-19",
    envelopeVerdict: i % 3 === 0 ? "UNSUPPORTED" : "DEGRADED",
    strokeType: i % 2 === 0 ? "third_shot_drop" : "dink",
    fps: 18,
    resolutionShortSidePx: 480,
    playerApparentSizeFrac: 0.07,
    coverageFrac: 0.4,
    abstentionRate: 0.4,
    latencyMs: 3000,
    targetLockSuccessRate: 0.6,
    eventDensityPerMin: 0.5,
    paddleVisibilityFrac: 0.3,
  };
}

function feed(monitor: DriftMonitor, kind: "stable" | "drifted", n: number): void {
  for (let i = 0; i < n; i++) monitor.record(syntheticObservation(kind, i));
}

describe("computePsi", () => {
  it("is ~0 for identical distributions", () => {
    const counts = { a: 500, b: 300, c: 200 };
    expect(computePsi(counts, { ...counts })).toBeCloseTo(0, 6);
  });

  it("is large for disjoint distributions and stays finite", () => {
    const psi = computePsi({ a: 500 }, { b: 500 });
    expect(Number.isFinite(psi)).toBe(true);
    expect(psi).toBeGreaterThan(DRIFT_THRESHOLDS.psiDrift);
  });

  it("is symmetric-ish in magnitude and 0 for empty inputs", () => {
    expect(computePsi({}, {})).toBe(0);
    expect(computePsi({ a: 10 }, {})).toBe(0);
  });
});

describe("numericBinLabel", () => {
  it("maps values to the frozen fixed bins", () => {
    expect(numericBinLabel("fps", 10)).toBe("<15");
    expect(numericBinLabel("fps", 24)).toBe("[24,30)");
    expect(numericBinLabel("fps", 120)).toBe(">=60");
    expect(numericBinLabel("latency_ms", 400)).toBe("[250,500)");
  });
});

describe("DriftMonitor", () => {
  it("refuses to evaluate below the frozen minimum sample count", () => {
    const monitor = new DriftMonitor();
    feed(monitor, "stable", DRIFT_THRESHOLDS.minSamples - 1);
    monitor.freezeReference();
    const result = monitor.test("fps");
    expect(result).toMatchObject({
      reason: "insufficient_reference_samples",
      thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
    });
  });

  it("reports stable for a synthetic stable population vs its own reference", () => {
    const monitor = new DriftMonitor();
    feed(monitor, "stable", 500);
    monitor.freezeReference();
    feed(monitor, "stable", 500);
    for (const metric of [...CATEGORICAL_DRIFT_METRICS, ...NUMERIC_DRIFT_METRICS]) {
      const result = monitor.test(metric);
      if ("reason" in result) throw new Error(`${metric} unexpectedly not evaluable`);
      expect(result.severity).toBe("stable");
      expect(result.psi).toBeLessThan(DRIFT_THRESHOLDS.psiWarning);
    }
    expect(monitor.alerts(at)).toHaveLength(0);
  });

  it("detects a synthetic drifted population on every metric", () => {
    const monitor = new DriftMonitor(1000);
    feed(monitor, "stable", 1000);
    monitor.freezeReference();
    feed(monitor, "drifted", 1000);
    for (const metric of [...CATEGORICAL_DRIFT_METRICS, ...NUMERIC_DRIFT_METRICS]) {
      const result = monitor.test(metric);
      if ("reason" in result) throw new Error(`${metric} unexpectedly not evaluable`);
      expect(result.severity).toBe("drift");
      expect(result.psi).toBeGreaterThanOrEqual(DRIFT_THRESHOLDS.psiDrift);
    }
    const alerts = monitor.alerts(at);
    expect(alerts).toHaveLength(CATEGORICAL_DRIFT_METRICS.length + NUMERIC_DRIFT_METRICS.length);
    for (const alert of alerts) {
      expect(alert.name).toBe("drift_detected");
      if (alert.name === "drift_detected") expect(alert.severity).toBe("drift");
    }
  });

  it("emits not-evaluable alerts when the current window is too small", () => {
    const monitor = new DriftMonitor();
    feed(monitor, "stable", 500);
    monitor.freezeReference();
    // Rolling window still holds the reference samples, so shrink via a fresh monitor.
    const fresh = new DriftMonitor();
    feed(fresh, "stable", 500);
    fresh.freezeReference();
    expect(fresh.test("fps")).toMatchObject({ metric: "fps" });
    const tiny = new DriftMonitor();
    tiny.freezeReference();
    const result = tiny.test("fps");
    expect(result).toMatchObject({ reason: "insufficient_reference_samples" });
    const alerts = tiny.alerts(at);
    expect(alerts.every((a) => a.name === "drift_window_not_evaluable")).toBe(true);
  });

  it("rolling window evicts oldest samples so drift eventually dominates", () => {
    const monitor = new DriftMonitor(200);
    feed(monitor, "stable", 200);
    monitor.freezeReference();
    feed(monitor, "drifted", 200);
    const snapshot = monitor.snapshot("device_model");
    expect(snapshot.totalSamples).toBe(200);
    expect(snapshot.counts["synthetic-device-c"]).toBe(200);
    expect(snapshot.counts["synthetic-device-a"]).toBeUndefined();
  });

  it("holds only aggregate counts — no raw samples or identifiers in snapshots", () => {
    const monitor = new DriftMonitor();
    feed(monitor, "stable", 150);
    const snapshot = monitor.snapshot("latency_ms");
    expect(Object.keys(snapshot)).toEqual(["metric", "totalSamples", "counts"]);
    for (const [label, count] of Object.entries(snapshot.counts)) {
      expect(typeof label).toBe("string");
      expect(Number.isInteger(count)).toBe(true);
    }
  });
});
