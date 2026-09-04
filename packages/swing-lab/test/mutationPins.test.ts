import { describe, expect, it } from "vitest";
import { segmentPhasesTemporalV2 } from "../src/phaseTemporal.js";

/**
 * Mutation pins for phase.paddle-temporal.v2 anchor-free mode
 * (tools/mutation-pipeline-scoring). Kills:
 *   PHT-02  in-event sample filter `<= event.endMs` -> `< event.endMs`
 * Replay: `node tools/mutation-pipeline-scoring/run.mjs --only PHT-02 --with-pins`.
 */

function gaussianSeries(
  peakMs: number,
  height: number,
  halfWidthMs: number,
  fromMs: number,
  toMs: number,
  stepMs = 40,
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    series.push({
      timestampMs: t,
      value: 0.08 + height * Math.exp(-0.5 * ((t - peakMs) / halfWidthMs) ** 2),
    });
  }
  return series;
}

describe("segmentPhasesTemporalV2 anchor-free mutation pins", () => {
  it("PHT-02: a kinematic sample timestamped exactly at event.endMs belongs to the event", () => {
    // Apex sits exactly on the labeled event end (a frame-quantized label
    // often lands there). Inclusive filtering owns that sample; an exclusive
    // filter would see it as a stronger margin peak and abstain.
    const endMs = 1200;
    const paddleSpeeds = gaussianSeries(endMs, 2.4, 120, 0, 2400);
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 800, endMs, peakMs: endMs },
      contactMs: null,
      paddleSpeeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.anchorBasis).toBe("event_peak");
    expect(outcome.boundaries.motionPeakMs).toBe(endMs);
    expect(Number.isNaN(outcome.boundaries.contactMs)).toBe(true);
  });

  it("PHT-02: exactly four in-event samples, the last on event.endMs, clear the evidence floor", () => {
    // Samples every 40ms; the event [1000, 1120] contains 1000/1040/1080/1120
    // — four samples, the minimum. Excluding the boundary sample would leave
    // three and abstain with the "strictly inside the event" reason.
    const paddleSpeeds = gaussianSeries(1080, 2.4, 100, 0, 2400);
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1120, peakMs: 1080 },
      contactMs: null,
      paddleSpeeds,
      wristSpeeds: null,
    });
    if (outcome.status === "abstained") {
      expect(outcome.reason).not.toMatch(/kinematic samples strictly inside the event/);
    }
    // Shrinking the event by a single millisecond drops the boundary sample:
    // three in-event samples MUST abstain on the evidence floor.
    const shrunk = segmentPhasesTemporalV2({
      event: { startMs: 1000, endMs: 1119, peakMs: 1080 },
      contactMs: null,
      paddleSpeeds,
      wristSpeeds: null,
    });
    expect(shrunk.status).toBe("abstained");
    if (shrunk.status !== "abstained") return;
    expect(shrunk.reason).toMatch(/only 3 kinematic samples strictly inside the event/);
  });
});
