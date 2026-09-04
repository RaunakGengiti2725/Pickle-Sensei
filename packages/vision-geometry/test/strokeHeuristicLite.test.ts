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

  it("claims OVERHEAD when a plausible high contact point is corroborated by the raised wrist", () => {
    const high = generateSwingSequence({ contactHeightRatio: 1.2 });
    const contactFrame = high.sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - high.window.peakMs) <
      Math.abs(best.timestampMs - high.window.peakMs)
        ? frame
        : best,
    );
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const prediction = classifyStroke({
      sequence: high.sequence,
      window: { startMs: high.window.startMs, endMs: high.window.endMs },
      contactMs: high.window.peakMs,
      handedness: "right",
      paddle: paddleAt(wrist.x + 0.02, wrist.y - 0.03, high.window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("OVERHEAD");
    expect(prediction.leaf).toBe("OVERHEAD");
    expect(prediction.taxonomyDepth).toBe(1);
  });

  it("does NOT claim OVERHEAD from a floating high paddle box the wrist never reached", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.62, 0.05, window.peakMs), // far above shoulder line
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).not.toBe("OVERHEAD");
    expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
    expect(prediction.contactPointSource).toBe("wrist");
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
      prediction.limitingFactors.some((factor) => factor.includes("contact_too_close_to_midline")),
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

describe("gate 14: sparse sampling around the event peak (XCF-08 root cause)", () => {
  // The AUTO route commits a side only at confidence >= 0.5
  // (AUTO_RESOLUTION_MIN_CONFIDENCE in @pickle/analysis-pipeline); a sparse
  // event window must land strictly below that, whatever the wrist says.
  const AUTO_COMMIT_THRESHOLD = 0.5;
  const { sequence, window } = generateSwingSequence();
  const intervalMs = 1000 / sequence.video.fps;

  function classifyWithFrames(frames: typeof sequence.frames) {
    return classifyStroke({
      sequence: { ...sequence, frames },
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
  }

  it("fully sampled event peak commits the side at or above the commit threshold", () => {
    const prediction = classifyWithFrames(sequence.frames);
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.confidence).toBeGreaterThanOrEqual(AUTO_COMMIT_THRESHOLD);
    expect(prediction.limitingFactors).not.toContain("sampling.sparse_event_window");
  });

  it("frame gap > 1.5 frame intervals at the event peak abstains below the commit threshold", () => {
    // Drop every frame within one interval of the peak: the frames that
    // bracket the peak are then >= 2 intervals apart (only the event is
    // missing; the rest of the swing is fully sampled).
    const gapped = sequence.frames.filter(
      (frame) => Math.abs(frame.timestampMs - window.peakMs) >= intervalMs,
    );
    expect(gapped.length).toBeLessThan(sequence.frames.length);
    const before = gapped.filter((frame) => frame.timestampMs < window.peakMs).at(-1)!;
    const after = gapped.find((frame) => frame.timestampMs > window.peakMs)!;
    expect((after.timestampMs - before.timestampMs) / intervalMs).toBeGreaterThan(1.5);

    const prediction = classifyWithFrames(gapped);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("sampling.sparse_event_window");
    expect(prediction.confidence).toBeLessThan(AUTO_COMMIT_THRESHOLD);
    expect(prediction.evidence.some((entry) => entry.includes("frame intervals apart"))).toBe(true);
  });

  it("a gap elsewhere in the window (not at the peak) does not trip the gate", () => {
    const awayMs = window.peakMs - 400;
    const gapped = sequence.frames.filter(
      (frame) => Math.abs(frame.timestampMs - awayMs) >= intervalMs,
    );
    expect(gapped.length).toBeLessThan(sequence.frames.length);
    const prediction = classifyWithFrames(gapped);
    expect(prediction.limitingFactors).not.toContain("sampling.sparse_event_window");
    expect(prediction.label).toBe("FOREHAND");
  });
});

describe("gate: degenerate shoulder separation abstains the side decision (E10-F3 root cause)", () => {
  // Hand-built frames: collapsed image-plane shoulders (below the 0.04
  // floor) with a MEASURED rival (left) wrist, so the fixture reaches the
  // side decision and the degeneracy cannot be masked by any earlier gate.
  // Torso extent stays normal (0.2u).
  type LiteSequence = Parameters<typeof classifyStroke>[0]["sequence"];

  function collapsedShoulderFrames(shoulderSeparation: number) {
    const frames = [];
    for (let t = 1500; t <= 2500; t += 33) {
      const landmarks = [
        { name: "left_shoulder", x: 0.7, y: 0.4, visibility: 0.9 },
        { name: "right_shoulder", x: 0.7 + shoulderSeparation, y: 0.4, visibility: 0.9 },
        { name: "left_hip", x: 0.68, y: 0.6, visibility: 0.9 },
        { name: "right_hip", x: 0.73, y: 0.6, visibility: 0.9 },
        { name: "right_elbow", x: 0.8, y: 0.48, visibility: 0.9 },
        { name: "left_elbow", x: 0.62, y: 0.48, visibility: 0.8 },
        { name: "right_wrist", x: 0.85 + (t % 200) / 4000, y: 0.55, visibility: 0.9 },
        { name: "left_wrist", x: 0.6, y: 0.55, visibility: 0.8 },
      ];
      frames.push({ timestampMs: t, landmarks });
    }
    return { fps: 30, frames } as unknown as LiteSequence;
  }

  function classifyCollapsed(shoulderSeparation: number) {
    return classifyStroke({
      sequence: collapsedShoulderFrames(shoulderSeparation),
      window: { startMs: 1700, endMs: 2300 },
      contactMs: 2000,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
  }

  it("abstains with collapsed shoulders even though the rival wrist is measured", () => {
    const prediction = classifyCollapsed(0.02);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "shoulder_separation_degenerate_side_decision_unreliable",
    );
    expect(prediction.evidence.some((entry) => entry.includes("shoulder separation"))).toBe(true);
  });

  it("normal shoulders do not trip the gate", () => {
    const prediction = classifyCollapsed(0.16);
    expect(prediction.limitingFactors).not.toContain(
      "shoulder_separation_degenerate_side_decision_unreliable",
    );
    expect(prediction.label).toBe("FOREHAND");
  });
});
