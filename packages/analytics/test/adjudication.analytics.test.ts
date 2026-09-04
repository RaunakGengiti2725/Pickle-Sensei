/**
 * Adjudication repro (shared-packages-ops) — @pickle/analytics.
 *
 *  - BufferedAnalytics.flush(): on transport failure `batch.slice(-maxBuffer)`
 *    discards the oldest events of an oversized batch with no counter, contradicting
 *    "failures are not silently dropped" in the class doc.
 *  - computePsi(): plain-object lookup `reference[bin]` hits Object.prototype for
 *    labels like "constructor" → NaN PSI → DriftMonitor reports "stable".
 *  - computeCost(): quantities are validated, rate cards are not → "$NaN" totals.
 * Every test here FAILS on 4d812e1a.
 */
import { describe, expect, it } from "vitest";
import {
  BufferedAnalytics,
  DEFAULT_RATE_CARD,
  DRIFT_THRESHOLDS,
  DriftMonitor,
  ZERO_USAGE,
  computeCost,
  computePsi,
  type AnalyticsEvent,
} from "../src/index.js";

const at = "2026-09-04T12:00:00.000Z";
const drill = (i: number): AnalyticsEvent => ({ name: "drill_opened", drillSlug: `d-${i}`, at });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("adjudication: transport failure never silently discards buffered events", () => {
  it("10 buffered events survive a failed manual flush with maxBuffer=3 (or the drop is counted)", async () => {
    let fail = true;
    const analytics = new BufferedAnalytics(async () => {
      if (fail) throw new Error("transport down");
    }, 3);
    for (let i = 1; i <= 10; i++) analytics.track(drill(i));
    await settle();
    expect(analytics.pendingCount()).toBe(10);
    await analytics.flush(); // one batch of 10 → fails → slice(-3)
    const retained = analytics.pendingCount();
    const accounted = retained + analytics.droppedViolationCount();
    expect(accounted, `retained=${retained}, 10 - retained events vanished uncounted`).toBe(10);
    fail = false;
  });
});

describe("adjudication: drift detection is not disabled by prototype-key labels", () => {
  it("computePsi treats 'constructor' like any other bin", () => {
    const psi = computePsi({ iphone15: 100 }, { constructor: 100 });
    expect(Number.isFinite(psi)).toBe(true);
    expect(psi).toBeGreaterThan(DRIFT_THRESHOLDS.psiWarning);
  });

  it("DriftMonitor flags a full device_model shift to 'constructor' as drift", () => {
    const monitor = new DriftMonitor(1000);
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
      monitor.record({ deviceModel: "iphone15" });
    monitor.freezeReference();
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
      monitor.record({ deviceModel: "constructor" });
    const result = monitor.test("device_model");
    expect("severity" in result && result.severity).not.toBe("stable");
  });
});

describe("adjudication: computeCost validates the rate card", () => {
  it("NaN usdPerUnit throws instead of formatting '$NaN'", () => {
    const card = {
      ...DEFAULT_RATE_CARD,
      server_gpu: { ...DEFAULT_RATE_CARD.server_gpu, usdPerUnit: NaN },
    };
    expect(() => computeCost({ ...ZERO_USAGE, server_gpu: 1 }, card)).toThrow();
  });

  it("negative usdPerUnit throws instead of producing a negative total", () => {
    const card = {
      ...DEFAULT_RATE_CARD,
      server_gpu: { ...DEFAULT_RATE_CARD.server_gpu, usdPerUnit: -1 },
    };
    expect(() => computeCost({ ...ZERO_USAGE, server_gpu: 1 }, card)).toThrow();
  });
});
