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

describe("gate: reference-frame torso must be MEASURED, not merely present (ADJ-VG-01)", () => {
  // Apple Vision forwards an unrecognised joint as visibility 0 (still a
  // landmark entry). The torso gate has to use the same 0.3 visibility floor
  // as kinematics.landmark(): a present-but-unmeasured torso is an absent torso.
  type LiteSequence = Parameters<typeof classifyStroke>[0]["sequence"];
  type LiteLandmark = LiteSequence["frames"][number]["landmarks"][number];
  const TORSO = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"] as const;
  const MIN_LANDMARK_VISIBILITY = 0.3;

  function torsoFrames(torsoVisibility: number, torsoShiftX = 0) {
    const frames = [];
    for (let t = 1500; t <= 2500; t += 33) {
      const landmarks = [
        { name: "left_shoulder", x: 0.62 + torsoShiftX, y: 0.4, visibility: torsoVisibility },
        { name: "right_shoulder", x: 0.78 + torsoShiftX, y: 0.4, visibility: torsoVisibility },
        { name: "left_hip", x: 0.65 + torsoShiftX, y: 0.6, visibility: torsoVisibility },
        { name: "right_hip", x: 0.75 + torsoShiftX, y: 0.6, visibility: torsoVisibility },
        { name: "right_elbow", x: 0.8, y: 0.48, visibility: 0.9 },
        { name: "left_elbow", x: 0.62, y: 0.48, visibility: 0.8 },
        { name: "right_wrist", x: 0.85 + (t % 200) / 4000, y: 0.55, visibility: 0.9 },
        { name: "left_wrist", x: 0.6, y: 0.55, visibility: 0.8 },
      ];
      frames.push({ timestampMs: t, landmarks });
    }
    return { fps: 30, frames } as unknown as LiteSequence;
  }

  function withoutTorso(sequence: LiteSequence): LiteSequence {
    return {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter(
          (mark: LiteLandmark) => !(TORSO as readonly string[]).includes(mark.name),
        ),
      })),
    } as LiteSequence;
  }

  function classify(sequence: LiteSequence) {
    return classifyStroke({
      sequence,
      window: { startMs: 1700, endMs: 2300 },
      contactMs: 2000,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
  }

  it("precondition: a measured torso commits FOREHAND", () => {
    const prediction = classify(torsoFrames(0.9));
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.limitingFactors).not.toContain("torso_not_measured_at_contact");
  });

  it("a torso just below the visibility floor abstains exactly like an absent torso", () => {
    const belowFloor = classify(torsoFrames(MIN_LANDMARK_VISIBILITY - 0.01));
    expect(belowFloor.label).toBe("UNKNOWN");
    expect(belowFloor.taxonomyDepth).toBe(1);
    expect(belowFloor.limitingFactors).toContain("torso_not_measured_at_contact");
    expect(JSON.stringify(belowFloor)).toBe(
      JSON.stringify(classify(withoutTorso(torsoFrames(0.9)))),
    );
  });

  it("a torso exactly at the visibility floor is measured and commits a side", () => {
    const atFloor = classify(torsoFrames(MIN_LANDMARK_VISIBILITY));
    expect(atFloor.label).toBe("FOREHAND");
    expect(atFloor.limitingFactors).not.toContain("torso_not_measured_at_contact");
  });

  it("visibility-0 torso coordinates cannot decide the side: shifting them does not flip the label", () => {
    const shifted = [-0.45, 0, 0.45].map((shift) => classify(torsoFrames(0, shift)));
    for (const prediction of shifted) {
      expect(prediction.label).toBe("UNKNOWN");
      expect(prediction.limitingFactors).toContain("torso_not_measured_at_contact");
    }
    expect(new Set(shifted.map((prediction) => JSON.stringify(prediction))).size).toBe(1);
  });
});

