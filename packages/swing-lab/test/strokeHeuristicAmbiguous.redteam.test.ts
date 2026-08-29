import { describe, expect, it } from "vitest";
import {
  energeticAbortedSwingFixture,
  facingFlipAtContactFixture,
  nonDominantHandSwingFixture,
  practiceShadowSwingFixture,
  profileViewCollapsedShouldersFixture,
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
 *  1. OPEN FINDINGS (E10-F1…F5) — measured confidently-wrong outputs of
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
  it("E10-F1: ball-less practice swing commits FOREHAND at the 0.8 confidence ceiling", () => {
    // Ground truth: NOT a stroke — no ball, no contact; the reference is the
    // motion peak. ROOT CAUSE: `reference_is_event_peak_not_contact` is
    // recorded as a limiting factor but never gates commitment or caps the
    // L2 confidence formula; nothing in the hierarchy requires any
    // ball/contact evidence to assert a stroke identity.
    const prediction = classifyFixture(practiceShadowSwingFixture());
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
    expect(prediction.limitingFactors).toContain("reference_is_event_peak_not_contact");
  });

  it("E10-F2: left-hand swing under a right-handed declaration commits mirrored BACKHAND at 0.8", () => {
    // Ground truth: a left-hand forehand. ROOT CAUSE: the side decision uses
    // ONLY declared handedness; the measured dominant-MOTION wrist side
    // (left, computed by dominantWristInfo and used for every other
    // judgement) contradicts the declaration and is never cross-checked.
    const prediction = classifyFixture(nonDominantHandSwingFixture(), {
      contactMs: nonDominantHandSwingFixture().window.peakMs,
    });
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
  });

  it("E10-F3 RESOLVED (stroke-heuristic-4): near-profile view now abstains via the rival-wrist attribution gate", () => {
    // Ground truth: side not measurable (image-plane shoulder width 0.005u).
    // Originally pinned as a confidently-wrong FOREHAND: shoulderWidth was
    // floored at 0.02 and used as the normalization base with no degeneracy
    // gate, so a noise-scale 0.0075u offset cleared SIDE_MARGIN_FLOOR.
    // stroke-heuristic-4's absence-of-measurement gate now abstains because
    // the rival wrist has zero measured frames near the reference, so
    // dominant-wrist attribution is unverifiable. The shoulder-width
    // degeneracy itself is gated at the side decision (wave-f f05,
    // SHOULDER_MIN_SEPARATION); this fixture never reaches it because the
    // rival-wrist gate fires first — the gate's own regression fixtures
    // (measured rival wrist) live in strokeHeuristicV4Gates.test.ts.
    const fixture = profileViewCollapsedShouldersFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
  });

  it("E10-F4: single-frame shoulder crossing flips a genuine forehand to BACKHAND at 0.8", () => {
    // Ground truth: FOREHAND (rear view in every frame except the contact
    // instant, where torso rotation crosses the shoulders past profile).
    // ROOT CAUSE: the facing sign is derived from the shoulder x-order of
    // the single nearest frame; mid-swing rotation at that instant inverts
    // it, mirroring the side decision at full confidence. No multi-frame
    // facing consensus, no small-shoulder-separation guard.
    const fixture = facingFlipAtContactFixture();
    const prediction = classifyFixture(fixture, { contactMs: fixture.window.peakMs });
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
    expect(prediction.evidence).toContain("front-ish view (shoulder order)");
  });

  it("E10-F5: wheelchair rim propulsion commits FOREHAND at 0.8", () => {
    // Ground truth: NOT a stroke — symmetric bimanual wheel push between
    // shots. ROOT CAUSE: the push (0.9 u/s, large wrist travel) passes both
    // non-stroke gates, which only test energy and travel of the single
    // dominant wrist; there is no discriminator for symmetric two-arm
    // motion, the signature of rim propulsion.
    const prediction = classifyFixture(wheelchairRimPushFixture());
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.taxonomyDepth).toBe(2);
    expect(prediction.confidence).toBeCloseTo(0.8, 5);
  });
});

describe("classifyStroke ambiguous-motion defenses that held (must keep holding)", () => {
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

  it("open-finding fixtures never silently change shape: the four still-open pins commit a leaf-less depth-2 side", () => {
    // Umbrella pin: if any fixture starts abstaining (or committing a leaf),
    // a classifier change touched this surface — re-run the E10 forensics.
    // F3 (profileViewCollapsedShoulders) was resolved by stroke-heuristic-4
    // and is covered by its own abstention regression test above.
    const fixtures = [
      practiceShadowSwingFixture(),
      nonDominantHandSwingFixture(),
      facingFlipAtContactFixture(),
      wheelchairRimPushFixture(),
    ];
    for (const fixture of fixtures) {
      const prediction = classifyFixture(fixture, {
        contactMs: fixture.window.peakMs,
      });
      expect(prediction.taxonomyDepth, fixture.id).toBe(2);
      expect(prediction.leaf, fixture.id).toBeNull();
      expect(prediction.confidence, fixture.id).toBeGreaterThanOrEqual(0.6);
    }
  });
});
