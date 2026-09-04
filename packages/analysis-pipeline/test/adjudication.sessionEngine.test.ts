import { describe, expect, it } from "vitest";
import { SessionEventEngine, type SpeedSample } from "../src/sessionEngine.js";

/**
 * ADJUDICATION REPRO (area pkg-analysis-pipeline, baseline 4d812e1a).
 *
 * Each `it` asserts the EXPECTED behaviour; a failure at the baseline is the
 * reproduction. Synthetic wrist-speed streams only (clearly synthetic).
 */

/** ~30 fps wrist-speed stream with one Gaussian stroke bump every 2.4 s. */
function liveStream(seconds: number, stepMs = 33): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    const phase = t % 2400;
    out.push({
      timestampMs: t,
      value: 0.08 + 2.0 * Math.exp(-0.5 * ((phase - 1200) / 120) ** 2),
    });
  }
  return out;
}

describe("ADJ-AP-001 SessionEventEngine per-push cost must not grow with session length", () => {
  it("mean pushWristSample cost in minute 5 stays within 3x of minute 1 (30 fps live feed)", () => {
    const engine = new SessionEventEngine({ sessionId: "adj-push-cost" });
    const perMinute: Array<{ minute: number; meanMs: number; maxMs: number; events: number }> = [];
    let windowStart = 0;
    let cost = 0;
    let max = 0;
    let count = 0;
    for (const sample of liveStream(305)) {
      const t0 = performance.now();
      engine.pushWristSample(sample);
      const dt = performance.now() - t0;
      cost += dt;
      max = Math.max(max, dt);
      count += 1;
      if (sample.timestampMs - windowStart >= 60_000) {
        perMinute.push({
          minute: perMinute.length + 1,
          meanMs: cost / count,
          maxMs: max,
          events: engine.snapshot().events.length,
        });
        windowStart = sample.timestampMs;
        cost = 0;
        max = 0;
        count = 0;
      }
    }
    console.log(
      "ADJ-AP-001 per-minute push cost:",
      perMinute
        .map(
          (row) =>
            `m${row.minute} mean=${row.meanMs.toFixed(3)}ms max=${row.maxMs.toFixed(2)}ms events=${row.events}`,
        )
        .join(" | "),
    );
    const first = perMinute[0]!;
    const last = perMinute[perMinute.length - 1]!;
    expect(perMinute.length).toBe(5);
    expect(
      last.meanMs / first.meanMs,
      `per-push cost grew ${(last.meanMs / first.meanMs).toFixed(1)}x from minute 1 to minute ${last.minute}`,
    ).toBeLessThanOrEqual(3);
  }, 120_000);
});
