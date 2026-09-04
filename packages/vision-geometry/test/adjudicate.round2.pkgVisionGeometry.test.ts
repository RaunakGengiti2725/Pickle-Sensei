import { describe, expect, it } from "vitest";
import { analyzeClip } from "@pickle/analysis-pipeline";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";
import type { PoseFrame } from "@pickle/shared-types";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import type { VideoClipRef } from "@pickle/vision-contracts";
import {
  GEOMETRY_BUNDLE_VERSION,
  classifyStroke,
  createGeometryProviderSet,
  estimateContact,
  evaluateCaptureQuality,
} from "../src/index.js";

/**
 * ADJUDICATION round 2 — pkg-vision-geometry at 4d812e1a.
 *
 * Independent (adjudicator-authored) reproductions of the round-2 auditor
 * candidates that were not already pinned by adjudicate.pkgVisionGeometry.
 * Every `it` asserts the OBSERVED (defective) behaviour positively so the
 * verbose log is unambiguous evidence. A fix will make these tests fail;
 * the acceptance criteria in the adjudication report replace them.
 */

const OPTIONS = {
  analysisId: "adjudicate-round2",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-09-04T12:00:00.000Z",
};

async function analyzeSwing(mutate: (frames: PoseFrame[]) => PoseFrame[]) {
  const swing = generateSwing();
  const clip: VideoClipRef = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: 1080,
    height: 1080,
  };
  const providers = createGeometryProviderSet({
    poseFrames: mutate(swing.frames.map((f) => ({ ...f, landmarks: [...f.landmarks] }))),
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.88,
    },
    video: { width: 1080, height: 1080 },
  });
  return analyzeClip(providers, clip, OPTIONS);
}

// ─────────────────────────────────────────────────────────────────────────────
// VG-8 — ground line defaulted to y=1 when no ankle was ever measured
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-8 featureExtractor: contact_height_ratio is reported against a fabricated ground line", () => {
  it("observed: with ankles never present, contact_height_ratio is still emitted as source=real with a different value than the measured control", async () => {
    const control = await analyzeSwing((frames) => frames);
    const noAnkles = await analyzeSwing((frames) =>
      frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter(
          (m) => m.name !== "left_ankle" && m.name !== "right_ankle",
        ),
      })),
    );
    expect(control.ok).toBe(true);
    expect(noAnkles.ok).toBe(true);
    if (!control.ok || !noAnkles.ok) return;
    const truth = control.value.measurements.find((m) => m.metricKey === "contact_height_ratio")!;
    const ghost = noAnkles.value.measurements.find((m) => m.metricKey === "contact_height_ratio")!;
    expect(truth.value).toBeCloseTo(0.4, 2); // synthetic truth contactHeightRatio = 0.4
    expect(ghost).toBeDefined();
    expect(ghost.source).toBe("real");
    // Defect: value is computed against groundY = 1 (image bottom), not a measured ankle line.
    // The control reproduces the constructed 0.40 to ~1e-14, so any drift is the ground line.
    expect(Math.abs(ghost.value - truth.value)).toBeGreaterThan(0.05);
    // The reported confidence is NOT degraded by the fabricated ground line.
    expect(ghost.confidence).toBeGreaterThanOrEqual(truth.confidence - 1e-9);
    console.log(
      `[VG-8] contact_height_ratio measured=${truth.value.toFixed(4)} noAnkles=${ghost.value.toFixed(4)} (source=${ghost.source}, conf=${ghost.confidence})`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-7 — classifyStroke: visibility-0 torso landmarks define the midline
// ─────────────────────────────────────────────────────────────────────────────
function withUnmeasuredTorsoAt(
  sequence: PoseSequence,
  tMs: number,
  torsoCenterX: number,
): PoseSequence {
  const nearest = sequence.frames.reduce((best, f) =>
    Math.abs(f.timestampMs - tMs) < Math.abs(best.timestampMs - tMs) ? f : best,
  );
  const torso = new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      frame === nearest
        ? {
            ...frame,
            landmarks: frame.landmarks.map((m) =>
              torso.has(m.name)
                ? {
                    ...m,
                    x: torsoCenterX + (m.name.startsWith("left") ? -0.06 : 0.06),
                    y: m.name.endsWith("hip") ? 0.7 : 0.5,
                    visibility: 0,
                  }
                : m,
            ),
          }
        : frame,
    ),
  };
}

