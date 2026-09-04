import { describe, expect, it } from "vitest";
import { BufferedAnalytics, type AnalyticsEvent } from "../src/index.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests for the
 * analytics buffer bound under persistent transport failure. The transport
 * stays in flight while more events arrive (the normal mobile situation on a
 * dead network), then every batch fails.
 */

const at = "2026-08-29T00:00:00.000Z";

function pendingTransport(): {
  transport: (batch: AnalyticsEvent[]) => Promise<void>;
  failAll: () => void;
  inFlight: () => number;
} {
  const rejecters: Array<(reason: Error) => void> = [];
  return {
    transport: () =>
      new Promise<void>((_, reject) => {
        rejecters.push(reject);
      }),
    failAll: () => {
      for (const reject of rejecters.splice(0)) reject(new Error("network down"));
    },
    inFlight: () => rejecters.length,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("AUDIT BufferedAnalytics: pending buffer is bounded by maxBuffer under persistent failure", () => {
  it("re-buffered failed batches never accumulate past maxBuffer", async () => {
    const maxBuffer = 3;
    const net = pendingTransport();
    const analytics = new BufferedAnalytics(net.transport, maxBuffer);

    for (let i = 0; i < 12; i++) analytics.track({ name: "app_opened", at });
    expect(net.inFlight()).toBe(4); // 4 auto-flushes of 3 events each are in flight
    net.failAll();
    await settle();

    expect(
      analytics.pendingCount(),
      `buffer holds ${analytics.pendingCount()} events with maxBuffer=${maxBuffer}`,
    ).toBeLessThanOrEqual(maxBuffer);
  });

  it("a second failure round with fresh events still respects the bound", async () => {
    const maxBuffer = 3;
    const net = pendingTransport();
    const analytics = new BufferedAnalytics(net.transport, maxBuffer);

    for (let i = 0; i < 6; i++) analytics.track({ name: "app_opened", at });
    net.failAll();
    await settle();
    for (let i = 0; i < 6; i++) analytics.track({ name: "app_opened", at });
    net.failAll();
    await settle();

    expect(analytics.pendingCount()).toBeLessThanOrEqual(maxBuffer);
  });
});
