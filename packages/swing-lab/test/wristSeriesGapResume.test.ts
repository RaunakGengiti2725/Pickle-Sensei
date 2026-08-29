import { describe, expect, it } from "vitest";
import { dominantWristSpeeds } from "../src/engine/minerCore.js";

/** Frames with one visible right wrist moving at constant speed, with a
 * visibility dropout window in the middle. */
function framesWithDropout(dropout: { fromMs: number; toMs: number }, stepMs = 40) {
  const frames: Array<{
    timestampMs: number;
    landmarks: Array<{ name: string; x: number; y: number; visibility: number }>;
  }> = [];
  for (let t = 0; t <= 4000; t += stepMs) {
    const hidden = t >= dropout.fromMs && t <= dropout.toMs;
    frames.push({
      timestampMs: t,
      landmarks: [
        {
          name: "right_wrist",
          x: 0.3 + (t / 4000) * 0.2,
          y: 0.5,
          visibility: hidden ? 0.1 : 0.9,
        },
      ],
    });
  }
  return frames;
}

describe("dominantWristSpeeds — visibility dropouts", () => {
  it("resumes the series after a dropout longer than the 150ms gap cap", () => {
    const speeds = dominantWristSpeeds(framesWithDropout({ fromMs: 1500, toMs: 2000 }));
    const afterGap = speeds.filter((sample) => sample.timestampMs > 2000);
    expect(afterGap.length).toBeGreaterThan(10);
    const lastMs = speeds[speeds.length - 1]!.timestampMs;
    expect(lastMs).toBeGreaterThanOrEqual(3960);
  });

  it("emits no sample whose velocity spans the dropout itself", () => {
    const speeds = dominantWristSpeeds(framesWithDropout({ fromMs: 1500, toMs: 2000 }));
    const spanning = speeds.filter(
      (sample) => sample.timestampMs > 2000 && sample.timestampMs <= 2040 + 150,
    );
    // the first post-gap observation pairs with the pre-gap position across
    // >150ms and must be skipped; consecutive post-gap pairs are kept
    for (const sample of spanning) {
      expect(sample.value).toBeLessThan(1);
    }
  });

  it("keeps velocities anchored to the previous observation, not the previous sample", () => {
    // Alternating visibility (visible every other frame → 80ms observation
    // gaps): every emitted sample must use the 80ms observation gap, so a
    // constant-velocity wrist yields constant speed values.
    const frames: Array<{
      timestampMs: number;
      landmarks: Array<{ name: string; x: number; y: number; visibility: number }>;
    }> = [];
    for (let t = 0; t <= 2000; t += 40) {
      frames.push({
        timestampMs: t,
        landmarks: [
          {
            name: "right_wrist",
            x: 0.3 + (t / 4000) * 0.2,
            y: 0.5,
            visibility: (t / 40) % 2 === 0 ? 0.9 : 0.1,
          },
        ],
      });
    }
    const speeds = dominantWristSpeeds(frames);
    expect(speeds.length).toBeGreaterThan(10);
    const values = speeds.map((sample) => sample.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(max - min).toBeLessThan(1e-9);
  });
});
