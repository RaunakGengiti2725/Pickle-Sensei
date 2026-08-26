import { describe, expect, it } from "vitest";
import { BufferedAnalytics, type AnalyticsEvent } from "../src/index.js";

const at = "2026-08-26T18:00:00.000Z";

describe("BufferedAnalytics", () => {
  it("flushes buffered events through the transport", async () => {
    const sent: AnalyticsEvent[][] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      sent.push(batch);
    });
    analytics.track({ name: "app_opened", at });
    analytics.track({ name: "shot_type_selected", shotType: "forehand_drive", at });
    await analytics.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(analytics.pendingCount()).toBe(0);
  });

  it("re-buffers on transport failure instead of dropping silently", async () => {
    let fail = true;
    const analytics = new BufferedAnalytics(async () => {
      if (fail) throw new Error("network down");
    });
    analytics.track({ name: "app_opened", at });
    await analytics.flush();
    expect(analytics.pendingCount()).toBe(1);
    fail = false;
    await analytics.flush();
    expect(analytics.pendingCount()).toBe(0);
  });

  it("auto-flushes at the buffer cap", async () => {
    const sent: AnalyticsEvent[][] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      sent.push(batch);
    }, 3);
    for (let i = 0; i < 3; i++) analytics.track({ name: "app_opened", at });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.flat()).toHaveLength(3);
  });
});
