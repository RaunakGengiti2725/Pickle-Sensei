import { describe, expect, it } from "vitest";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import {
  abortedSwingFixture,
  generateSwingSequence,
  nonDominantHandSwingFixture,
  staticReachFixture,
  torsoCollapseBoundaryOverheadFixture,
  torsoHonestShoulderVolleyFixture,
  twoHandedBackhandFixture,
  walkThroughFixture,
  wheelchairDegenerateTorsoFixture,
  wheelchairRimPushFixture,
  wheelchairSeatedStrokeFixture,
  type AdversarialStrokeFixture,
} from "@pickle/evaluation";
import {
  classifyStroke,
  type HeuristicPaddleObservation,
  type HeuristicStrokePrediction,
} from "../src/index.js";

/**
 * RED-TEAM suite for the PORTED heuristic behind mobile AUTO DETECT
 * (wave-d D11). Mirrors swing-lab's strokeHeuristic.redteam.test.ts —
 * the two copies must stay behaviorally equivalent — plus the paddle-track
 * adversaries the lite port was missing entirely at stroke-heuristic-1
 * (implausible floating box, low-confidence stale box).
 */

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

function classifyFixture(
  fixture: AdversarialStrokeFixture,
  overrides: Partial<Parameters<typeof classifyStroke>[0]> = {},
): HeuristicStrokePrediction {
  return classifyStroke({
    sequence: fixture.sequence,
    window: { startMs: fixture.window.startMs, endMs: fixture.window.endMs },
    contactMs: null,
    eventPeakMs: fixture.window.peakMs,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: fixture.wristSpeeds,
    ...overrides,
  });
}

