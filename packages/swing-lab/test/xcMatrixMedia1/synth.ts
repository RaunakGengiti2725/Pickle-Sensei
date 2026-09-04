import { generateSwing, SYNTHETIC_PRODUCER } from "@pickle/evaluation";
import type { CaptureEnvelopeMeasurements } from "@pickle/capture-envelope";
import type { CanonicalPoseFrame, PoseSequence } from "@pickle/swing-domain";
import type { FrameStats } from "@pickle/vision-geometry";
import { SeededRng } from "./rng.js";
import type { CellSpec } from "./shapes.js";

/**
 * Synthetic capture construction for one matrix cell.
 *
 * The body motion is the `@pickle/evaluation` swing generator's deterministic
 * skeleton (square-video geometry, in image-height units). This module only
 * re-expresses that geometry inside the requested CONTAINER:
 *
 * - aspect: normalized x is rescaled around the frame center so the same
 *   physical body appears in a portrait / landscape / odd-aspect frame
 *   (x' = 0.5 + (x − 0.5) · h / w). Landmarks that leave the frame are
 *   clamped to the frame edge and marked visibility 0 (a pose model does not
 *   observe joints outside the sensor).
 * - resolution: pixel-domain jitter σ = JITTER_PX / short side is added to
 *   every landmark, so tiny frames are noisier than 8K frames.
 * - duration: clips shorter than the swing are truncated on the frame grid;
 *   longer clips wrap the swing in idle "ready" frames (breathing sway +
 *   jitter) at a seeded offset so the stroke is not always at t = 0.
 * - fps: frames sit on the integer-ms grid t_k = round(k · 1000 / fps),
 *   exactly like the generator's own `Math.round(tMs)`.
 *
 * No ground-truth values are produced or asserted; only completion-vs-
 * explicit-failure semantics are checked downstream.
 */

export const SYNTH_VERSION = "xc-matrix-media-1-synth-1";
const JITTER_PX = 1.5;
const IDLE_SWAY_AMPLITUDE = 0.003;
const IDLE_SWAY_PERIOD_MS = 3200;

export interface SynthCapture {
  sequence: PoseSequence;
  /** Container duration in ms as the mobile `CapturedClip.durationMs` would report it. */
  clipDurationMs: number;
  /** Video frame count implied by the container (duration × fps). */
  videoFrameCount: number;
  /** Where the synthetic stroke sits inside the clip (null when truncated away). */
  swingWindow: { startMs: number; endMs: number; peakMs: number } | null;
  trigger: { startMs: number; endMs: number; peakMotionMs: number | null };
  /** Fraction of landmarks that were clamped because they left the frame. */
  outOfFrameLandmarkFraction: number;
  frameStats: FrameStats;
  envelope: CaptureEnvelopeMeasurements;
}