describe("gate: every torso consumer must be MEASURED, not merely present (ADJ-VG-01 r2)", () => {
  // The reference-frame gate above is not the only reader of torso joints:
  // the ±200ms facing consensus (shoulders), the ±150ms overhead raise scan
  // (shoulders + hips) and the sequence-median torso extent (shoulders +
  // hips) read landmarks from OTHER frames. Each of them must apply the same
  // 0.3 visibility floor: a present-but-unmeasured torso joint is an absent
  // one, and its coordinates can never reach a verdict.
  type LiteSequence = Parameters<typeof classifyStroke>[0]["sequence"];
  type LiteFrame = LiteSequence["frames"][number];
  type LiteLandmark = LiteFrame["landmarks"][number];
  const SHOULDERS = ["left_shoulder", "right_shoulder"] as const;
  const HIPS = ["left_hip", "right_hip"] as const;
  const TORSO = [...SHOULDERS, ...HIPS] as const;
  const MIN_LANDMARK_VISIBILITY = 0.3;
  const CONTACT_MS = 2000;

  function measuredFrames(referenceWristVisibility = 0.9) {
    const frames = [];
    for (let t = 1500; t <= 2500; t += 33) {
      const atReference = Math.abs(t - CONTACT_MS) <= 20;
      const landmarks = [
        { name: "left_shoulder", x: 0.62, y: 0.4, visibility: 0.9 },
        { name: "right_shoulder", x: 0.78, y: 0.4, visibility: 0.9 },
        { name: "left_hip", x: 0.65, y: 0.6, visibility: 0.9 },
        { name: "right_hip", x: 0.75, y: 0.6, visibility: 0.9 },
        { name: "right_elbow", x: 0.8, y: 0.48, visibility: 0.9 },
        { name: "left_elbow", x: 0.62, y: 0.48, visibility: 0.8 },
        {
          name: "right_wrist",
          x: 0.85 + (t % 200) / 4000,
          y: 0.55,
          visibility: atReference ? referenceWristVisibility : 0.9,
        },
        { name: "left_wrist", x: 0.6, y: 0.55, visibility: 0.8 },
      ];
      frames.push({ timestampMs: t, landmarks });
    }
    return { fps: 30, frames } as unknown as LiteSequence;
  }

  const atReference = (frame: LiteFrame) => Math.abs(frame.timestampMs - CONTACT_MS) <= 20;
  const offReference = (frame: LiteFrame) => !atReference(frame);

  function mutate(
    sequence: LiteSequence,
    select: (frame: LiteFrame) => boolean,
    names: readonly string[],
    change: (mark: LiteLandmark) => LiteLandmark,
  ): LiteSequence {
    return {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        select(frame)
          ? {
              ...frame,
              landmarks: frame.landmarks.map((mark: LiteLandmark) =>
                names.includes(mark.name) ? change(mark) : mark,
              ),
            }
          : frame,
      ),
    } as LiteSequence;
  }

  function remove(
    sequence: LiteSequence,
    select: (frame: LiteFrame) => boolean,
    names: readonly string[],
  ): LiteSequence {
    return {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        select(frame)
          ? {
              ...frame,
              landmarks: frame.landmarks.filter((mark: LiteLandmark) => !names.includes(mark.name)),
            }
          : frame,
      ),
    } as LiteSequence;
  }

  function classify(sequence: LiteSequence) {
    return classifyStroke({
      sequence,
      window: { startMs: 1700, endMs: 2300 },
      contactMs: CONTACT_MS,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
  }

  const asJson = (sequence: LiteSequence) => JSON.stringify(classify(sequence));

  describe("facing consensus (±200ms shoulder x-order votes)", () => {
    const mirroredInvisible = mutate(measuredFrames(), offReference, SHOULDERS, (mark) => ({
      ...mark,
      x: 1 - mark.x,
      visibility: 0,
    }));
    const inPlaceInvisible = mutate(measuredFrames(), offReference, SHOULDERS, (mark) => ({
      ...mark,
      visibility: 0,
    }));
    const absent = remove(measuredFrames(), offReference, SHOULDERS);

    it("precondition: measured shoulders reach a rear-view consensus and commit FOREHAND", () => {
      const control = classify(measuredFrames());
      expect(control.label).toBe("FOREHAND");
      expect(control.evidence.some((line) => line.includes("facing consensus"))).toBe(true);
    });

    it("visibility-0 shoulders cannot vote: byte-identical to absent shoulders", () => {
      expect(asJson(mirroredInvisible)).toBe(asJson(absent));
      expect(asJson(inPlaceInvisible)).toBe(asJson(absent));
    });

    it("mirrored visibility-0 shoulders never flip the committed side", () => {
      const poisoned = classify(mirroredInvisible);
      expect(poisoned.label).toBe("FOREHAND");
      expect(poisoned.evidence.some((line) => line.includes("front-ish"))).toBe(false);
    });

    it("shoulders exactly at the visibility floor still vote", () => {
      const atFloor = mutate(measuredFrames(), offReference, SHOULDERS, (mark) => ({
        ...mark,
        visibility: MIN_LANDMARK_VISIBILITY,
      }));
      expect(asJson(atFloor)).toBe(asJson(measuredFrames()));
      const belowFloor = mutate(measuredFrames(), offReference, SHOULDERS, (mark) => ({
        ...mark,
        visibility: MIN_LANDMARK_VISIBILITY - 0.01,
      }));
      expect(asJson(belowFloor)).toBe(asJson(absent));
    });
  });

  describe("overhead raise scan (±150ms per-frame shoulder line + torso extent)", () => {
    // A degraded reference wrist (0.4: above the 0.25 dominant-wrist floor,
    // below the 0.5 reliable floor) lets a raised skeletal window decide
    // OVERHEAD by itself — so an unmeasured torso dragged below the wrist
    // must not be able to manufacture that raise.
    const degraded = measuredFrames(0.4);
    const draggedInvisible = mutate(degraded, offReference, TORSO, (mark) => ({
      ...mark,
      y: mark.name.endsWith("shoulder") ? 0.8 : 0.99,
      visibility: 0,
    }));
    const inPlaceInvisible = mutate(degraded, offReference, TORSO, (mark) => ({
      ...mark,
      visibility: 0,
    }));
    const absent = remove(degraded, offReference, TORSO);

    it("precondition: the degraded-wrist fixture commits FOREHAND", () => {
      expect(classify(degraded).label).toBe("FOREHAND");
    });

    it("a visibility-0 torso supplies no shoulder line: byte-identical to an absent torso", () => {
      expect(asJson(draggedInvisible)).toBe(asJson(absent));
      expect(asJson(inPlaceInvisible)).toBe(asJson(absent));
    });

    it("a visibility-0 torso cannot manufacture an OVERHEAD", () => {
      const poisoned = classify(draggedInvisible);
      expect(poisoned.label).not.toBe("OVERHEAD");
      expect(poisoned.label).toBe("FOREHAND");
    });
  });

  describe("sequence-median torso extent (torso-collapse abstention)", () => {
    // Reference hips lifted to half the extent (still visible) must abstain
    // against the honest median. The median needs TORSO_MEDIAN_MIN_FRAMES (5)
    // measured torsos, so five off-reference frames keep honest visible hips;
    // the hips in every OTHER off-reference frame are the attack surface —
    // unmeasured hips there must not be able to drag the median down to the
    // collapsed extent, and their coordinates must be irrelevant.
    const honestFrame = (frame: LiteFrame) => offReference(frame) && frame.timestampMs < 1640;
    const poisonable = (frame: LiteFrame) => offReference(frame) && !honestFrame(frame);
    const collapsedReference = mutate(measuredFrames(), atReference, HIPS, (mark) => ({
      ...mark,
      y: mark.y - 0.1,
    }));
    const collapsedInvisible = mutate(collapsedReference, poisonable, HIPS, (mark) => ({
      ...mark,
      y: mark.y - 0.1,
      visibility: 0,
    }));
    const inPlaceInvisible = mutate(collapsedReference, poisonable, HIPS, (mark) => ({
      ...mark,
      visibility: 0,
    }));
    const absent = remove(collapsedReference, poisonable, HIPS);

    it("precondition: a collapsed visible reference torso abstains against the honest median", () => {
      expect(measuredFrames().frames.filter(honestFrame)).toHaveLength(5);
      const honest = classify(collapsedReference);
      expect(honest.label).toBe("UNKNOWN");
      expect(honest.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");
    });

    it("visibility-0 hips contribute no extent: byte-identical to absent hips", () => {
      expect(asJson(collapsedInvisible)).toBe(asJson(absent));
      expect(asJson(inPlaceInvisible)).toBe(asJson(absent));
    });

    it("visibility-0 hips cannot defeat the collapse abstention into a committed side", () => {
      const poisoned = classify(collapsedInvisible);
      expect(poisoned.label).toBe("UNKNOWN");
      expect(poisoned.taxonomyDepth).toBe(1);
      expect(poisoned.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");
    });
  });
});
