import { describe, expect, it } from "vitest";
import {
  energeticAbortedSwingFixture,
  facingFlipAtContactFixture,
  nonDominantHandSwingFixture,
  practiceShadowSwingFixture,
  profileViewCollapsedShouldersFixture,
  twoHandedBackhandFixture,
  wheelchairRimPushFixture,
  type AdversarialStrokeFixture,
} from "@pickle/evaluation";
import { classifyStroke } from "../src/index.js";
import type { StrokePrediction } from "../src/index.js";

/**
 * RED-TEAM suite for ambiguous motions (wave-e e10-rt-stroke-ambiguous).
 * Attacks the real classifyStroke path with practice swings, aborted
 * strokes, non-dominant-hand play, wheelchair propulsion, and degenerate
 * camera-facing geometry.
 *
 * Two kinds of tests, explicitly separated:
 *
 *  1. OPEN FINDINGS (E10-F1…F4; F5 resolved) — measured confidently-wrong outputs of
 *     stroke-heuristic-3, PINNED as characterization tests. Each records
 *     the ground truth and the forensic root cause. These tests assert the
 *     CURRENT WRONG behavior on purpose: fixing the classifier must flip
 *     them consciously (delete the pin, keep the fixture, invert the
 *     assertion). They are documentation, not endorsement.
 *
 *  2. DEFENSES THAT HELD — regression guards for gates that already stop
 *     an attack (must keep passing forever).
 *
 * Root-cause references are to packages/swing-lab/src/strokeHeuristic.ts
 * (and its byte-equivalent port vision-geometry/strokeHeuristicLite.ts —
 * both copies share every finding below).
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

describe("classifyStroke ambiguous-motion OPEN FINDINGS (pinned confidently-wrong outputs)", () => {
  it("E10-F1 RESOLVED (stroke-heuristic-5): ball-less practice swing no longer reaches the 0.8 ceiling — contact-evidence cap applies", () => {
    // Ground truth: NOT a stroke — no ball, no contact; the reference is the
    // motion peak. Was pinned confidently-wrong at 0.8: the classifier now
    // treats an event-peak reference with no plausible paddle point as
    // degraded trust (no measurement ties the motion to a ball contact), so
    // the commitment is capped at the degraded ceiling and flagged. The
    // kinematics alone are indistinguishable from a genuine no-paddle-track
    // swing, so the side geometry is still reported — at capped confidence.
    const prediction = classifyFixture(practiceShadowSwingFixture());
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeLessThanOrEqual(0.6);
    expect(prediction.limitingFactors).toContain("reference_is_event_peak_not_contact");
    expect(prediction.limitingFactors).toContain("no_contact_evidence_confidence_capped");
  });

  it("E10-F2 RESOLVED (stroke-heuristic-5): the handedness cross-check abstains on a left-hand swing under a right-handed declaration", () => {
    // Ground truth: a left-hand forehand. Originally pinned as a mirrored
    // BACKHAND at the 0.8 ceiling: the side decision used ONLY declared
    // handedness and never cross-checked the measured dominant-motion wrist.
    // stroke-heuristic-5 treats the declaration as context, not evidence:
    // a decisive off-declaration dominant-motion wrist abstains.
    const prediction = classifyFixture(nonDominantHandSwingFixture(), {
      contactMs: nonDominantHandSwingFixture().window.peakMs,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "declared_handedness_contradicted_by_dominant_motion_wrist",
    );
  });

  it("E10-F2 positive control: the same left-hand swing under a LEFT-handed declaration still commits FOREHAND", () => {
    const fixture = nonDominantHandSwingFixture();
    const prediction = classifyFixture(fixture, {
      contactMs: fixture.window.peakMs,
      handedness: "left",
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
    expect(prediction.limitingFactors).not.toContain(
      "declared_handedness_contradicted_by_dominant_motion_wrist",
    );
  });

  it("E10-F3 RESOLVED (stroke-heuristic-4): near-profile view now abstains via the rival-wrist attribution gate", () => {
    // Ground truth: side not measurable (image-plane shoulder width 0.005u).
    // Originally pinned as a confidently-wrong FOREHAND: shoulderWidth was
    // floored at 0.02 and used as the normalization base with no degeneracy
    // gate, so a noise-scale 0.0075u offset cleared SIDE_MARGIN_FLOOR.
    // stroke-heuristic-4's absence-of-measurement gate now abstains because
    // the rival wrist has zero measured frames near the reference, so
    // dominant-wrist attribution is unverifiable. Note the shoulder-width
    // degeneracy itself is still ungated; only this fixture's path is closed.
    const fixture = profileViewCollapsedShouldersFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  it("E10-F4 RESOLVED (stroke-heuristic-5): transient shoulder crossing at contact no longer mirrors the side — facing consensus recovers FOREHAND", () => {
    // Ground truth: FOREHAND (rear view in every frame except the contact
    // instant, where torso rotation crosses the shoulders past profile).
    // Originally pinned as a confidently-wrong BACKHAND 0.80: the facing
    // sign came from the shoulder x-order of the single nearest frame.
    // stroke-heuristic-5 decides facing by the multi-frame shoulder x-order
    // consensus over ±200ms (near-profile frames cannot vote), so the one
    // crossed frame is outvoted by the rear-view majority and the override
    // is recorded.
    const fixture = facingFlipAtContactFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(
      prediction.evidence.some((entry) => entry.includes("rear-ish view (facing consensus")),
    ).toBe(true);
    expect(prediction.limitingFactors).toContain(
      "facing_sign_at_reference_overridden_by_consensus",
    );
  });

  it("E10-F5 RESOLVED (stroke-heuristic-5): wheelchair rim propulsion abstains via the symmetric-bimanual gate", () => {
    // Ground truth: NOT a stroke — symmetric bimanual wheel push between
    // shots. Originally pinned as a confidently-wrong FOREHAND at 0.8: the
    // push (0.9 u/s, large wrist travel) passed both non-stroke gates,
    // which only tested energy and travel of the single dominant wrist.
    // stroke-heuristic-5's symmetric-bimanual gate now abstains: both
    // wrists move step-for-step with similar magnitude at wide (rim-width)
    // separation, so no single-arm stroke identity is attributable.
    const prediction = classifyFixture(wheelchairRimPushFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "symmetric_bimanual_motion_rim_propulsion_signature",
    );
  });
});

describe("classifyStroke ambiguous-motion defenses that held (must keep holding)", () => {
  it("genuine two-handed backhand is NOT rejected by the symmetric-bimanual gate", () => {
    // Control for the E10-F5 fix: both wrists share one grip and move with
    // full synchrony and identical magnitude — exactly like a rim push —
    // but the inter-wrist separation stays small (≈0.27 shoulder-widths),
    // below the gate's wide-grip floor. The stroke must still commit.
    const fixture = twoHandedBackhandFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
    expect(prediction.limitingFactors).not.toContain(
      "symmetric_bimanual_motion_rim_propulsion_signature",
    );
  });

  it("energetic aborted swing (fast pull, then checked) abstains on the travel gate", () => {
    // The window-wide speed peak (1.0 u/s) defeats the energy gate. Under
    // stroke-heuristic-3 the ±200ms travel gate abstained
    // (no_swing_motion_near_reference); stroke-heuristic-4's rival-wrist
    // attribution gate now fires first on this fixture (the rival wrist has
    // zero measured frames), so the abstention holds via a different gate.
    const prediction = classifyFixture(energeticAbortedSwingFixture());
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  // The former open-finding umbrella pin is gone: F1 (practiceShadowSwing),
  // F2 (nonDominantHandSwing), F3 (profileViewCollapsedShoulders), F4
  // (facingFlipAtContact), and F5 (wheelchairRimPush) are all resolved
  // (stroke-heuristic-4/5) and each is covered by its own regression test
  // above. Re-run the E10 forensics if any of those regressions change shape.
});
