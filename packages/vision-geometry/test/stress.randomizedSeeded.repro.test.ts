import { generateSwingSequence } from "@pickle/evaluation";
import { describe, expect, it } from "vitest";
import {
  detectOfflineStrokeWindow,
  evaluateCaptureQuality,
  paddleOwnershipFromHandAffinity,
} from "../src/index.js";
import { planSequence, Rng } from "./support/randomizedSeededStress.js";

/**
 * Minimized reproductions of the three failure classes surfaced by the
 * randomized-seeded stress campaign (see stress.randomizedSeeded.test.ts).
 * Each `it` replays one class directly against the public API; the seed
 * listed in its docblock replays the full original sequence through the
 * harness.
 */

/**
 * Class A — stress seed 1298271561 (and 143 more across two 2000-seed campaigns).
 *
 *   STRESS_SEEDS=1298271561 pnpm --filter @pickle/vision-geometry test -- stress.randomizedSeeded
 *
 * Minimized plan: noise → collapse_torso (hips coincide with shoulders in
 * every frame) → paddle_foreign (track follows the non-dominant wrist) →
 * q_ownership. `medianTorsoSpan` returns 0 (not null) for a degenerate torso,
 * so every per-step `moveTorso` is Infinity, `ratio` becomes Infinity/Infinity
 * = NaN, `clamp01(NaN)` stays NaN, and the weighted coherence (NaN/Infinity)
 * poisons the returned confidence. The jitter below only guarantees that no
 * two consecutive paddle centres coincide (the role the `noise` action plays
 * in the seed); a perfectly static pair short-circuits the weight to NaN and
 * hides the bug behind the `coherenceWeight > 0` fallback.
 *
 * Contract under test: hand-affinity ownership either abstains (null) or
 * returns a finite confidence in [0, 1].
 */
describe("repro A: paddleOwnershipFromHandAffinity with a collapsed torso", () => {
  it("returns null or a finite confidence in [0,1] (never NaN)", () => {
    const { sequence } = generateSwingSequence({ handed: "left", fps: 30 });
    sequence.frames.forEach((frame, index) => {
      for (const mark of frame.landmarks) {
        mark.x += 0.002 * Math.sin(index * 1.7);
        mark.y += 0.002 * Math.cos(index * 2.3);
      }
    });
    for (const frame of sequence.frames) {
      const ls = frame.landmarks.find((m) => m.name === "left_shoulder");
      const rs = frame.landmarks.find((m) => m.name === "right_shoulder");
      for (const mark of frame.landmarks) {
        if (mark.name === "left_hip" && ls) {
          mark.x = ls.x;
          mark.y = ls.y;
        }
        if (mark.name === "right_hip" && rs) {
          mark.x = rs.x;
          mark.y = rs.y;
        }
      }
    }
    const paddle = sequence.frames.flatMap((frame) => {
      const wrist = frame.landmarks.find((m) => m.name === "right_wrist");
      return wrist
        ? [{ timestampMs: frame.timestampMs - 573, x: wrist.x + 0.19, y: wrist.y, confidence: 0.7 }]
        : [];
    });

    const ownership = paddleOwnershipFromHandAffinity({ sequence, paddleCenters: paddle });

    if (ownership !== null) {
      expect(Number.isFinite(ownership.confidence), `confidence=${ownership.confidence}`).toBe(
        true,
      );
      expect(ownership.confidence).toBeGreaterThanOrEqual(0);
      expect(ownership.confidence).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * Class B — stress seed 675581555 (minimized plan: shuffle_frames →
 * q_offline_window; 9 seeds across two campaigns).
 *
 *   STRESS_SEEDS=675581555 pnpm --filter @pickle/vision-geometry test -- stress.randomizedSeeded
 *
 * `PoseSequence.frames` is documented ascending by timestampMs
 * (swing-domain observations.ts). `detectOfflineStrokeWindow` neither sorts
 * nor rejects an out-of-order sequence: it walks frames positionally, so it
 * returns `ok` with a window whose startMs > endMs instead of a structured
 * failure. Near-legal input; the contract under test is that an `ok` window
 * satisfies startMs ≤ peakMotionMs ≤ endMs.
 */
describe("repro B: detectOfflineStrokeWindow with out-of-order frames", () => {
  it("either fails structurally or returns an ordered window", () => {
    // Same synthetic swing the seed drew, same Fisher-Yates salt the
    // minimized `shuffle_frames` action used.
    const { swing } = planSequence(675581555, 5, 60);
    const { sequence } = generateSwingSequence(
      swing as Parameters<typeof generateSwingSequence>[0],
    );
    const rng = new Rng(2141902402);
    for (let i = sequence.frames.length - 1; i > 0; i -= 1) {
      const j = rng.int(0, i);
      const a = sequence.frames[i]!;
      sequence.frames[i] = sequence.frames[j]!;
      sequence.frames[j] = a;
    }
    sequence.frames.forEach((frame, index) => {
      frame.frameIndex = index;
    });

    const result = detectOfflineStrokeWindow(sequence);

    if (result.ok) {
      const { startMs, endMs, peakMotionMs } = result.value;
      expect(startMs, `start ${startMs} > end ${endMs}`).toBeLessThanOrEqual(endMs);
      expect(peakMotionMs).toBeGreaterThanOrEqual(startMs);
      expect(peakMotionMs).toBeLessThanOrEqual(endMs);
    }
  });
});

/**
 * Class C — stress seed 3551782314 (minimized plan: inject_nonfinite →
 * q_capture_quality; 47 seeds across two campaigns hit this class through
 * evaluateCaptureQuality, assessPaddleTrackIdentity, estimateContact,
 * detectOfflineStrokeWindow, GeometryBiomechanicsExtractor and analyzeClip).
 *
 *   STRESS_SEEDS=3551782314 pnpm --filter @pickle/vision-geometry test -- stress.randomizedSeeded
 *
 * A single non-finite landmark coordinate (a NaN `y` on one frame) is not
 * filtered at the boundary, so it propagates into report statistics
 * (`stats.medianTorsoLengthNorm`), evidence fields and measurement
 * confidences as NaN/Infinity. Contract under test: outputs never carry
 * NaN/±Infinity (the invariant the stress task mandates for every query).
 */
describe("repro C: one non-finite landmark coordinate", () => {
  it("evaluateCaptureQuality keeps every reported statistic finite", () => {
    const { sequence } = generateSwingSequence({ handed: "right", fps: 30 });
    const frame = sequence.frames[Math.floor(sequence.frames.length / 2)]!;
    const hip = frame.landmarks.find((m) => m.name === "left_hip")!;
    hip.y = Number.NaN;

    const report = evaluateCaptureQuality(sequence);

    for (const [key, value] of Object.entries(report.stats)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `stats.${key}=${value}`).toBe(true);
      }
    }
  });
});