export function synthesizeCapture(spec: CellSpec): SynthCapture {
  const rng = new SeededRng(spec.seed);
  const { width, height } = spec.resolution;
  const fps = spec.fps;
  const interval = 1000 / fps;
  const gridTime = (k: number): number => Math.round(k * interval);

  const swing = generateSwing({ fps, handed: spec.handed });
  const swingDurationMs = swing.clip.durationMs;
  const swingFrames = swing.frames;
  const readyPose = swingFrames[0]!;

  // Aspect re-expression. The generator's coordinates are square-video
  // normalized units; horizontal extents shrink in wide frames and grow in
  // tall ones. Degenerate containers (0 / NaN / negative) fall back to a unit
  // aspect so the pose data itself stays finite — the parser is expected to
  // reject the video block, not the frames.
  const aspect = Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : 1;
  const shortSidePx = Math.min(width, height);
  const jitterSigma =
    Number.isFinite(shortSidePx) && shortSidePx > 0 ? JITTER_PX / shortSidePx : JITTER_PX / 1080;

  let clamped = 0;
  let total = 0;
  const projectFrame = (
    frame: (typeof swingFrames)[number],
    frameIndex: number,
    timestampMs: number,
    swayX: number,
  ): CanonicalPoseFrame => {
    const landmarks = frame.landmarks.map((mark) => {
      total += 1;
      const rawX = 0.5 + (mark.x - 0.5) / aspect + swayX + rng.gaussian() * jitterSigma;
      const rawY = mark.y + rng.gaussian() * jitterSigma;
      const inFrame = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
      if (!inFrame) clamped += 1;
      return {
        name: mark.name,
        x: Math.min(1, Math.max(0, rawX)),
        y: Math.min(1, Math.max(0, rawY)),
        visibility: inFrame
          ? Math.min(1, Math.max(0, mark.visibility + rng.uniform(-0.1, 0.04)))
          : 0,
      };
    });
    return {
      frameIndex,
      timestampMs,
      confidence: Math.min(1, Math.max(0, frame.confidence + rng.uniform(-0.15, 0.04))),
      landmarks,
    };
  };

  const frames: CanonicalPoseFrame[] = [];
  let clipDurationMs: number;
  let swingWindow: SynthCapture["swingWindow"] = null;

  if (spec.duration.kind === "frames") {
    const n = spec.duration.frames;
    for (let k = 0; k < n; k += 1) {
      const source = swingFrames[Math.min(k, swingFrames.length - 1)]!;
      frames.push(projectFrame(source, k, gridTime(k), 0));
    }
    clipDurationMs = Math.round(n * interval);
    swingWindow = null;
  } else if (spec.duration.ms <= swingDurationMs) {
    const limit = spec.duration.ms;
    for (let k = 0; k < swingFrames.length; k += 1) {
      const t = gridTime(k);
      if (t > limit) break;
      frames.push(projectFrame(swingFrames[k]!, k, t, 0));
    }
    clipDurationMs = limit;
    swingWindow =
      limit >= swing.window.peakMs
        ? { startMs: 0, endMs: Math.min(limit, swing.window.endMs), peakMs: swing.window.peakMs }
        : null;
  } else {
    const totalMs = spec.duration.ms;
    const slack = totalMs - swingDurationMs;
    // Seeded pre-roll on the frame grid so the stroke position is replayable.
    const preRollFrames = Math.floor(rng.uniform(0, 1) * Math.floor(slack / interval));
    const preRollMs = gridTime(preRollFrames);
    let k = 0;
    const sway = (t: number): number =>
      IDLE_SWAY_AMPLITUDE * Math.sin((2 * Math.PI * t) / IDLE_SWAY_PERIOD_MS);
    while (gridTime(k) < preRollMs) {
      const t = gridTime(k);
      frames.push(projectFrame(readyPose, k, t, sway(t)));
      k += 1;
    }
    for (const source of swingFrames) {
      frames.push(projectFrame(source, k, preRollMs + source.timestampMs, 0));
      k += 1;
    }
    const lastSwing = readyPose;
    while (gridTime(k) <= totalMs) {
      const t = gridTime(k);
      frames.push(projectFrame(lastSwing, k, t, sway(t)));
      k += 1;
    }
    clipDurationMs = totalMs;
    swingWindow = {
      startMs: preRollMs,
      endMs: preRollMs + swing.window.endMs,
      peakMs: preRollMs + swing.window.peakMs,
    };
  }

  const sequence: PoseSequence = {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...SYNTHETIC_PRODUCER },
    video: { width, height, fps },
    frames,
  };

  const trigger =
    spec.trigger === "swing_window" && swingWindow
      ? { startMs: swingWindow.startMs, endMs: swingWindow.endMs, peakMotionMs: swingWindow.peakMs }
      : { startMs: 0, endMs: clipDurationMs, peakMotionMs: null };

  const videoFrameCount = Math.max(frames.length, Math.round((clipDurationMs * fps) / 1000));

  return {
    sequence,
    clipDurationMs,
    videoFrameCount,
    swingWindow,
    trigger,
    outOfFrameLandmarkFraction: total > 0 ? clamped / total : 0,
    frameStats: synthesizeFrameStats(rng, spec, videoFrameCount, clipDurationMs),
    envelope: synthesizeEnvelopeMeasurements(spec, sequence, clipDurationMs),
  };
}

