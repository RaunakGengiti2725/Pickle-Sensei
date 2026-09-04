/**
 * Structural audit (pass 1) — evidence probe. Prints the concrete outputs
 * behind the audit findings so the JSON can be attached as an artifact.
 *
 *   pnpm --filter @pickle/vision-geometry exec tsx test/audit.structural1.probe.ts
 */
import { analyzeClip } from "@pickle/analysis-pipeline";
import type { PoseFrame } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import {
  createGeometryProviderSet,
  estimateContact,
  evaluateCaptureQuality,
  GEOMETRY_BUNDLE_VERSION,
  RecordedTriggerStrokeDetector,
} from "../src/index.js";

const OPTIONS = {
  analysisId: "audit-probe",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-08-27T18:00:00.000Z",
};

async function pipeline(
  video: { width: number; height: number },
  mutate: (frames: PoseFrame[]) => PoseFrame[] = (frames) => frames,
) {
  const swing = generateSwing();
  const clip: VideoClipRef = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: video.width,
    height: video.height,
  };
  const providers = createGeometryProviderSet({
    poseFrames: mutate(
      swing.frames.map((frame) => ({ ...frame, landmarks: [...frame.landmarks] })),
    ),
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.88,
    },
    video,
  });
  const result = await analyzeClip(providers, clip, OPTIONS);
  if (!result.ok) return { ok: false, failure: result.failure };
  return {
    ok: true,
    resultKind: result.value.resultKind,
    overallScore: result.value.overallScore,
    measurements: result.value.measurements.map((m) => ({
      metricKey: m.metricKey,
      value: m.value,
      confidence: m.confidence,
      source: m.source,
    })),
  };
}

function withGhostWrist(
  sequence: PoseSequence,
  tMs: number,
  point: { x: number; y: number },
  bandMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - tMs) <= bandMs
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "left_wrist"
                ? { ...mark, x: point.x, y: point.y, visibility: 0 }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

function farBall(peakMs: number, offsetMs: number): BallObservation[] {
  return Array.from({ length: 10 }, (_, index) => {
    const t = peakMs - offsetMs + index * 30;
    const before = index <= 4;
    return {
      frameIndex: index,
      timestampMs: t,
      x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
      y: 0.15,
      confidence: 0.8,
    };
  });
}

async function main() {
  const out: Record<string, unknown> = {};

  // F1: ghost wrist tethering in estimateContact.
  {
    const { sequence, window } = generateSwingSequence();
    const win = { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs };
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 2.4 - Math.abs(t - window.peakMs) / 90) };
    });
    const ball = farBall(window.peakMs, 150);
    out.ghostWrist_abstainToEstimated = {
      control: estimateContact({ sequence, window: win, ballObservations: ball, paddleSpeeds }),
      ghosted: estimateContact({
        sequence: withGhostWrist(sequence, window.peakMs - 30, { x: 0.27, y: 0.15 }, 200),
        window: win,
        ballObservations: ball,
        paddleSpeeds,
      }),
    };
    const targetWrists = Array.from({ length: 60 }, (_, index) => ({
      timestampMs: window.startMs + index * 30,
      x: 0.6,
      y: 0.7,
    }));
    const far = farBall(window.peakMs, 400);
    out.ghostWrist_farTurnTethered = {
      control: estimateContact({ sequence, window: win, ballObservations: far, targetWrists }),
      ghosted: estimateContact({
        sequence: withGhostWrist(sequence, window.peakMs - 280, { x: 0.27, y: 0.15 }, 100),
        window: win,
        ballObservations: far,
        targetWrists,
      }),
    };
  }

  // F2: width 0 → scored analysis with collapsed x geometry.
  out.width0 = await pipeline({ width: 0, height: 1080 });
  out.widthNaN = await pipeline({ width: Number.NaN, height: 1080 });
  out.control1080 = await pipeline({ width: 1080, height: 1080 });

  // F3: NaN wrist visibility → scored with NaN confidences.
  out.nanWristVisibility = await pipeline({ width: 1080, height: 1080 }, (frames) =>
    frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name === "right_wrist" || mark.name === "left_wrist"
          ? { ...mark, visibility: Number.NaN }
          : mark,
      ),
    })),
  );
  out.noAnkles = await pipeline({ width: 1080, height: 1080 }, (frames) =>
    frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.filter(
        (mark) => mark.name !== "left_ankle" && mark.name !== "right_ankle",
      ),
    })),
  );

  // F4: NaN trigger window accepted.
  {
    const clip: VideoClipRef = { uri: "x", durationMs: 3000, fps: 60, width: 1, height: 1 };
    const detector = new RecordedTriggerStrokeDetector({
      triggerModelVersion: "t",
      startMs: Number.NaN,
      endMs: Number.NaN,
      peakMotionMs: 1000,
      confidence: 0.8,
    });
    out.nanTriggerWindow = await detector.detectStrokes(clip);
  }

  // F5: capture quality reversed frames hides a dropout.
  {
    const { sequence } = generateSwingSequence();
    const holeStart = sequence.frames[40]!.timestampMs;
    const frames = sequence.frames.filter(
      (frame) => frame.timestampMs < holeStart || frame.timestampMs >= holeStart + 1000,
    );
    out.captureQualityOrder = {
      sorted: evaluateCaptureQuality({ ...sequence, frames }),
      reversed: evaluateCaptureQuality({ ...sequence, frames: [...frames].reverse() }),
    };
  }

  process.stdout.write(
    `${JSON.stringify(out, (_key, value) => (typeof value === "number" && Number.isNaN(value) ? "NaN" : value), 2)}\n`,
  );
}

await main();
