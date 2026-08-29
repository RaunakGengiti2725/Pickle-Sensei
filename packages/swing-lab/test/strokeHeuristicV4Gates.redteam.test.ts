import { describe, expect, it } from "vitest";
import {
  clusteredDropoutLoopSwingFixture,
  crouchDinkFixture,
  occludedRivalGenuineForehandFixture,
  sparseRivalWrongArmFixture,
  speedDropoutDuringSwingFixture,
  torsoCollapseBoundaryOverheadFixture,
  torsoHonestShoulderVolleyFixture,
  type AdversarialStrokeFixture,
} from "@pickle/evaluation";
import { classifyStroke as classifyStrokeLiteV3 } from "@pickle/vision-geometry";
import { classifyStroke } from "../src/index.js";
import type { StrokePrediction } from "../src/index.js";

/**
 * RED-TEAM suite for the stroke-heuristic-4 absence-of-measurement gates
 * (wave-f f20-rt-stroke-hardened). Attacks the NEW e03 gates on the real
 * classifyStroke path: partially-measured rival wrists, boundary-parked
 * torso collapse, clustered measurement dropouts, and one-sided speed
 * slices.
 *
 * Two kinds of tests, explicitly separated (same contract as the e10
 * suite):
 *
 *  1. OPEN FINDINGS (F20-F1…F2) — measured confidently-wrong outputs of
 *     stroke-heuristic-4, PINNED as characterization tests with ground
 *     truth and forensic root cause. These assert the CURRENT WRONG
 *     behavior on purpose: fixing the classifier must flip them
 *     consciously (delete the pin, keep the fixture, invert the
 *     assertion). Documentation, not endorsement.
 *
 *  2. COVERAGE FINDINGS (F20-F3…F6) — measured FALSE ABSTENTIONS on
 *     genuine strokes, pinned the same way. Each is a case that SHOULD
 *     commit but abstains; F20-F4 is a measured coverage REGRESSION vs
 *     stroke-heuristic-3 (the vision-geometry lite port, still v3,
 *     commits it correctly).
 *
 * Root-cause references are to packages/swing-lab/src/strokeHeuristic.ts.
 * NOTE: vision-geometry/strokeHeuristicLite.ts is still the v3 port — the
 * v4 gates were never ported, so the two copies have DIVERGED (the e10
 * suite's "byte-equivalent port" premise no longer holds).
 */

function classifyFixture(
  fixture: AdversarialStrokeFixture,
  overrides: Partial<Parameters<typeof classifyStroke>[0]> = {},
): StrokePrediction {
  return classifyStroke({
    sequence: fixture.sequence,
    window: { startMs: fixture.window.startMs, endMs: fixture.window.endMs },
    contactMs: fixture.window.peakMs,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: fixture.wristSpeeds,
    ...overrides,
  });
}

