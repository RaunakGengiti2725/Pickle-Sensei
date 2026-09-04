import { describe, expect, it } from "vitest";
import {
  BufferedAnalytics,
  DRIFT_THRESHOLDS,
  DriftMonitor,
  computePsi,
  type AnalyticsEvent,
} from "../src/index.js";

const at = "2026-09-04T12:00:00.000Z";

function slugEvent(slug: string): AnalyticsEvent {
  return { name: "drill_opened", drillSlug: slug, at };
}

function slugsOf(events: AnalyticsEvent[]): string[] {
  return events.map((event) => (event.name === "drill_opened" ? event.drillSlug : event.name));
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * SPO-07 — BufferedAnalytics re-buffers a failed batch bounded by maxBuffer.
 * The bound is legitimate (analytics must never grow without limit) but
 * every event it evicts must be COUNTED, and the retained events must drain
 * in the order they were tracked.
 */
describe("BufferedAnalytics transport failure", () => {
  it("transport failure of an oversized batch accounts for every event: pending + droppedTransport === N", async () => {
    let fail = true;
    const delivered: AnalyticsEvent[] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      if (fail) throw new Error("transport down");
      delivered.push(...batch);
    }, 3);
    // Auto-flush disabled from the caller's point of view: track below the cap,
    // then hand-build an oversized batch by tracking while the failing flushes are in flight.
    for (let i = 1; i <= 10; i++) analytics.track(slugEvent(String(i)));
    await settle();
    // Three auto-flushes (1-3, 4-6, 7-9) failed and were re-buffered; 10 was still buffered.
    expect(analytics.pendingCount() + analytics.droppedTransportCount()).toBe(10);
    expect(analytics.droppedViolationCount()).toBe(0);

    // One manual flush of the whole 10-event buffer fails: the bound may evict
    // events, but the accounting must still add up to 10.
    await analytics.flush();
    expect(analytics.pendingCount()).toBeLessThanOrEqual(10);
    expect(analytics.pendingCount() + analytics.droppedTransportCount()).toBe(10);
    expect(analytics.droppedTransportCount()).toBeGreaterThan(0);

    fail = false;
    await analytics.flush();
    expect(analytics.pendingCount()).toBe(0);
    // Whatever survived drains newest-last, in track order.
    const slugs = slugsOf(delivered).map(Number);
    expect(slugs).toEqual([...slugs].sort((a, b) => a - b));
    expect(slugs.length + analytics.droppedTransportCount()).toBe(10);
  });

  it("transport failure of a single oversized batch keeps the newest maxBuffer events and counts the rest", async () => {
    let fail = true;
    const delivered: AnalyticsEvent[] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      if (fail) throw new Error("transport down");
      delivered.push(...batch);
    }, 3);
    for (let i = 1; i <= 2; i++) analytics.track(slugEvent(String(i)));
    await analytics.flush(); // fails: 2 re-buffered, below the cap so nothing evicted
    expect(analytics.pendingCount()).toBe(2);
    expect(analytics.droppedTransportCount()).toBe(0);
    analytics.track(slugEvent("3")); // reaches the cap → auto-flush of [1,2,3] fails
    await settle();
    expect(analytics.pendingCount()).toBe(3);
    expect(analytics.droppedTransportCount()).toBe(0);
    analytics.track(slugEvent("4")); // 4 events ≥ cap → auto-flush of [1,2,3,4] fails, 1 evicted
    await settle();
    expect(analytics.pendingCount()).toBe(3);
    expect(analytics.droppedTransportCount()).toBe(1);
    expect(analytics.pendingCount() + analytics.droppedTransportCount()).toBe(4);

    fail = false;
    await analytics.flush();
    expect(slugsOf(delivered)).toEqual(["2", "3", "4"]);
  });

  it("transport failure re-buffers in track order: S1 delivers slugs 1..10 in order once the transport recovers", async () => {
    let fail = true;
    const delivered: AnalyticsEvent[] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      if (fail) throw new Error("transport down");
      delivered.push(...batch);
    }, 3);
    for (let i = 1; i <= 10; i++) analytics.track(slugEvent(String(i)));
    await settle();
    // Three failed auto-flushes: nothing evicted (each batch was exactly maxBuffer).
    expect(analytics.pendingCount()).toBe(10);
    expect(analytics.droppedTransportCount()).toBe(0);

    fail = false;
    await analytics.flush();
    expect(analytics.pendingCount()).toBe(0);
    expect(slugsOf(delivered)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  it("transport failure while newer events arrive keeps the failed batch ahead of them", async () => {
    let release: (() => void) | undefined;
    let fail = true;
    const delivered: AnalyticsEvent[] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (fail) throw new Error("transport down");
      delivered.push(...batch);
    }, 50);
    analytics.track(slugEvent("1"));
    analytics.track(slugEvent("2"));
    const inFlight = analytics.flush();
    analytics.track(slugEvent("3"));
    release?.();
    await inFlight;
    expect(analytics.pendingCount()).toBe(3);
    expect(analytics.droppedTransportCount()).toBe(0);

    fail = false;
    const retry = analytics.flush();
    await settle();
    release?.();
    await retry;
    expect(slugsOf(delivered)).toEqual(["1", "2", "3"]);
  });

  it("transport failure counter is reported through the optional callback", async () => {
    const reported: number[] = [];
    const analytics = new BufferedAnalytics(
      async () => {
        throw new Error("transport down");
      },
      2,
      undefined,
      (dropped) => reported.push(dropped),
    );
    for (let i = 1; i <= 5; i++) analytics.track(slugEvent(String(i)));
    await settle();
    await analytics.flush();
    expect(analytics.droppedTransportCount()).toBe(reported.reduce((a, b) => a + b, 0));
    expect(analytics.pendingCount() + analytics.droppedTransportCount()).toBe(5);
  });
});