describe("classifyStroke lite red-team (adversarial non-strokes)", () => {
  it("aborted swing (checked-swing wrist speed) abstains instead of committing a side", () => {
    const prediction = classifyFixture(abortedSwingFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_swing_energy_in_window");
  });

  it("walk-through motion abstains instead of committing a side", () => {
    const prediction = classifyFixture(walkThroughFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_swing_energy_in_window");
  });

  it("static reach above the shoulders never becomes a confident OVERHEAD", () => {
    const prediction = classifyFixture(staticReachFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
  });

  it("static reach WITHOUT a speed series still never becomes OVERHEAD (travel gate)", () => {
    const prediction = classifyFixture(staticReachFixture(), { wristSpeeds: null });
    expect(prediction.label).not.toBe("OVERHEAD");
    expect(prediction.limitingFactors).toContain("no_swing_motion_near_reference");
  });

  it("degenerate seated torso geometry (hips collapsed onto shoulders) abstains rather than claiming OVERHEAD", () => {
    const prediction = classifyFixture(wheelchairDegenerateTorsoFixture());
    expect(prediction.label).not.toBe("OVERHEAD");
    expect(prediction.leaf === null || prediction.leaf === "UNKNOWN").toBe(true);
    expect(prediction.limitingFactors).toContain(
      "torso_extent_degenerate_normalization_unreliable",
    );
  });

  it("E10-F2 parity (stroke-heuristic-3.1): a left-hand swing under a right-handed declaration abstains via the handedness cross-check", () => {
    const fixture = nonDominantHandSwingFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "declared_handedness_contradicted_by_dominant_motion_wrist",
    );
  });

  it("E10-F2 parity positive control: the same left-hand swing under a LEFT-handed declaration still commits FOREHAND", () => {
    const fixture = nonDominantHandSwingFixture();
    const prediction = classifyFixture(fixture, {
      contactMs: fixture.window.peakMs,
      handedness: "left",
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
  });

  it("wheelchair rim propulsion (symmetric bimanual push) abstains via the bimanual gate (E10-F5)", () => {
    // Parity with swing-lab stroke-heuristic-5: both wrists move
    // step-for-step with similar magnitude at wide (rim-width) separation —
    // no single-arm stroke identity is attributable.
    const prediction = classifyFixture(wheelchairRimPushFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "symmetric_bimanual_motion_rim_propulsion_signature",
    );
  });

  it("ambiguous edge-angle contact near the midline abstains at the side margin floor", () => {
    const { sequence, window } = generateSwingSequence({ contactForwardNorm: 0.05 });
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(
      prediction.limitingFactors.some((factor) => factor.includes("contact_too_close_to_midline")),
    ).toBe(true);
  });

  it("does NOT claim OVERHEAD from a floating high paddle box the wrist never reached (stroke-heuristic-1 defect)", () => {
    const { sequence, window } = generateSwingSequence();
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.62, 0.05, window.peakMs, 0.7), // far above the shoulder line
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).not.toBe("OVERHEAD");
    expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
  });

  it("abstains instead of committing a low-margin side on a degraded (low-confidence) paddle point", () => {
    const { sequence, window } = generateSwingSequence();
    const contactFrame = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    const shoulders = contactFrame.landmarks.filter((mark) => mark.name.endsWith("shoulder"));
    const midX = (shoulders[0]!.x + shoulders[1]!.x) / 2;
    const shoulderWidth = Math.abs(shoulders[0]!.x - shoulders[1]!.x);
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(midX + 0.3 * shoulderWidth, wrist.y, window.peakMs, 0.05),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("side_margin_within_degraded_abstention_band");
  });

  it("hierarchy invariant: no adversarial fixture yields a committed leaf at confidence ≥ 0.5", () => {
    const fixtures = [
      abortedSwingFixture(),
      walkThroughFixture(),
      staticReachFixture(),
      wheelchairDegenerateTorsoFixture(),
    ];
    for (const fixture of fixtures) {
      const prediction = classifyFixture(fixture);
      const committedLeaf = prediction.leaf !== null && prediction.leaf !== "UNKNOWN";
      expect(
        committedLeaf && prediction.confidence >= 0.5,
        `${fixture.id} produced confident leaf ${prediction.leaf}`,
      ).toBe(false);
    }
  });
});

describe("hip-independent in-window overhead corroboration", () => {
  function overheadInput(handedness: "right" | "left" = "right") {
    const swing = generateSwingSequence({ contactHeightRatio: 1.2, handed: handedness });
    return {
      sequence: swing.sequence,
      window: swing.window,
      contactMs: swing.window.peakMs,
      handedness,
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    };
  }

  it.each(["wrist", "paddle"] as const)(
    "F20-F2 abstains on a %s contact even when the in-window torso median is compressed",
    (source) => {
      const fixture = torsoCollapseBoundaryOverheadFixture();
      const reference = fixture.sequence.frames.find(
        (frame) => frame.timestampMs === fixture.window.peakMs,
      )!;
      const wrist = reference.landmarks.find((mark) => mark.name === "right_wrist")!;
      const overrides = {
        contactMs: fixture.window.peakMs,
        paddle:
          source === "paddle"
            ? [{ timestampMs: fixture.window.peakMs, center: wrist, confidence: 0.9 }]
            : null,
      };
      const prediction = classifyFixture(fixture, overrides);
      expect(prediction.label).toBe("UNKNOWN");
      expect(prediction.leaf).toBe("UNKNOWN");
      expect(prediction.confidence).toBe(0.2);
      expect(prediction.limitingFactors).toContain("overhead_requires_independent_arm_raise");
      expect(prediction.limitingFactors).not.toContain(
        "overhead_decision_flips_under_median_torso_normalization",
      );
      const bounded = {
        ...fixture.sequence,
        frames: fixture.sequence.frames.filter(
          (frame) =>
            frame.timestampMs >= fixture.window.startMs &&
            frame.timestampMs <= fixture.window.endMs,
        ),
      };
      expect(classifyFixture(fixture, { ...overrides, sequence: bounded })).toEqual(prediction);
      expect(
        classifyFixture(fixture, {
          ...overrides,
          legacyFrames: toLegacyPoseFrames(fixture.sequence),
        }),
      ).toEqual(prediction);
    },
  );

  it("preserves the honest-torso F20-F2 shoulder-volley control as FOREHAND", () => {
    const fixture = torsoHonestShoulderVolleyFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.leaf).toBeNull();
    expect(prediction.taxonomyDepth).toBe(2);
  });

  it.each(["missing", "low_visibility"] as const)(
    "does not manufacture independent arm corroboration from %s elbows",
    (measurement) => {
      const input = overheadInput();
      const prediction = classifyStroke({
        ...input,
        sequence: {
          ...input.sequence,
          frames: input.sequence.frames.map((frame) => ({
            ...frame,
            landmarks: frame.landmarks
              .filter((mark) => measurement !== "missing" || mark.name !== "right_elbow")
              .map((mark) => (mark.name === "right_elbow" ? { ...mark, visibility: 0.49 } : mark)),
          })),
        },
      });
      expect(prediction.label).toBe("UNKNOWN");
      expect(prediction.limitingFactors).toContain("overhead_requires_independent_arm_raise");
    },
  );

  it.each([1, 2])("requires the existing two raised-arm frames (%i measured)", (count) => {
    const input = overheadInput();
    const raised = input.sequence.frames.filter((frame) => {
      if (Math.abs(frame.timestampMs - input.contactMs) > 150) return false;
      const shoulder = frame.landmarks.find((mark) => mark.name === "right_shoulder")!;
      const elbow = frame.landmarks.find((mark) => mark.name === "right_elbow")!;
      const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
      return elbow.y < shoulder.y && wrist.y < shoulder.y;
    });
    const measured = new Set(raised.slice(0, count).map((frame) => frame.timestampMs));
    const prediction = classifyStroke({
      ...input,
      sequence: {
        ...input.sequence,
        frames: input.sequence.frames.map((frame) => ({
          ...frame,
          landmarks: frame.landmarks.map((mark) =>
            mark.name === "right_elbow" && !measured.has(frame.timestampMs)
              ? { ...mark, visibility: 0.49 }
              : mark,
          ),
        })),
      },
    });
    expect(prediction.label).toBe(count < 2 ? "UNKNOWN" : "OVERHEAD");
    expect(prediction.limitingFactors.includes("overhead_requires_independent_arm_raise")).toBe(
      count < 2,
    );
  });

  it.each(["right", "left"] as const)(
    "preserves a measured %s-arm overhead under horizontal mirroring and supported framing scales",
    (handedness) => {
      const input = overheadInput(handedness);
      for (const scale of [0.75, 1, 1.1]) {
        for (const mirrored of [false, true]) {
          const prediction = classifyStroke({
            ...input,
            sequence: {
              ...input.sequence,
              frames: input.sequence.frames.map((frame) => ({
                ...frame,
                landmarks: frame.landmarks.map((mark) => ({
                  ...mark,
                  x: 0.5 + (mirrored ? -1 : 1) * scale * (mark.x - 0.5),
                  y: 0.5 + scale * (mark.y - 0.5),
                })),
              })),
            },
          });
          expect(prediction.label, JSON.stringify({ scale, mirrored })).toBe("OVERHEAD");
          expect(prediction.leaf).toBe("OVERHEAD");
          expect(prediction.taxonomyDepth).toBe(1);
        }
      }
    },
  );

  it.each(["before", "after"] as const)(
    "cannot borrow raised arms from %s the isolated F20-F2 window",
    (side) => {
      const fixture = torsoCollapseBoundaryOverheadFixture();
      const contactMs = fixture.window.peakMs;
      const window = {
        startMs: contactMs - (side === "before" ? 90 : 210),
        endMs: contactMs + (side === "before" ? 210 : 90),
      };
      const sequence = {
        ...fixture.sequence,
        frames: fixture.sequence.frames.filter(
          (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
        ),
      };
      const prediction = classifyFixture(fixture, { sequence, window, contactMs });
      expect(prediction.label).toBe("UNKNOWN");
      expect(prediction.limitingFactors).toContain("overhead_requires_independent_arm_raise");
      const contaminated = {
        ...fixture.sequence,
        frames: fixture.sequence.frames.map((frame) => {
          const outside =
            side === "before"
              ? frame.timestampMs < window.startMs
              : frame.timestampMs > window.endMs;
          if (!outside) return frame;
          const shoulder = frame.landmarks.find((mark) => mark.name === "right_shoulder")!;
          return {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "right_elbow" ? { ...mark, y: 2 * shoulder.y - mark.y } : mark,
            ),
          };
        }),
      };
      expect(classifyFixture(fixture, { window, contactMs })).toEqual(prediction);
      expect(classifyFixture(fixture, { sequence: contaminated, window, contactMs })).toEqual(
        prediction,
      );
      expect(
        classifyFixture(fixture, {
          sequence: contaminated,
          window,
          contactMs,
          legacyFrames: toLegacyPoseFrames(contaminated),
        }),
      ).toEqual(prediction);
    },
  );
});

describe("classifyStroke lite red-team coverage guards (real strokes must survive)", () => {
  it("a legitimate seated (wheelchair) forehand still classifies to a side", () => {
    const prediction = classifyFixture(wheelchairSeatedStrokeFixture());
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.limitingFactors).not.toContain(
      "torso_extent_degenerate_normalization_unreliable",
    );
  });

  it("a genuine two-handed backhand is NOT rejected by the symmetric-bimanual gate", () => {
    // Both wrists share one grip and move with full synchrony — exactly
    // like a rim push — but the inter-wrist separation stays small (≈0.27
    // shoulder-widths), below the gate's wide-grip floor.
    const fixture = twoHandedBackhandFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.limitingFactors).not.toContain(
      "symmetric_bimanual_motion_rim_propulsion_signature",
    );
  });

  it("a genuine swing with no paddle track (mobile reality) still commits a side", () => {
    const { sequence, window } = generateSwingSequence();
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
  });
});

