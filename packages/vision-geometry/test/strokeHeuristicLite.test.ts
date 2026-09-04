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

describe("gate: torso landmarks below the visibility floor at the reference frame abstain (VG-7)", () => {
  // A landmark carrying visibility < 0.3 is UNMEASURED under the package's
  // own measurement contract (kinematics.landmark → null). Such a landmark
  // must never define the midline / torso normalization: its coordinates
  // are whatever the pose model last emitted, not a measurement.
  const { sequence, window } = generateSwingSequence();
  const args = {
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: window.peakMs,
    handedness: "right" as const,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  };
  const TORSO = new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]);

  function withTorsoVisibilityAtReference(visibility: number, names: ReadonlySet<string> = TORSO) {
    const nearest = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    return {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        frame === nearest
          ? {
              ...frame,
              landmarks: frame.landmarks.map((mark) =>
                names.has(mark.name) ? { ...mark, visibility } : mark,
              ),
            }
          : frame,
      ),
    };
  }

  it("all four torso landmarks at visibility 0.29 → UNKNOWN with a torso-unmeasured reason", () => {
    const prediction = classifyStroke({
      sequence: withTorsoVisibilityAtReference(0.29),
      ...args,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_unmeasured_at_reference");
    expect(Number.isFinite(prediction.confidence)).toBe(true);
  });

  it("a single torso landmark below the floor is enough to abstain (midline needs both shoulders)", () => {
    const prediction = classifyStroke({
      sequence: withTorsoVisibilityAtReference(0, new Set(["left_shoulder"])),
      ...args,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_unmeasured_at_reference");
    expect(prediction.evidence.some((entry) => entry.includes("left_shoulder"))).toBe(true);
  });

  it("NaN visibility is not a measurement either", () => {
    const prediction = classifyStroke({
      sequence: withTorsoVisibilityAtReference(Number.NaN),
      ...args,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_unmeasured_at_reference");
  });

  it("control: torso landmarks at exactly the 0.3 floor still commit FOREHAND", () => {
    const prediction = classifyStroke({
      sequence: withTorsoVisibilityAtReference(0.3),
      ...args,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.limitingFactors).not.toContain("torso_unmeasured_at_reference");
  });

  it("control: the untouched synthetic swing commits FOREHAND", () => {
    const prediction = classifyStroke({ sequence, ...args });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("gate: invalid paddle centers never decide the contact point (VG-1)", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };

  /** Dominant wrist unmeasured at the reference frame (visibility 0.1). */
  const blind = {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - window.peakMs) <= 8
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "right_wrist" ? { ...mark, visibility: 0.1 } : mark,
            ),
          }
        : frame,
    ),
  };

  function paddleTrackAt(x: number, y: number, confidence = 0.9): HeuristicPaddleObservation[] {
    return paddleAt(x, y, window.peakMs).map((observation) => ({ ...observation, confidence }));
  }

  function classifyWith(seq: typeof sequence, paddle: HeuristicPaddleObservation[]) {
    return classifyStroke({
      sequence: seq,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
  }

  it("invalid center + unmeasured wrist → UNKNOWN, paddle_center_invalid, no paddle provenance", () => {
    for (const center of [
      { x: Number.NaN, y: 0.5 },
      { x: 0.8, y: Number.NaN },
      { x: Number.POSITIVE_INFINITY, y: 0.5 },
      { x: 0.8, y: Number.NEGATIVE_INFINITY },
      { x: 5, y: 0.5 },
      { x: -7, y: 0.5 },
      { x: 0.8, y: 1.5 },
      { x: 0.8, y: -0.4 },
    ]) {
      const prediction = classifyWith(blind, paddleTrackAt(center.x, center.y));
      expect(prediction.label, JSON.stringify(center)).toBe("UNKNOWN");
      expect(prediction.limitingFactors, JSON.stringify(center)).toContain("paddle_center_invalid");
      expect(prediction.contactPointSource, JSON.stringify(center)).toBeNull();
      expect(Number.isFinite(prediction.confidence), JSON.stringify(center)).toBe(true);
    }
  });

  it("invalid center + measured wrist → falls back to the wrist and records paddle_center_invalid", () => {
    const prediction = classifyWith(sequence, paddleTrackAt(Number.NaN, 0.5));
    expect(prediction.contactPointSource).toBe("wrist");
    expect(prediction.limitingFactors).toContain("paddle_center_invalid");
    expect(prediction.limitingFactors).not.toContain("paddle_not_tracked_at_contact");
    expect(prediction.label).toBe("FOREHAND");
    expect(Number.isFinite(prediction.confidence)).toBe(true);
  });

  it("control: a valid in-image center is still used as the paddle contact point", () => {
    const contactFrame = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const prediction = classifyWith(sequence, paddleTrackAt(wrist.x + 0.02, wrist.y + 0.02));
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.limitingFactors).not.toContain("paddle_center_invalid");
  });

  it("fuzz: 200 seeds of NaN / ±Infinity / out-of-range centers → confidence always finite in [0,1]", () => {
    // Deterministic LCG so a failing seed is reproducible from the log.
    let state = 0x5eed;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const invalidCoordinate = (): number => {
      const pick = next();
      if (pick < 0.2) return Number.NaN;
      if (pick < 0.4) return Number.POSITIVE_INFINITY;
      if (pick < 0.6) return Number.NEGATIVE_INFINITY;
      if (pick < 0.8) return 1.1 + next() * 100; // beyond the right/bottom edge
      return -0.1 - next() * 100; // beyond the left/top edge
    };
    const validCoordinate = (): number => next();

    for (let seed = 0; seed < 200; seed += 1) {
      // At least one coordinate is invalid; the other may be valid or invalid.
      const invalidAxis = next() < 0.5 ? "x" : "y";
      const x = invalidAxis === "x" || next() < 0.5 ? invalidCoordinate() : validCoordinate();
      const y = invalidAxis === "y" || next() < 0.5 ? invalidCoordinate() : validCoordinate();
      const confidence = next() < 0.5 ? 0.9 : 0.1;
      const seq = next() < 0.5 ? blind : sequence;
      const prediction = classifyWith(seq, paddleTrackAt(x, y, confidence));
      const label = `seed=${seed} center=(${x}, ${y}) conf=${confidence} wrist=${seq === blind ? "blind" : "measured"}`;
      expect(Number.isFinite(prediction.confidence), label).toBe(true);
      expect(prediction.confidence, label).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence, label).toBeLessThanOrEqual(1);
      expect(prediction.contactPointSource, label).not.toBe("paddle");
      expect(prediction.limitingFactors, label).toContain("paddle_center_invalid");
    }
  });
});