describe("VG-7 classifyStroke: unmeasured (visibility 0) torso at the reference frame decides the side", () => {
  const { sequence, window } = generateSwingSequence();
  const args = {
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: window.peakMs,
    handedness: "right" as const,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  };

  it("control: measured torso → FOREHAND committed", () => {
    const p = classifyStroke({ sequence, ...args });
    expect(p.label).toBe("FOREHAND");
    expect(p.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("observed: the label FLIPS purely by moving visibility-0 torso landmarks — unmeasured joints are treated as measured", () => {
    const wristX = sequence.frames
      .reduce((best, f) =>
        Math.abs(f.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
          ? f
          : best,
      )
      .landmarks.find((m) => m.name === "right_wrist")!.x;
    const left = classifyStroke({
      sequence: withUnmeasuredTorsoAt(sequence, window.peakMs, wristX - 0.25),
      ...args,
    });
    const right = classifyStroke({
      sequence: withUnmeasuredTorsoAt(sequence, window.peakMs, wristX + 0.25),
      ...args,
    });
    console.log(
      `[VG-7] ghost torso left-of-wrist → ${left.label}@${left.confidence}; right-of-wrist → ${right.label}@${right.confidence}`,
    );
    expect(left.label).not.toBe("UNKNOWN");
    expect(right.label).not.toBe("UNKNOWN");
    expect(left.label).not.toBe(right.label);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-6 — estimateContact: visibility-0 wrist tethers the ball turn
// ─────────────────────────────────────────────────────────────────────────────
function turnBall(turnX: number, turnY: number, turnMs: number): BallObservation[] {
  // Ball approaches from the left, reverses at (turnX, turnY) at turnMs, leaves to the left.
  return Array.from({ length: 21 }, (_, i) => {
    const dt = (i - 10) * 16.667;
    return {
      frameIndex: i,
      timestampMs: turnMs + dt,
      x: turnX - Math.abs(dt) * 0.0012,
      y: turnY,
      confidence: 0.85,
    };
  });
}

function withGhostWrist(sequence: PoseSequence, name: "left_wrist", at: { x: number; y: number }) {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((m) =>
        m.name === name ? { ...m, x: at.x, y: at.y, visibility: 0 } : m,
      ),
    })),
  };
}

describe("VG-6 estimateContact: a visibility-0 wrist carries ball-proximity evidence", () => {
  const { sequence, window } = generateSwingSequence();
  const peakFrame = sequence.frames.reduce((best, f) =>
    Math.abs(f.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs) ? f : best,
  );
  const rightWrist = peakFrame.landmarks.find((m) => m.name === "right_wrist")!;
  // Ball turns far (≈0.55 image widths) from every measured joint.
  const farTurn = { x: Math.min(0.98, rightWrist.x + 0.55), y: rightWrist.y };
  const ball = turnBall(farTurn.x, farTurn.y, window.peakMs);
  const args = {
    window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
    paddleSpeeds: null,
    paddleCenters: null,
  };

  it("control: ball turn far from every visible wrist is not ball-confirmed", () => {
    const r = estimateContact({ sequence, ballObservations: ball, ...args });
    console.log(`[VG-6 control] ${JSON.stringify(r).slice(0, 300)}`);
    if (r.status === "estimated") expect(r.ballConfirmed).toBe(false);
  });

  it("observed: a visibility-0 left_wrist parked at the far turn point makes the ball turn count as a wrist-proximity contact", () => {
    const ghosted = withGhostWrist(sequence, "left_wrist", farTurn);
    const r = estimateContact({ sequence: ghosted, ballObservations: ball, ...args });
    console.log(`[VG-6 ghost] ${JSON.stringify(r).slice(0, 400)}`);
    expect(r.status).toBe("estimated");
    if (r.status !== "estimated") return;
    expect(r.ballConfirmed).toBe(true);
    expect(
      r.supportingEvidence.some(
        (s) => s.signal === "ball_wrist_proximity" || s.signal === "ball_direction_change",
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-10 — non-finite / order hygiene in capture quality (independent spot checks)
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-10 evaluateCaptureQuality: non-finite and order hygiene", () => {
  const { sequence } = generateSwingSequence();

  it("observed: NaN frame confidence on every frame yields a NaN mean confidence without failing the gate", () => {
    const nan = {
      ...sequence,
      frames: sequence.frames.map((f) => ({ ...f, confidence: Number.NaN })),
    };
    const q = evaluateCaptureQuality(nan);
    console.log(`[VG-10 nanConf] ${JSON.stringify(q).slice(0, 400)}`);
    expect(q.reasons).not.toContain("low_pose_confidence");
    expect(q.analyzable).toBe(true);
    expect(Number.isNaN(q.stats.meanFrameConfidence)).toBe(true);
  });

  it("observed: reversed frame order reports a negative duration / zero fps (order-dependent stats)", () => {
    const reversed = { ...sequence, frames: [...sequence.frames].reverse() };
    const forward = evaluateCaptureQuality(sequence);
    const backward = evaluateCaptureQuality(reversed);
    console.log(
      `[VG-10 order] forward=${JSON.stringify(forward).slice(0, 200)} backward=${JSON.stringify(backward).slice(0, 200)}`,
    );
    expect(JSON.stringify(forward)).not.toBe(JSON.stringify(backward));
  });
});