/**
 * SPO-08 — computePsi must treat bin labels as data, never as property
 * lookups on Object.prototype. A device reporting deviceModel="constructor"
 * must not switch drift alerting off.
 */
describe("computePsi prototype-key bins", () => {
  const PROTOTYPE_KEYS = ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"];

  it.each(PROTOTYPE_KEYS)(
    "prototype-key %s: disjoint distributions yield a finite PSI above the warning band",
    (key) => {
      const current: Record<string, number> = { [key]: 100 };
      expect(Object.keys(current)).toEqual([key]);
      const psi = computePsi({ iphone15: 100 }, current);
      expect(Number.isFinite(psi)).toBe(true);
      expect(psi).toBeGreaterThan(DRIFT_THRESHOLDS.psiWarning);
      const reversed = computePsi(current, { iphone15: 100 });
      expect(Number.isFinite(reversed)).toBe(true);
      expect(reversed).toBeGreaterThan(DRIFT_THRESHOLDS.psiWarning);
    },
  );

  it("prototype-key labels in identical distributions still give ~0", () => {
    const counts: Record<string, number> = { constructor: 50, toString: 30, ["__proto__"]: 20 };
    expect(computePsi(counts, { ...counts })).toBeCloseTo(0, 6);
  });

  it("prototype-key device model does not silence DriftMonitor: severity is never 'stable' with a NaN psi", () => {
    for (const key of PROTOTYPE_KEYS) {
      const monitor = new DriftMonitor(DRIFT_THRESHOLDS.minSamples);
      for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++) {
        monitor.record({ deviceModel: "iphone15" });
      }
      monitor.freezeReference();
      for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++) monitor.record({ deviceModel: key });
      const result = monitor.test("device_model");
      if ("reason" in result) throw new Error(`device_model unexpectedly not evaluable for ${key}`);
      expect(Number.isFinite(result.psi)).toBe(true);
      expect(result.severity).toBe("drift");
      const alerts = monitor.alerts(at).filter((alert) => alert.metric === "device_model");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.name).toBe("drift_detected");
    }
  });

  it("prototype-key safety: non-finite or negative counts are rejected instead of producing NaN", () => {
    expect(() => computePsi({ a: Number.NaN }, { a: 10 })).toThrow(RangeError);
    expect(() => computePsi({ a: 10 }, { a: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => computePsi({ a: -1, b: 10 }, { a: 10 })).toThrow(RangeError);
  });
});
