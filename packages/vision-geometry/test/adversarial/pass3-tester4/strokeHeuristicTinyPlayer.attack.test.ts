import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import {
  abortedSwingFixture,
  generateSwingSequence,
  nonDominantHandSwingFixture,
  staticReachFixture,
  twoHandedBackhandFixture,
  walkThroughFixture,
  wheelchairDegenerateTorsoFixture,
  wheelchairRimPushFixture,
  wheelchairSeatedStrokeFixture,
  type AdversarialStrokeFixture,
} from "@pickle/evaluation";
import { classifyStroke, evaluateCaptureQuality } from "../../../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER 4 — S7: every strokeHeuristicLite red-team
 * fixture re-run with landmark coordinates scaled by 0.05 (a tiny, distant
 * player). The abstention invariant must survive normalization: no fixture
 * may commit a leaf at confidence ≥ 0.5.
 *
 * Two scalings are exercised:
 *  - `corner`: x' = 0.05·x, y' = 0.05·y (player collapses toward the origin)
 *  - `center`: x' = 0.5 + 0.05·(x − 0.5) (player shrinks about frame center)
 * and two speed treatments: wrist speeds scaled with the geometry (physically
 * consistent) and left as supplied (inconsistent auxiliary measurement).
 */

const SCALE = 0.05;

type Scaling = "corner" | "center";

function scaleCoordinate(value: number, scaling: Scaling): number {
  return scaling === "corner" ? value * SCALE : 0.5 + (value - 0.5) * SCALE;
}

function scaleSequence(sequence: PoseSequence, scaling: Scaling): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) => ({
        ...mark,
        x: scaleCoordinate(mark.x, scaling),
        y: scaleCoordinate(mark.y, scaling),
      })),
    })),
  };
}

function scaleFixture(
  fixture: AdversarialStrokeFixture,
  scaling: Scaling,
  scaleSpeeds: boolean,
): AdversarialStrokeFixture {
  return {
    ...fixture,
    sequence: scaleSequence(fixture.sequence, scaling),
    wristSpeeds:
      fixture.wristSpeeds && scaleSpeeds
        ? fixture.wristSpeeds.map((sample) => ({ ...sample, value: sample.value * SCALE }))
        : fixture.wristSpeeds,
  };
}

const ADVERSARIAL: ReadonlyArray<{
  build: () => AdversarialStrokeFixture;
  contactAtPeak: boolean;
}> = [
  { build: abortedSwingFixture, contactAtPeak: false },
  { build: walkThroughFixture, contactAtPeak: false },
  { build: staticReachFixture, contactAtPeak: false },
  { build: wheelchairDegenerateTorsoFixture, contactAtPeak: false },
  { build: wheelchairRimPushFixture, contactAtPeak: false },
  { build: nonDominantHandSwingFixture, contactAtPeak: true },
];

function classifyFixture(fixture: AdversarialStrokeFixture, contactAtPeak: boolean) {
  return classifyStroke({
    sequence: fixture.sequence,
    window: { startMs: fixture.window.startMs, endMs: fixture.window.endMs },
    contactMs: contactAtPeak ? fixture.window.peakMs : null,
    eventPeakMs: fixture.window.peakMs,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: fixture.wristSpeeds,
  });
}

function committedConfidently(prediction: ReturnType<typeof classifyStroke>): boolean {
  const committedLeaf = prediction.leaf !== null && prediction.leaf !== "UNKNOWN";
  return committedLeaf && prediction.confidence >= 0.5;
}