/**
 * Pixel statistics a moving, textured, well-lit court scene would produce,
 * so the frame gate is exercised on the SHAPE axes (frame count, duration,
 * aspect) rather than on content defects that other suites already cover.
 */
function synthesizeFrameStats(
  rng: SeededRng,
  spec: CellSpec,
  videoFrameCount: number,
  clipDurationMs: number,
): FrameStats {
  const { width, height } = spec.resolution;
  const interFrameDiffs: number[] = [];
  const spatialLumaStd: number[] = [];
  // Stats decode is capped like the probe (4 fps sampling) so a 10-minute
  // clip does not allocate a per-frame array of hundreds of thousands.
  const sampled = Math.min(videoFrameCount, Math.max(1, Math.round((clipDurationMs / 1000) * 4)));
  for (let i = 0; i < sampled; i += 1) {
    spatialLumaStd.push(rng.uniform(28, 46));
    if (i > 0) interFrameDiffs.push(rng.uniform(3, 9));
  }
  const longSide = 320;
  const scale =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? longSide / Math.max(width, height)
      : 1;
  return {
    frameCount: videoFrameCount,
    durationMs: clipDurationMs,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    interFrameDiffs,
    spatialLumaStd,
    letterboxRowFraction: 0,
    source: { width, height },
    decode: { errorCount: 0, expectedFrameCount: videoFrameCount },
  };
}

/**
 * Envelope inputs the mobile `attemptCaptureEnvelope` can derive from the
 * clip + pose alone: container width/height/fps/duration, timing CV from
 * the recorded pose timestamps, and the two pose-derived player signals.
 * Pixel-statistics dimensions stay null (NOT_MEASURED) exactly as they do
 * on-device when no native quality snapshot exists.
 */
function synthesizeEnvelopeMeasurements(
  spec: CellSpec,
  sequence: PoseSequence,
  clipDurationMs: number,
): CaptureEnvelopeMeasurements {
  const frames = sequence.frames;
  const intervals: number[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    intervals.push(frames[i]!.timestampMs - frames[i - 1]!.timestampMs);
  }
  let frameIntervalCv: number | null = null;
  if (intervals.length >= 2) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    frameIntervalCv = mean > 0 ? Math.sqrt(variance) / mean : null;
  }

  let heightSum = 0;
  let heightCount = 0;
  let visSum = 0;
  let visCount = 0;
  for (const frame of frames) {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let seen = 0;
    for (const mark of frame.landmarks) {
      visSum += mark.visibility;
      visCount += 1;
      if (mark.visibility >= 0.3) {
        minY = Math.min(minY, mark.y);
        maxY = Math.max(maxY, mark.y);
        seen += 1;
      }
    }
    if (seen >= 2) {
      heightSum += maxY - minY;
      heightCount += 1;
    }
  }

  return {
    frameWidthPx: spec.resolution.width,
    frameHeightPx: spec.resolution.height,
    avgFrameRateFps: spec.fps,
    brightnessMeanLuma: null,
    brightnessStdLuma: null,
    laplacianVarianceMedian: null,
    meanAbsFrameDiff: null,
    denoiseSurvivalRatio: null,
    clippedPixelFraction: null,
    contrastNormalizedFrameDiff: null,
    frameIntervalCv,
    clipDurationMs,
    playerPixelHeightFraction: heightCount > 0 ? heightSum / heightCount : null,
    playerMeanJointVisibility: visCount > 0 ? visSum / visCount : null,
  };
}
