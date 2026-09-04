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
 * Plain `it` blocks are gaps that HAVE been closed: the pre-analysis gate
 * (evaluateCaptureQuality → evaluatePreAnalysisGate, applied by the shipping
 * path before analyzeCapture) now abstains on them, and they stay pinned as
 * positive must-abstain assertions.
 */

async function run(id: string, seed: number): Promise<CaseResult> {
  const definition = SCENARIOS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`scenario ${id} missing`);
  return runCase(buildCase(definition, seed));
}

describe("player visibility — known gaps (pinned, replayable)", () => {
  it("far camera: a stream the pose-quality gate rejects (torso < 0.08) must abstain, never score with presentation normal", async () => {
    const result = await run("far_camera", 1);
    expect(result.quality.reasons).toContain("player_too_small_in_frame");
    expect(result.preGate.analyzable).toBe(false);
    expect(result.preGate.reasons).toContain("person_implausible_scale");
    expect(result.fusion.kind).not.toBe("scored");
    expect(result.fusion.kind).toBe("failed");
    if (result.fusion.kind === "failed") {
      expect(result.fusion.code).toBe("capture.not_analyzable.person_implausible_scale");
    }
    expect(result.violations).toEqual([]);
  });

  it("far camera (noiseless): the gated stream must abstain instead of reproducing the clean reference score", async () => {
    const result = await run("far_camera_noiseless", 1);
    expect(result.quality.analyzable).toBe(false);
    expect(result.preGate.analyzable).toBe(false);
    expect(result.fusion.kind).not.toBe("scored");
    // No score at all → no delta against the reference to reproduce.
    expect(result.scoreDelta).toBeNull();
    expect(result.reference.outcome).toBe("scored");
  });

  it("exit/re-enter through contact: a > 700 ms tracking gap across the stroke must abstain with the dropout reason", async () => {
    const result = await run("exit_reenter_through_contact", 1);
    expect(result.quality.reasons).toContain("tracking_dropout_gap");
    expect(result.quality.largestGapMs).toBeGreaterThan(700);
    expect(result.preGate.analyzable).toBe(false);
    expect(result.preGate.reasons).toContain("tracking_dropout_gap");
    expect(result.fusion.kind).not.toBe("scored");
    expect(result.fusion.kind).toBe("failed");
    if (result.fusion.kind === "failed") {
      expect(result.fusion.failureKind).toBe("low_confidence");
      expect(result.fusion.code).toMatch(/^capture\.not_analyzable\./);
    }
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

  it("occlusion through contact: swinging arm + torso hidden across contact must abstain, never score normal with contact shifted 383 ms", async () => {
    const result = await run("occlusion_through_contact", 7);
    // The whole-clip quality report cannot see a 150–400 ms occlusion (the
    // full-body rate stays above 0.5); the gate measures tracking continuity
    // inside the stroke window and abstains on it.
    expect(result.preGate.analyzable).toBe(false);
    expect(result.preGate.reasons).toContain("stroke_window_tracking_gap");
    expect(result.fusion.kind).not.toBe("scored");
    expect(result.fusion.kind === "scored" && result.fusion.presentation === "normal").toBe(false);
    expect(result.reference.outcome).toBe("scored");
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

  it("pre-analysis gate: frames with zero landmarks / all landmarks below visibility 0.3 are treated as no person found and must abstain", async () => {
    const empty = await run("no_player_empty_frames", 1);
    const faint = await run("no_player_subthreshold_visibility", 1);
    expect(empty.quality.reasons).toContain("low_pose_confidence");
    expect(faint.quality.reasons).toContain("low_pose_confidence");
    expect(empty.preGate.analyzable).toBe(false);
    expect(faint.preGate.analyzable).toBe(false);
    expect(empty.preGate.reasons).toContain("low_pose_confidence");
    expect(faint.preGate.reasons).toContain("low_pose_confidence");
    expect(empty.fusion.kind).not.toBe("scored");
    expect(faint.fusion.kind).not.toBe("scored");
  });

  it("pre-analysis gate: every measured pose-quality reason blocks (dropout, confidence, coverage, scale), while unmeasured signals stay in notEvaluated", () => {
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
    expect(decision.reasons).toContain("tracking_dropout_gap");
    // Honest gaps: nothing measured is reported as passing evidence.
    expect(decision.notEvaluated).toContain("frame_statistics");
    expect(decision.notEvaluated).toContain("stroke_window_tracking");
    for (const signal of quality.notEvaluated) {
      expect(decision.notEvaluated).toContain(signal);
    }
  });
});
