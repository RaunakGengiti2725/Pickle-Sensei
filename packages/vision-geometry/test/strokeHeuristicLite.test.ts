import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
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
function paddleAt(
  x: number,
  y: number,
  contactMs: number,
  confidence?: number,
): HeuristicPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
    ...(confidence === undefined ? {} : { confidence }),
  }));
}

/** Right wrist unmeasured (visibility 0.1) on every frame within ±8 ms of contact. */
function withWristInvisibleAtContact(sequence: PoseSequence, contactMs: number): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - contactMs) <= 8
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "right_wrist" ? { ...mark, visibility: 0.1 } : mark,
            ),
          }
        : frame,
    ),
  };
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

describe("gate: implausible paddle centers never become the contact point (VG-1)", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };
  const blind = withWristInvisibleAtContact(sequence, window.peakMs);
  const centers = [
    { x: Number.NaN, y: 0.5 },
    { x: 0.5, y: Number.NaN },
    { x: Number.POSITIVE_INFINITY, y: 0.5 },
    { x: 5, y: 0.5 },
    { x: -7, y: 0.5 },
  ];

  it.each(centers)(
    "abstains with a finite confidence for center %o when the wrist is unmeasured at contact",
    (center) => {
      const prediction = classifyStroke({
        sequence: blind,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(center.x, center.y, window.peakMs, 0.9),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(prediction.label).toBe("UNKNOWN");
      expect(Number.isFinite(prediction.confidence)).toBe(true);
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
      expect(
        prediction.limitingFactors.some((factor) =>
          /paddle_center_(not_finite|out_of_image)|paddle_point_implausible/.test(factor),
        ),
      ).toBe(true);
      expect(prediction.contactPointSource).not.toBe("paddle");
    },
  );

  it.each(centers)(
    "falls back to the visible wrist with a finite confidence for center %o",
    (center) => {
      const prediction = classifyStroke({
        sequence,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(center.x, center.y, window.peakMs, 0.9),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(prediction.contactPointSource).toBe("wrist");
      expect(Number.isFinite(prediction.confidence)).toBe(true);
      expect(
        prediction.limitingFactors.some((factor) =>
          /paddle_center_(not_finite|out_of_image)|paddle_point_implausible/.test(factor),
        ),
      ).toBe(true);
    },
  );
});

describe("contract: the classification window is validated (VG-2)", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };
  const classifyWithWindow = (candidate: { startMs: number; endMs: number }) =>
    classifyStroke({
      sequence,
      window: candidate,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: Array.from({ length: 20 }, (_, index) => ({
        timestampMs: window.peakMs - 300 + index * 30 + 7,
        value: 1.8,
      })),
    });

  it.each([
    { name: "zero-length", startMs: window.peakMs, endMs: window.peakMs },
    { name: "inverted", startMs: window.endMs, endMs: window.startMs },
    { name: "NaN start", startMs: Number.NaN, endMs: window.endMs },
    { name: "infinite end", startMs: window.startMs, endMs: Number.POSITIVE_INFINITY },
  ])("rejects a $name window as invalid_classification_window", (candidate) => {
    const prediction = classifyWithWindow(candidate);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("invalid_classification_window");
    expect(Number.isFinite(prediction.confidence)).toBe(true);
  });

  it("rejects a reference that lies outside the window as contact_outside_window", () => {
    const prediction = classifyWithWindow({ startMs: 0, endMs: 300 });
    expect(window.peakMs).toBeGreaterThan(300);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("contact_outside_window");
  });

  it("keeps the unmodified generated swing at its pre-change label and confidence", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.confidence).toBe(0.8);
    expect(prediction.limitingFactors).not.toContain("invalid_classification_window");
    expect(prediction.limitingFactors).not.toContain("contact_outside_window");
  });

  it("never reports intensity evidence from zero in-window speed samples", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      // A measured series that lies entirely BEFORE the window: 0 in-window samples.
      wristSpeeds: Array.from({ length: 20 }, (_, index) => ({
        timestampMs: window.startMs - 2000 + index * 30,
        value: 1.8,
      })),
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.evidence.some((entry) => /speed peak 0\.00 u\/s/.test(entry))).toBe(false);
    expect(prediction.evidence.some((entry) => entry.includes("speed peak"))).toBe(false);
    expect(prediction.limitingFactors).toContain("no_speed_samples_in_window");
    expect(prediction.limitingFactors).not.toContain("bounce_not_observed_level3_uncommitted");
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
