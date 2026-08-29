import { describe, expect, it } from "vitest";
import {
  abortedSwingFixture,
  generateSwingSequence,
  staticReachFixture,
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
