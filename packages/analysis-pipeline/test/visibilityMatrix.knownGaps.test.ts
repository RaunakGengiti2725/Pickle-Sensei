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
 */

async function run(id: string, seed: number): Promise<CaseResult> {
  const definition = SCENARIOS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`scenario ${id} missing`);
  return runCase(buildCase(definition, seed));
}

describe("player visibility — known gaps (pinned, replayable)", () => {
  it.fails(
    "far camera: a stream the pose-quality gate rejects (torso < 0.08) should not score with presentation normal",
    async () => {
      const result = await run("far_camera", 1);
      expect(result.quality.reasons).toContain("player_too_small_in_frame");
      expect(result.preGate.reasons).toContain("person_implausible_scale");
      // Should abstain or at least present lower confidence; today: 9.0 / normal.
      expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(
        false,
      );
    },
  );

  it.fails(
    "far camera (noiseless): scale is invisible to fusion — the gated stream scores identically to the clean reference",
    async () => {
      const result = await run("far_camera_noiseless", 1);
      expect(result.quality.analyzable).toBe(false);
      // A rejected capture should not reproduce the reference score bit-for-bit.
      expect(result.scoreDelta).not.toBe(0);
    },
  );

  it.fails(
    "exit/re-enter through contact: a > 700 ms tracking gap across the stroke should abstain, not place contact 634 ms late and score normal",
    async () => {
      const result = await run("exit_reenter_through_contact", 1);
      expect(result.quality.reasons).toContain("tracking_dropout_gap");
      expect(result.quality.largestGapMs).toBeGreaterThan(700);
      expect(result.fusion.kind).not.toBe("scored");
    },
  );

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

  it.fails(
    "occlusion through contact: wrist/elbow hidden across contact should not score normal with contact shifted 383 ms",
    async () => {
      const result = await run("occlusion_through_contact", 7);
      expect(Math.abs(result.contactShiftMs ?? 0)).toBeGreaterThan(100);
      expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(
        false,
      );
    },
  );

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

  it.fails(
    "pre-analysis gate: frames with zero landmarks / all landmarks below visibility 0.3 should be treated as no person found",
    async () => {
      const empty = await run("no_player_empty_frames", 1);
      const faint = await run("no_player_subthreshold_visibility", 1);
      expect(empty.quality.reasons).toContain("low_pose_confidence");
      expect(faint.quality.reasons).toContain("low_pose_confidence");
      expect(empty.preGate.analyzable).toBe(false);
      expect(faint.preGate.analyzable).toBe(false);
    },
  );

  it("pre-analysis gate: only scale reasons block; pose-confidence, visibility and gap reasons pass through (documents the current contract)", () => {
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
    expect(decision.analyzable).toBe(true);
    expect(decision.reasons).toEqual([]);
  });
});
