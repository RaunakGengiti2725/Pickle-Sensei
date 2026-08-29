import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";

/**
 * Shared synthetic scenes for the ownership-conditioned posterior (g05):
 * the e09/f09 F3 residual (a foreign paddle hovering WITHIN reach of the
 * target's idle off-hand wrist, arcing at the opponent's hit at truth+600ms)
 * and its positive counterpart (a genuine paddle riding the dominant wrist).
 * Synthetic math tests, not human truth.
 */

export interface OwnershipScene {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMotionMs: number };
  trueContactMs: number;
  paddleCenters: Array<{ timestampMs: number; x: number; y: number }>;
  paddleSpeeds: Array<{ timestampMs: number; value: number }>;
}

export function speedsOf(
  centers: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
): Array<{ timestampMs: number; value: number }> {
  const speeds: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < centers.length; index += 1) {
    const a = centers[index - 1]!;
    const b = centers[index]!;
    speeds.push({
      timestampMs: (a.timestampMs + b.timestampMs) / 2,
      value: (Math.hypot(b.x - a.x, b.y - a.y) / (b.timestampMs - a.timestampMs)) * 1000,
    });
  }
  return speeds;
}

export function foreignPaddleScene(): OwnershipScene & {
  oppHitMs: number;
  ball: BallObservation[];
} {
  const { sequence, window } = generateSwingSequence();
  const idleWrist = sequence.frames
    .map((frame) => frame.landmarks.find((mark) => mark.name === "left_wrist"))
    .find((mark): mark is NonNullable<typeof mark> => mark !== undefined)!;
  const oppHitMs = window.peakMs + 600;
  const paddleCenters = Array.from({ length: 70 }, (_, i) => {
    const t = window.startMs + i * 30;
    const arc = Math.exp(-((t - oppHitMs) ** 2) / (2 * 100 * 100));
    return {
      timestampMs: t,
      x: idleWrist.x - 0.12 - 0.1 * arc,
      y: idleWrist.y + 0.05 - 0.03 * arc,
    };
  });
  const hitAt = { x: idleWrist.x - 0.22, y: idleWrist.y + 0.02 };
  const ball: BallObservation[] = [];
  let frameIndex = 0;
  for (let t = oppHitMs - 400; t <= oppHitMs + 300; t += 30) {
    const before = t <= oppHitMs;
    const raw = before ? (t - (oppHitMs - 400)) / 400 : (t - oppHitMs) / 300;
    ball.push({
      frameIndex: frameIndex++,
      timestampMs: t,
      x: before ? hitAt.x + 0.4 - 0.4 * raw : hitAt.x + 0.35 * raw,
      y: before ? hitAt.y - 0.35 + 0.35 * raw : hitAt.y - 0.3 * raw,
      confidence: 0.8,
    });
  }
  return {
    sequence,
    window: { startMs: window.startMs, endMs: window.endMs + 500, peakMotionMs: window.peakMs },
    trueContactMs: window.peakMs,
    oppHitMs,
    ball,
    paddleCenters,
    paddleSpeeds: speedsOf(paddleCenters),
  };
}

export function genuinePaddleScene(): OwnershipScene {
  const { sequence, window } = generateSwingSequence();
  const paddleCenters = sequence.frames
    .map((frame) => {
      const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist");
      return wrist
        ? { timestampMs: frame.timestampMs, x: wrist.x + 0.05, y: wrist.y - 0.03 }
        : null;
    })
    .filter((center): center is NonNullable<typeof center> => center !== null);
  return {
    sequence,
    window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
    trueContactMs: window.peakMs,
    paddleCenters,
    paddleSpeeds: speedsOf(paddleCenters),
  };
}
