import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  classifyStroke,
  STROKE_TAXONOMY_V3,
  type HeuristicPaddleObservation,
} from "../src/index.js";

/**
 * Behavioral lock for the PORTED stroke heuristic (strokeHeuristicLite.ts).
 * These cases mirror swing-lab's strokeHeuristic.test.ts so the port stays
 * byte-equivalent in behavior until the planned dedup (swing-lab re-exporting
 * from here) lands. The added mobile-reality case: no paddle track at all —
 * the wrist fallback is what the app will actually exercise today.
 */

/** Paddle observations pinned at a fixed point around contact. */
function paddleAt(x: number, y: number, contactMs: number): HeuristicPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
  }));
}

describe("classifyStroke (ported heuristic, hierarchical)", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };

  it("stops at depth 2 with a side when bounce is unobservable", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: Array.from({ length: 20 }, (_, index) => ({
        timestampMs: window.peakMs - 300 + index * 30,
        value: 1.8,
      })),
      wristSpeeds: null,
    });
    expect(prediction.taxonomyVersion).toBe(STROKE_TAXONOMY_V3.version);
    expect(prediction.taxonomyDepth).toBe(2);
    expect(["FOREHAND", "BACKHAND"]).toContain(prediction.label);
    expect(prediction.leaf).toBeNull(); // no L3 commitment without bounce
    expect(prediction.limitingFactors).toContain("bounce_not_observed_level3_uncommitted");
    expect(prediction.evidence.some((entry) => entry.includes("speed peak"))).toBe(true);
  });

  it("falls back to the dominant wrist when no paddle is tracked (mobile reality)", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    // Synthetic right-handed swing: contact wrist is well right of midline.
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.leaf).toBeNull();
    expect(prediction.limitingFactors).toContain("paddle_not_tracked_at_contact");
    expect(prediction.limitingFactors).toContain("reference_is_event_peak_not_contact");
    expect(prediction.confidence).toBeGreaterThanOrEqual(0.525);
  });

  it("claims OVERHEAD at depth 1 when contact is measured above the shoulders", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.62, 0.05, window.peakMs), // far above shoulder line
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("OVERHEAD");
    expect(prediction.leaf).toBe("OVERHEAD");
    expect(prediction.taxonomyDepth).toBe(1);
  });

  it("abstains to UNKNOWN when contact sits on the body midline", () => {
    const { sequence: seq2, window: window2 } = generateSwingSequence();
    const contactFrame = seq2.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window2.peakMs) < Math.abs(best.timestampMs - window2.peakMs)
        ? frame
        : best,
    );
    const shoulders = contactFrame.landmarks.filter((mark) => mark.name.endsWith("shoulder"));
    const midX = (shoulders[0]!.x + shoulders[1]!.x) / 2;
    const midY = (shoulders[0]!.y + shoulders[1]!.y) / 2 + 0.1;
    const prediction = classifyStroke({
      sequence: seq2,
      window: { startMs: window2.startMs, endMs: window2.endMs },
      contactMs: window2.peakMs,
      handedness: "right",
      paddle: paddleAt(midX, midY, window2.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(
      prediction.limitingFactors.some((factor) =>
        factor.includes("contact_too_close_to_midline"),
      ),
    ).toBe(true);
  });

  it("uses the event peak (never a window midpoint) when contact is missing", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.limitingFactors).toContain("reference_is_event_peak_not_contact");

    const noReference = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: null,
      eventPeakMs: null,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(noReference.label).toBe("UNKNOWN");
    expect(noReference.limitingFactors).toContain("no_contact_and_no_event_peak_reference");
  });

  it("refuses a side for ambidextrous players instead of guessing one", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "ambidextrous",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("ambidextrous_declared_side_unresolvable");
  });
});
