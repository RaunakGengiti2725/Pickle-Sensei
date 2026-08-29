import { describe, expect, it } from "vitest";
import {
  abortedSwingFixture,
  generateSwingSequence,
  staticReachFixture,
  walkThroughFixture,
  wheelchairDegenerateTorsoFixture,
  wheelchairSeatedStrokeFixture,
  type AdversarialStrokeFixture,
} from "@pickle/evaluation";
import { classifyStroke } from "../src/index.js";
import type { StrokePrediction } from "../src/index.js";

/**
 * RED-TEAM suite for the AUTO DETECT stroke hierarchy (wave-d D11).
 * Adversarial synthetic fixtures (labeled as such in @pickle/evaluation)
 * represent non-strokes and ambiguous motion the trigger could mis-fire on.
 *
 * The contract under attack: L1→L2→L3 degrades gracefully — no fixture may
 * yield a committed LEAF (exact identity, incl. OVERHEAD) without motion
 * evidence of an actual swing, and non-strokes must abstain to UNKNOWN.
 * Coverage guard: genuine strokes (incl. seated/wheelchair kinematics) must
 * still classify — abstention gates may only fire on measured non-motion.
 */

function classifyFixture(
  fixture: AdversarialStrokeFixture,
  overrides: Partial<Parameters<typeof classifyStroke>[0]> = {},
): StrokePrediction {
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

describe("classifyStroke red-team (adversarial non-strokes)", () => {
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

describe("classifyStroke red-team coverage guards (real strokes must survive)", () => {
  it("a legitimate seated (wheelchair) forehand still classifies to a side", () => {
    const prediction = classifyFixture(wheelchairSeatedStrokeFixture());
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.limitingFactors).not.toContain(
      "torso_extent_degenerate_normalization_unreliable",
    );
  });

  it("a genuine fast swing with a measured speed series still commits a side", () => {
    const { sequence, window } = generateSwingSequence();
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: Array.from({ length: 20 }, (_, index) => ({
        timestampMs: window.peakMs - 300 + index * 30,
        value: 1.8,
      })),
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
  });
});