describe.each(["before", "after"] as const)("window isolation (%s adjacent swing)", (side) => {
  type StrokeInput = Parameters<typeof classifyStroke>[0];
  type Frame = StrokeInput["sequence"]["frames"][number];

  function isolatedInput(): StrokeInput {
    const { sequence } = generateSwingSequence();
    return {
      sequence: {
        ...sequence,
        frames: Array.from({ length: 5 }, (_, index) => ({
          ...sequence.frames[0]!,
          frameIndex: index,
          timestampMs: 1000 + index * 20,
          landmarks: [
            { name: "left_shoulder", x: 0.4, y: 0.4, visibility: 0.9 },
            { name: "right_shoulder", x: 0.6, y: 0.4, visibility: 0.9 },
            { name: "left_hip", x: 0.42, y: 0.6, visibility: 0.9 },
            { name: "right_hip", x: 0.58, y: 0.6, visibility: 0.9 },
            { name: "left_elbow", x: 0.35, y: 0.48, visibility: 0.9 },
            { name: "right_elbow", x: 0.68, y: 0.45, visibility: 0.9 },
            { name: "left_wrist", x: 0.3, y: 0.55, visibility: 0.9 },
            { name: "right_wrist", x: 0.7 + index * 0.025, y: 0.55, visibility: 0.9 },
          ],
        })),
      },
      window: { startMs: 1000, endMs: 1080 },
      contactMs: 1040,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    };
  }

  function withAdjacentSwing(
    input: StrokeInput,
    transform: (frame: Frame, index: number) => Frame,
    offsets = Array.from({ length: 11 }, (_, index) => 50 + index * 14),
  ): StrokeInput {
    const edge = input.sequence.frames[side === "before" ? 0 : input.sequence.frames.length - 1]!;
    const adjacent = offsets.map((offset, index) =>
      transform(
        {
          ...edge,
          timestampMs: input.contactMs! + (side === "before" ? -offset : offset),
        },
        index,
      ),
    );
    expect(
      adjacent.every(
        (frame) =>
          frame.timestampMs < input.window.startMs || frame.timestampMs > input.window.endMs,
      ),
    ).toBe(true);
    return {
      ...input,
      sequence: {
        ...input.sequence,
        frames: [...input.sequence.frames, ...adjacent]
          .sort((a, b) => a.timestampMs - b.timestampMs)
          .map((frame, frameIndex) => ({ ...frame, frameIndex })),
      },
    };
  }

  function expectIsolated(input: StrokeInput, contaminated: StrokeInput) {
    const expected = classifyStroke(input);
    expect(classifyStroke(contaminated)).toEqual(expected);
    expect(
      classifyStroke({
        ...contaminated,
        legacyFrames: toLegacyPoseFrames(contaminated.sequence),
      }),
    ).toEqual(expected);
  }

  it("does not use an adjacent torso extent as the current window's median", () => {
    const input = isolatedInput();
    const contaminated = withAdjacentSwing(input, (frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name.endsWith("_hip") ? { ...mark, y: 0.9 } : mark,
      ),
    }));
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expectIsolated(input, contaminated);
  });

  it("does not let an adjacent torso median hide a measured in-window collapse", () => {
    const input = isolatedInput();
    input.sequence = {
      ...input.sequence,
      frames: input.sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          frame.timestampMs === input.contactMs && mark.name.endsWith("_hip")
            ? { ...mark, y: 0.48 }
            : mark,
        ),
      })),
    };
    const contaminated = withAdjacentSwing(input, (frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name.endsWith("_hip") ? { ...mark, y: 0.5 } : mark,
      ),
    }));
    expect(classifyStroke(input).limitingFactors).toContain(
      "torso_extent_collapsed_vs_sequence_median",
    );
    expectIsolated(input, contaminated);
  });

  it("does not choose the wrist carrying a different, adjacent swing", () => {
    const input = isolatedInput();
    const contaminated = withAdjacentSwing(input, (frame, index) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name === "left_wrist" ? { ...mark, x: index % 2 === 0 ? 0.15 : 0.45 } : mark,
      ),
    }));
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expectIsolated(input, contaminated);
  });

  it("cannot borrow rival-wrist visibility from the adjacent swing", () => {
    const input = isolatedInput();
    input.sequence = {
      ...input.sequence,
      frames: input.sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "left_wrist" ? { ...mark, visibility: 0.24 } : mark,
        ),
      })),
    };
    const contaminated = withAdjacentSwing(input, (frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name === "left_wrist" ? { ...mark, visibility: 0.9 } : mark,
      ),
    }));
    expect(classifyStroke(input).label).toBe("UNKNOWN");
    expect(classifyStroke(input).limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
    expectIsolated(input, contaminated);
  });

  it("does not attribute adjacent synchronized bimanual steps to the current swing", () => {
    const input = isolatedInput();
    const contaminated = withAdjacentSwing(input, (frame, index) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name.endsWith("_wrist") ? { ...mark, y: 0.45 + (index % 2) * 0.2 } : mark,
      ),
    }));
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expectIsolated(input, contaminated);
  });

  it("bounds the arm-length median even in the helper's wider 300ms neighborhood", () => {
    const input = isolatedInput();
    input.paddle = [{ timestampMs: 1040, center: { x: 0.45, y: 0.55 }, confidence: 0.9 }];
    const contaminated = withAdjacentSwing(
      input,
      (frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "right_elbow" ? { ...mark, x: 0.95, y: 0.9 } : mark,
        ),
      }),
      Array.from({ length: 11 }, (_, index) => 210 + index * 8),
    );
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expect(classifyStroke(input).limitingFactors).toContain("paddle_point_implausible_used_wrist");
    expectIsolated(input, contaminated);
  });

  it("does not use adjacent raises to turn a degraded mid-body point into an overhead", () => {
    const input = isolatedInput();
    input.paddle = [{ timestampMs: 1040, center: { x: 0.75, y: 0.55 }, confidence: 0.1 }];
    const contaminated = withAdjacentSwing(
      input,
      (frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "right_wrist"
            ? { ...mark, y: 0.25 }
            : mark.name === "right_elbow"
              ? { ...mark, y: 0.3 }
              : mark,
        ),
      }),
      Array.from({ length: 11 }, (_, index) => 50 + index * 8),
    );
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expect(classifyStroke(input).confidence).toBeLessThanOrEqual(0.6);
    expectIsolated(input, contaminated);
  });

  it("cannot borrow a second visible raised frame to corroborate a partial overhead window", () => {
    const input = isolatedInput();
    input.sequence = {
      ...input.sequence,
      frames: input.sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "right_wrist" && frame.timestampMs === input.contactMs
            ? { ...mark, y: 0.25 }
            : mark.name === "right_wrist" || mark.name === "right_elbow"
              ? { ...mark, visibility: 0.49 }
              : mark,
        ),
      })),
    };
    input.paddle = [{ timestampMs: 1040, center: { x: 0.75, y: 0.25 }, confidence: 0.1 }];
    const contaminated = withAdjacentSwing(
      input,
      (frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "right_wrist"
            ? { ...mark, y: 0.25, visibility: 0.9 }
            : mark.name === "right_elbow"
              ? { ...mark, y: 0.3, visibility: 0.9 }
              : mark,
        ),
      }),
      Array.from({ length: 11 }, (_, index) => 50 + index * 8),
    );
    expect(classifyStroke(input).label).toBe("UNKNOWN");
    expect(classifyStroke(input).limitingFactors).toContain(
      "contact_point_contradicted_by_skeletal_window",
    );
    expectIsolated(input, contaminated);
  });

  it("does not let the adjacent swing's facing consensus mirror the current side", () => {
    const input = isolatedInput();
    const contaminated = withAdjacentSwing(input, (frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name === "left_shoulder"
          ? { ...mark, x: 0.6 }
          : mark.name === "right_shoulder"
            ? { ...mark, x: 0.4 }
            : mark,
      ),
    }));
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expectIsolated(input, contaminated);
  });

  it("prefers a measured in-window paddle observation over a closer adjacent observation", () => {
    const input = isolatedInput();
    input.contactMs = side === "before" ? input.window.startMs : input.window.endMs;
    input.sequence = {
      ...input.sequence,
      frames: input.sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "right_wrist" ? { ...mark, x: mark.x - 0.1 } : mark,
        ),
      })),
    };
    input.paddle = [{ timestampMs: 1040, center: { x: 0.8, y: 0.55 }, confidence: 0.9 }];
    const contaminated = {
      ...input,
      paddle: [
        ...input.paddle,
        {
          timestampMs: input.contactMs + (side === "before" ? -1 : 1),
          center: { x: 0.5, y: 0.55 },
          confidence: 0.9,
        },
      ],
    };
    expect(classifyStroke(input).label).toBe("FOREHAND");
    expect(classifyStroke(input).contactPointSource).toBe("paddle");
    expectIsolated(input, contaminated);
  });
});
