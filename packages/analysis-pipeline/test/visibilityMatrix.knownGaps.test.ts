import { evaluateCaptureQuality } from "@pickle/vision-geometry";
import { describe, expect, it } from "vitest";
import { evaluatePreAnalysisGate } from "../src/preAnalysisGate.js";
import { runCase, type CaseResult } from "./visibilityMatrix/runner.js";
import { SCENARIOS, buildCase } from "./visibilityMatrix/scenarios.js";

/**
 * KNOWN GAPS reproduced by the player-visibility matrix (Linux replay proxy).
 *
 * Each `it.fails` block states the behaviour the pipeline SHOULD have and is
 * pinned to a scenario id + seed that reproduces the opposite today. When the
 * production behaviour is fixed the block starts failing ("expected test to
 * fail") — flip it to a plain `it` at that point so the fix stays pinned.
 * Nothing here weakens an existing test; the matrix invariants that hold are
 * in visibilityMatrix.test.ts.
 *
 * Plain `it` blocks below are former gaps now closed by the pre-analysis gate
 * (capture-quality reasons + torso-anchor continuity) that the scoring path
 * consults before analyzeCapture: the stream is gated, never scored.
 */

async function run(id: string, seed: number): Promise<CaseResult> {
  const definition = SCENARIOS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`scenario ${id} missing`);
  return runCase(buildCase(definition, seed));
}

describe("player visibility — known gaps (pinned, replayable)", () => {
  it("far camera: a stream the pose-quality gate rejects (torso < 0.08) is gated, never scored with presentation normal", async () => {
    const result = await run("far_camera", 1);
    expect(result.quality.reasons).toContain("player_too_small_in_frame");
    expect(result.preGate.reasons).toContain("person_implausible_scale");
    expect(result.fusion.kind).toBe("gated");
    expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(false);
    expect(result.violations).toEqual([]);
  });

  it("far camera (noiseless): the gated stream never reproduces the clean reference score", async () => {
    const result = await run("far_camera_noiseless", 1);
    expect(result.quality.analyzable).toBe(false);
    expect(result.fusion.kind).toBe("gated");
    expect(result.reference.outcome).toBe("scored");
    expect(result.scoreDelta).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it("exit/re-enter through contact: a > 700 ms tracking gap across the stroke abstains instead of placing contact late and scoring normal", async () => {
    const result = await run("exit_reenter_through_contact", 1);
    expect(result.quality.reasons).toContain("tracking_dropout_gap");
    expect(result.quality.largestGapMs).toBeGreaterThan(700);
    expect(result.preGate.reasons).toContain("tracking_dropout_gap");
    expect(result.fusion.kind).toBe("gated");
    expect(result.fusion.kind).not.toBe("scored");
    expect(result.violations).toEqual([]);
  });

  it.fails(
    "multiple people: the tracked identity jumping to a bystander before contact should abstain, not score 4.5 against a 9.7 reference",
    async () => {
      const result = await run("multi_person_identity_switch", 9);
      expect(result.fusion.kind).not.toBe("scored");
    },
  );

  it.fails(
    "multiple people: per-frame identity flicker should abstain, not report backswing_length_norm 26.5 at confidence 0.95 and score normal",
    async () => {
      const result = await run("multi_person_flicker", 17);
      const backswing = result.metricErrors.find(
        (entry) => entry.metricKey === "backswing_length_norm",
      );
      expect(backswing?.confidence).toBeGreaterThanOrEqual(0.9);
      expect(backswing?.measured).toBeGreaterThan(10);
      expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(
        false,
      );
    },
  );

  it.fails(
    "spectator: a motionless body with ~2 px keypoint jitter should never pass the distinct-stroke check and score normal",
    async () => {
      const result = await run("spectator_static", 62);
      const backswing = result.metricErrors.find(
        (entry) => entry.metricKey === "backswing_length_norm",
      );
      expect(backswing?.measured).toBe(0);
      expect(result.fusion.kind).not.toBe("scored");
    },
  );

  it("occlusion through contact: torso + swinging arm hidden across contact is a torso tracking gap — gated, never scored normal with a shifted contact", async () => {
    const result = await run("occlusion_through_contact", 7);
    expect(result.preGate.reasons).toContain("torso_tracking_gap");
    expect(result.fusion.kind).toBe("gated");
    expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(false);
    expect(result.contactShiftMs).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it.fails(
    "legs missing: contact_height_ratio measured against a fabricated ground line (y = 1) should not carry confidence 0.95",
    async () => {
      const result = await run("legs_missing", 23);
      const contactHeight = result.metricErrors.find(
        (entry) => entry.metricKey === "contact_height_ratio",
      );
      expect(contactHeight?.relDeviation ?? 0).toBeGreaterThan(1);
      expect(contactHeight?.confidence ?? 1).toBeLessThan(0.8);
    },
  );

  it.fails(
    "heavy jitter: 15 % of torso positional noise should lower measurement confidence, not report knee_flexion 67° vs 23° at 0.95 and score normal",
    async () => {
      const result = await run("heavy_jitter", 39);
      const knee = result.metricErrors.find((entry) => entry.metricKey === "knee_flexion_deg");
      expect(knee?.relDeviation ?? 0).toBeGreaterThan(1);
      expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(
        false,
      );
    },
  );

  it("pre-analysis gate: frames with zero landmarks / all landmarks below visibility 0.3 are not analyzable", async () => {
    const empty = await run("no_player_empty_frames", 1);
    const faint = await run("no_player_subthreshold_visibility", 1);
    expect(empty.quality.reasons).toContain("low_pose_confidence");
    expect(faint.quality.reasons).toContain("low_pose_confidence");
    expect(empty.preGate.analyzable).toBe(false);
    expect(faint.preGate.analyzable).toBe(false);
    expect(empty.preGate.reasons).toContain("low_pose_confidence");
    expect(faint.preGate.reasons).toContain("low_pose_confidence");
    expect(empty.fusion.kind).toBe("gated");
    expect(faint.fusion.kind).toBe("gated");
  });

  it("pre-analysis gate: every capture-quality reason blocks (not only scale), and the decision carries the reason", () => {
    const definition = SCENARIOS.find((entry) => entry.id === "exit_reenter_through_contact");
    if (!definition) throw new Error("scenario missing");
    const scenario = buildCase(definition, 1);
    const quality = evaluateCaptureQuality(scenario.sequence);
    expect(quality.analyzable).toBe(false);
    expect(quality.reasons).toContain("tracking_dropout_gap");
    const decision = evaluatePreAnalysisGate({
      frame: null,
      pose: scenario.sequence,
      poseQuality: quality,
    });
    expect(decision.analyzable).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(quality.reasons));
  });
});