describe("S7 red-team fixtures scaled by 0.05 (tiny distant player) still abstain", () => {
  it("precondition: unscaled, every adversarial fixture abstains (the invariant we are stressing)", () => {
    for (const { build, contactAtPeak } of ADVERSARIAL) {
      const fixture = build();
      const prediction = classifyFixture(fixture, contactAtPeak);
      expect(committedConfidently(prediction), fixture.id).toBe(false);
    }
  });

  for (const scaling of ["corner", "center"] as const) {
    for (const scaleSpeeds of [true, false]) {
      it(`scaling=${scaling} speeds=${scaleSpeeds ? "scaled" : "as-supplied"}: no adversarial fixture commits a leaf at confidence ≥ 0.5`, () => {
        for (const { build, contactAtPeak } of ADVERSARIAL) {
          const fixture = scaleFixture(build(), scaling, scaleSpeeds);
          const prediction = classifyFixture(fixture, contactAtPeak);
          expect(Number.isFinite(prediction.confidence), `${fixture.id} confidence`).toBe(true);
          expect(
            committedConfidently(prediction),
            `${fixture.id} (${scaling}) committed ${prediction.leaf} @ ${prediction.confidence}`,
          ).toBe(false);
          expect(prediction.label).toBe("UNKNOWN");
        }
      });
    }
  }

  it("scaled fixtures never commit ANY leaf (not just below 0.5): label is UNKNOWN with a stated limiting factor", () => {
    for (const scaling of ["corner", "center"] as const) {
      for (const { build, contactAtPeak } of ADVERSARIAL) {
        const fixture = scaleFixture(build(), scaling, true);
        const prediction = classifyFixture(fixture, contactAtPeak);
        expect(prediction.leaf === null || prediction.leaf === "UNKNOWN", fixture.id).toBe(true);
        expect(prediction.limitingFactors.length, fixture.id).toBeGreaterThan(0);
      }
    }
  });

  it("evaluateCaptureQuality flags every 0.05-scaled fixture as player_too_small_in_frame (the upstream gate agrees)", () => {
    for (const scaling of ["corner", "center"] as const) {
      for (const { build } of ADVERSARIAL) {
        const fixture = scaleFixture(build(), scaling, true);
        const report = evaluateCaptureQuality(fixture.sequence);
        expect(report.analyzable, fixture.id).toBe(false);
        expect(
          report.reasons.includes("player_too_small_in_frame") ||
            report.reasons.includes("torso_not_measured"),
          `${fixture.id}: ${report.reasons.join(",")}`,
        ).toBe(true);
        expect(Number.isFinite(report.stats.medianTorsoLengthNorm)).toBe(true);
      }
    }
  });

  it("observed (informational): genuine strokes scaled by 0.05 — does the heuristic still commit a side at this size?", () => {
    const outcomes: Record<string, string> = {};
    const seated = scaleFixture(wheelchairSeatedStrokeFixture(), "center", true);
    const seatedPrediction = classifyFixture(seated, false);
    outcomes[seated.id] = `${seatedPrediction.label}@${seatedPrediction.confidence.toFixed(3)}`;
    const twoHanded = scaleFixture(twoHandedBackhandFixture(), "center", true);
    const twoHandedPrediction = classifyFixture(twoHanded, true);
    outcomes[twoHanded.id] =
      `${twoHandedPrediction.label}@${twoHandedPrediction.confidence.toFixed(3)}`;
    const { sequence, window } = generateSwingSequence();
    const scaledSwing = scaleSequence(sequence, "center");
    const swingPrediction = classifyStroke({
      sequence: scaledSwing,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    outcomes["generateSwingSequence"] =
      `${swingPrediction.label}@${swingPrediction.confidence.toFixed(3)}`;
    // Only invariants are asserted: finite confidence, and whatever is
    // committed is committed on the SAME side as the unscaled control
    // (scale must not flip a side). The outcomes map is the evidence record.
    for (const prediction of [seatedPrediction, twoHandedPrediction, swingPrediction]) {
      expect(Number.isFinite(prediction.confidence)).toBe(true);
    }
    const unscaledSwing = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(unscaledSwing.label).toBe("FOREHAND");
    if (swingPrediction.label !== "UNKNOWN") expect(swingPrediction.label).toBe("FOREHAND");
    console.warn(`[S7 tiny-player genuine-stroke outcomes] ${JSON.stringify(outcomes)}`);
  });

  it("degenerate extremes: scale 0 (all landmarks on one point) and scale 1e-9 never commit and never yield NaN confidence", () => {
    for (const factor of [0, 1e-9]) {
      for (const { build, contactAtPeak } of ADVERSARIAL) {
        const base = build();
        const fixture: AdversarialStrokeFixture = {
          ...base,
          sequence: {
            ...base.sequence,
            frames: base.sequence.frames.map((frame) => ({
              ...frame,
              landmarks: frame.landmarks.map((mark) => ({
                ...mark,
                x: mark.x * factor,
                y: mark.y * factor,
              })),
            })),
          },
        };
        const prediction = classifyFixture(fixture, contactAtPeak);
        expect(Number.isFinite(prediction.confidence), `${fixture.id}@${factor}`).toBe(true);
        expect(committedConfidently(prediction), `${fixture.id}@${factor}`).toBe(false);
      }
    }
  });
});
