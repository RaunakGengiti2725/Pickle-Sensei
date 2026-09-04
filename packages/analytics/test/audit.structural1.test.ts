import { describe, expect, it } from "vitest";
import { BufferedAnalytics, type AnalyticsEvent } from "../src/index.js";
import { computePsi } from "../src/drift.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1).
 *  - BufferedAnalytics documents re-buffering as "(bounded)"; the bound must
 *    hold for the whole buffer under persistent transport failure, not only
 *    for a single failed batch.
 *  - computePsi is the drift statistic every threshold decision hangs on; a
 *    NaN must never be returned silently (NaN compares false to every
 *    threshold, i.e. "stable").
 */

function event(i: number): AnalyticsEvent {
  return {
    name: "app_opened",
    at: `2026-08-29T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    sessionId: "s-audit",
    appBuild: "1",
    deviceClass: "phone",
  } as AnalyticsEvent;
}

describe("audit: BufferedAnalytics bound under persistent transport failure", () => {
  it("never holds more than maxBuffer events while the transport keeps failing", async () => {
    const maxBuffer = 3;
    const sink = new BufferedAnalytics(async () => {
      throw new Error("offline");
    }, maxBuffer);
    for (let i = 0; i < 30; i += 1) {
      sink.track(event(i));
      await Promise.resolve();
    }
    await sink.flush();
    expect(sink.pendingCount()).toBeLessThanOrEqual(maxBuffer);
  });

  it("a synchronous burst of tracks during an outage stays bounded once flushes settle", async () => {
    // Real callers track synchronously (no await between events); each
    // auto-flush is in flight concurrently and each failure re-buffers its own
    // batch. The documented bound must still hold for the buffer as a whole.
    const maxBuffer = 3;
    const sink = new BufferedAnalytics(async () => {
      throw new Error("offline");
    }, maxBuffer);
    for (let i = 0; i < 30; i += 1) sink.track(event(i));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.pendingCount()).toBeLessThanOrEqual(maxBuffer);
  });
});

describe("audit: computePsi input hygiene", () => {
  it("does not return NaN when a count is NaN", () => {
    const psi = computePsi({ a: Number.NaN, b: 10 }, { a: 5, b: 5 });
    expect(Number.isFinite(psi)).toBe(true);
  });

  it("does not return NaN/Infinity when a count is negative", () => {
    // Negative counts are impossible for a distribution; the statistic must
    // refuse them (throw) or stay finite — never propagate NaN into a verdict.
    let psi: number | null = null;
    let threw = false;
    try {
      psi = computePsi({ a: -10, b: 10 }, { a: 5, b: 5 });
    } catch {
      threw = true;
    }
    expect(threw || (psi !== null && Number.isFinite(psi))).toBe(true);
  });
});