describe("stroke-heuristic-4 gate OPEN FINDINGS (pinned confidently-wrong outputs)", () => {
  it("F20-F1: a rival wrist measured in only 2 frames disarms the attribution gate and the wrong arm commits BACKHAND at 0.76", () => {
    // Ground truth: a genuine RIGHT-arm forehand; the striking wrist was
    // glimpsed in 2 adjacent frames (travel 0.02u) while the non-striking
    // left counterbalance arm was measured everywhere (travel ~0.09u).
    // ROOT CAUSE: the v4 attribution gate fires only at rivalMeasuredFrames
    // === 0; 1-2 glimpsed frames re-arm the "this wrist moved more"
    // comparison even though the rival's travel is still dominated by
    // ABSENCE (its unmeasured mid-swing arc contributes zero path length).
    // e03 declined raising the floor above 0 as bench-fitting (sasebo
    // @52434 commits correctly with rival at 1 frame) — this fixture
    // realizes the attack that decision leaves open.
    const prediction = classifyFixture(sparseRivalWrongArmFixture());
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.76, 2);
    expect(prediction.limitingFactors).not.toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  it("F20-F2: torso extent parked at 62.5% of the sequence median passes the 0.6 collapse floor and a shoulder-high volley commits OVERHEAD at 0.68", () => {
    // Ground truth: a shoulder-high punch volley (contact 0.22 REAL
    // torso-units above the shoulder line — below the 0.25 overhead line).
    // A partial hip occlusion compresses the measured extent to 0.125u
    // (median 0.20u) across the whole ±150ms corroboration window, so the
    // contact point reads 0.36 torso-units high AND every raise-window
    // frame inflates identically — point and skeleton "agree" on OVERHEAD.
    // ROOT CAUSE: TORSO_COLLAPSE_MEDIAN_RATIO is a binary 0.6 floor; in the
    // 0.6-1.0 band the normalization error (up to 1.67x) flows silently
    // into every torso-normalized ratio with no confidence degradation,
    // and scanRaiseWindow normalizes each frame by the SAME collapsed
    // extent, so the "independent" skeletal corroboration inherits the
    // identical bias instead of contradicting it.
    const prediction = classifyFixture(torsoCollapseBoundaryOverheadFixture());
    expect(prediction.label).toBe("OVERHEAD");
    expect(prediction.leaf).toBe("OVERHEAD");
    expect(prediction.confidence).toBeCloseTo(0.68, 2);
    expect(prediction.limitingFactors).not.toContain("torso_extent_collapsed_vs_sequence_median");
  });

  it("F20-F2 counterfactual: the byte-identical motion with an honestly-measured torso commits FOREHAND, not OVERHEAD", () => {
    // Same wrist trajectory, same contact height in image units — only the
    // hips are measured correctly (extent 0.20u). The label flip proves the
    // OVERHEAD above is manufactured by the normalization error alone.
    const prediction = classifyFixture(torsoHonestShoulderVolleyFixture());
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
  });
});

describe("stroke-heuristic-4 gate COVERAGE FINDINGS (pinned false abstentions on genuine strokes)", () => {
  it("F20-F3: a genuine deep-crouch dink abstains on the torso-collapse gate (real crouch reads as occlusion collapse)", () => {
    // Ground truth: FOREHAND dink hit in a deep crouch — the reference
    // frame's REAL torso extent is 0.11u vs the standing sequence median
    // 0.20u (55%). ROOT CAUSE: the v4 relative gate cannot distinguish a
    // genuine postural compression from a transient measurement collapse;
    // any stroke whose reference torso reads <60% of the player's own
    // median (deep crouch, lunge, dive) is unclassifiable by construction.
    // This is the gate's coverage floor.
    const prediction = classifyFixture(crouchDinkFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");
  });

  it("F20-F4: a genuine forehand with the rival arm fully occluded abstains — a measured coverage REGRESSION vs stroke-heuristic-3", () => {
    // Ground truth: an unambiguous right-arm FOREHAND filmed from an angle
    // that keeps the left arm behind the torso for the whole clip (rival
    // wrist: 0 measured frames). ROOT CAUSE: the v4 attribution gate makes
    // one-visible-arm clips unclassifiable even when the visible arm's
    // swing is unambiguous; whole-arm occlusion of the off arm is common
    // (side-on framing), so this is a structural coverage cost of the gate.
    const prediction = classifyFixture(occludedRivalGenuineForehandFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  it("F20-F4 regression proof: the still-v3 vision-geometry lite port commits the same fixture correctly as FOREHAND at 0.8", () => {
    // The lite port never received the v4 gates, so it measures the v3
    // behavior directly: FOREHAND 0.80 on the identical input. (It also
    // documents that the two copies have diverged — the e10 suites'
    // "byte-equivalent port" premise no longer holds.)
    const fixture = occludedRivalGenuineForehandFixture();
    const prediction = classifyStrokeLiteV3({
      sequence: fixture.sequence,
      window: { startMs: fixture.window.startMs, endMs: fixture.window.endMs },
      contactMs: fixture.window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: fixture.wristSpeeds,
    });
    expect(prediction.classifierVersion).toContain("stroke-heuristic-3");
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
  });

  it("F20-F5: a one-sided 3-sample speed slice reads a genuine fast swing as 'no swing energy'", () => {
    // Ground truth: FOREHAND drive; the speed estimator dropped out for the
    // swing itself, leaving only 3 pre-swing 0.1 u/s samples inside the
    // window (the pose frames show a full-speed stroke). ROOT CAUSE: the v4
    // MIN_WINDOW_SPEED_SAMPLES floor counts samples but not COVERAGE — 3
    // samples clustered at the window edge are treated as representative of
    // the whole window, so a mid-swing dropout converts "absence of
    // measurement" back into "evidence of no energy", the exact contract
    // the v4 fix was written to enforce.
    const prediction = classifyFixture(speedDropoutDuringSwingFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_swing_energy_in_window");
  });

  it("F20-F6: clustered mid-swing wrist dropout defeats the MIN_TRAVEL_SAMPLE_FRAMES contract and a loop swing reads as stillness", () => {
    // Ground truth: FOREHAND loop swing whose mid-swing frames all dropped;
    // the wrist is measured in 3 ready-stance frames and 3 follow-through
    // frames that returned near the start (6 measured frames, path ~0.01u).
    // ROOT CAUSE: MIN_TRAVEL_SAMPLE_FRAMES counts measured frames but not
    // their TEMPORAL COVERAGE of the ±200ms span; two still clusters
    // bracketing an unmeasured arc satisfy the floor while the measured
    // path length misses the entire swing ("sparse visibility must never
    // masquerade as stillness" holds for uniform sparsity, not clustered
    // dropout).
    const prediction = classifyFixture(clusteredDropoutLoopSwingFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_swing_motion_near_reference");
  });
});

describe("f20 fixtures never silently change shape (umbrella pins)", () => {
  it("the two confidently-wrong pins commit; the four coverage pins abstain", () => {
    // If any of these flips, a classifier change touched the v4 gate
    // surface — re-run the F20 forensics before accepting it.
    const committing = [sparseRivalWrongArmFixture(), torsoCollapseBoundaryOverheadFixture()];
    for (const fixture of committing) {
      const prediction = classifyFixture(fixture);
      expect(prediction.label, fixture.id).not.toBe("UNKNOWN");
      expect(prediction.confidence, fixture.id).toBeGreaterThanOrEqual(0.6);
    }
    const abstaining = [
      crouchDinkFixture(),
      occludedRivalGenuineForehandFixture(),
      speedDropoutDuringSwingFixture(),
      clusteredDropoutLoopSwingFixture(),
    ];
    for (const fixture of abstaining) {
      const prediction = classifyFixture(fixture);
      expect(prediction.label, fixture.id).toBe("UNKNOWN");
    }
  });
});
