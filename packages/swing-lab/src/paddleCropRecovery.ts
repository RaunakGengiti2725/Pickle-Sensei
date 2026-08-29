import {
  TRACKER_GATES,
  type PaddleDetectionSource,
  type PaddleTrackCandidate,
  type RawPaddleDetectionFile,
  type TrackedPaddleObservation,
  type wristSeries,
} from "./paddleTracker.js";

export type { PaddleDetectionSource };

/**
 * Wrist-conditioned crop re-detection — production form of the W12 probe
 * (datasets/experiments/wave-b/W12-summary.json, HANDOFF_V3 §6 item 3).
 *
 * Measured winner (afn-sasebo-rally2 dev evidence only): square crops at
 * {256, 704}px centered on BOTH pose wrists — handedness is never trusted
 * because Apple Vision swaps L/R on rear views — at the existing 0.08 score
 * floor, run only in the tracker's paddle-lost neighborhood. Crop-sourced
 * boxes are provenance-tagged `detection-source=crop` and NEVER enter
 * selection as raw detections: they may only EXTEND existing tracks through
 * the two-stage association after the wrist gate and FP-family suppression
 * below (W12 measured 29.5 junk boxes/frame near wrists at floor .08 on
 * control frames — the gate, not the floor, carries precision).
 *
 * Temporal propagation is ONLY the ≤2-frame TRACKED_ESTIMATE bridge
 * (`bridgeTrackedEstimates`): estimates are explicitly flagged, never
 * counted as detections, and never bridge holes of 3+ frames (W12: hold-last
 * ~useless, and propagation cannot solve the edge-on carry).
 *
 * Everything here is behind the versioned flag below and OFF by default.
 */

export const PADDLE_CROP_RECOVERY_VERSION = "crop-recovery-v1";

export const CROP_RECOVERY_GATES = {
  /** Measured pair ≈ full 3-scale union: 704 wins blur sweeps, 256 wins
   *  edge-on slivers + the contact frame (W12 scaleDecomposition). */
  cropScalesPx: [256, 704],
  /** Existing bench floor; 0.15 collapses missB to 1/4, <0.08 adds nothing. */
  scoreFloor: 0.08,
  /** A crop candidate must sit this close to a conditioning wrist
   *  (same radius as the tracker's in-hand affinity gate). */
  wristGateRadius: TRACKER_GATES.handAffinityRadius,
  /** FP family: court-line slivers are extremely elongated boxes. */
  fpMaxAspectRatio: 3.5,
  /** FP family: shorts/leg boxes hang BELOW the wrist — a box whose top
   *  edge is more than this far below every conditioning wrist is leg/floor,
   *  not an in-hand paddle (normalized units). */
  fpBelowWristMargin: 0.06,
  /** TRACKED_ESTIMATE bridging covers at most this many missing frames. */
  maxBridgeFrames: 2,
} as const;

export interface CropRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CropPlanFrame {
  tMs: number;
  rects: CropRect[];
}

type WristSeries = ReturnType<typeof wristSeries>;

/**
 * Frame timestamps inside the window where NO candidate track has an
 * observation — the paddle-lost neighborhood the crop pass is bounded to.
 */
export function paddleLostFrameTimes(
  frameTimesMs: readonly number[],
  candidates: readonly PaddleTrackCandidate[],
  window: { startMs: number; endMs: number },
  frameIntervalMs: number,
): number[] {
  const covered = new Set<number>();
  for (const candidate of candidates) {
    for (const observation of candidate.observations) covered.add(observation.timestampMs);
  }
  const tolerance = frameIntervalMs / 2;
  return frameTimesMs.filter((tMs) => {
    if (tMs < window.startMs || tMs > window.endMs) return false;
    for (const coveredMs of covered) {
      if (Math.abs(coveredMs - tMs) <= tolerance) return false;
    }
    return true;
  });
}

/**
 * Crop rectangles for the lost frames: one square per scale per wrist, BOTH
 * wrists always (never trust handedness), clamped to the frame. Pixel
 * coordinates, ready for detect_paddle.py --crops.
 */
export function planWristCropRects(
  lostFrameTimesMs: readonly number[],
  wrists: WristSeries,
  video: { width: number; height: number },
): CropPlanFrame[] {
  const plan: CropPlanFrame[] = [];
  for (const tMs of lostFrameTimesMs) {
    const frameWrists = nearestWristEntry(wrists, tMs);
    if (!frameWrists) continue;
    const rects: CropRect[] = [];
    for (const wrist of frameWrists) {
      for (const scale of CROP_RECOVERY_GATES.cropScalesPx) {
        const half = scale / 2;
        const cx = wrist.x * video.width;
        const cy = wrist.y * video.height;
        const rect: CropRect = {
          x0: Math.max(0, Math.round(cx - half)),
          y0: Math.max(0, Math.round(cy - half)),
          x1: Math.min(video.width, Math.round(cx + half)),
          y1: Math.min(video.height, Math.round(cy + half)),
        };
        if (rect.x1 - rect.x0 >= 32 && rect.y1 - rect.y0 >= 32) rects.push(rect);
      }
    }
    if (rects.length > 0) plan.push({ tMs, rects });
  }
  return plan;
}

export interface CropDetection {
  box: [number, number, number, number];
  score: number;
  label: string;
  source: "crop";
}

export interface CropDetectionFrame {
  tMs: number;
  detections: CropDetection[];
}

export interface CropAdmissionResult {
  admitted: CropDetectionFrame[];
  rejectedBelowFloor: number;
  rejectedFarFromWrist: number;
  rejectedFpFamily: number;
}

/**
 * Gate crop-sourced detections before they may extend tracks:
 *  1. score floor (existing 0.08),
 *  2. wrist proximity — a crop candidate not near ANY conditioning wrist is
 *     one of the measured 29.5 junk boxes/frame,
 *  3. FP-family suppression — the shorts/leg + court-line family (measured
 *     up to 0.53 conf, STRONGER than some true edge-on recoveries, so the
 *     score floor cannot carry this).
 */
export function admitCropDetections(
  cropFrames: readonly CropDetectionFrame[],
  wrists: WristSeries,
  video: { width: number; height: number },
): CropAdmissionResult {
  const result: CropAdmissionResult = {
    admitted: [],
    rejectedBelowFloor: 0,
    rejectedFarFromWrist: 0,
    rejectedFpFamily: 0,
  };
  for (const frame of cropFrames) {
    const frameWrists = nearestWristEntry(wrists, frame.tMs);
    const kept: CropDetection[] = [];
    for (const detection of frame.detections) {
      if (detection.score < CROP_RECOVERY_GATES.scoreFloor) {
        result.rejectedBelowFloor += 1;
        continue;
      }
      const normalized = normalizeCropBox(detection.box, video);
      if (!frameWrists || !nearAnyWrist(normalized, frameWrists)) {
        result.rejectedFarFromWrist += 1;
        continue;
      }
      if (isFpFamily(normalized, frameWrists)) {
        result.rejectedFpFamily += 1;
        continue;
      }
      kept.push({ ...detection, source: "crop" });
    }
    if (kept.length > 0) result.admitted.push({ tMs: frame.tMs, detections: kept });
  }
  return result;
}

/** Known FP family (W12): court-line slivers and shorts/leg boxes. */
export function isFpFamily(
  box: { x: number; y: number; width: number; height: number },
  frameWrists: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  const aspect = Math.max(
    box.width / Math.max(1e-6, box.height),
    box.height / Math.max(1e-6, box.width),
  );
  if (aspect > CROP_RECOVERY_GATES.fpMaxAspectRatio) return true;
  const belowEveryWrist = frameWrists.every(
    (wrist) => box.y > wrist.y + CROP_RECOVERY_GATES.fpBelowWristMargin,
  );
  return belowEveryWrist;
}

/**
 * Merge ADMITTED crop detections into the raw detection file so the existing
 * two-stage tracker consumes them. Each carries source="crop"; the tracker
 * lets crop detections EXTEND tracks but never START them, which is what
 * keeps them out of selection as raw candidates.
 */
export function mergeCropDetectionsIntoFile(
  file: RawPaddleDetectionFile,
  admitted: readonly CropDetectionFrame[],
): RawPaddleDetectionFile {
  const byTime = new Map(admitted.map((frame) => [frame.tMs, frame.detections]));
  const seen = new Set<number>();
  const frames = file.frames.map((frame) => {
    const extra = byTime.get(frame.tMs);
    if (!extra) return frame;
    seen.add(frame.tMs);
    return { ...frame, detections: [...frame.detections, ...extra] };
  });
  const unseen = admitted
    .filter((frame) => !seen.has(frame.tMs))
    .map((frame) => ({ tMs: frame.tMs, detections: [...frame.detections], extras: [] }));
  const merged = [...frames, ...unseen].sort((a, b) => a.tMs - b.tMs);
  return { ...file, frames: merged };
}

/**
 * TRACKED_ESTIMATE bridge: linearly interpolate across holes of at most
 * `maxBridgeFrames` MISSING frames. Estimates are flagged
 * source="tracked_estimate" and must never be presented as detections;
 * holes of 3+ frames stay holes (measured: propagation cannot solve the
 * edge-on carry; only residual blur holes are bridgeable).
 */
export function bridgeTrackedEstimates(
  observations: readonly TrackedPaddleObservation[],
  frameIntervalMs: number,
): TrackedPaddleObservation[] {
  const out: TrackedPaddleObservation[] = [];
  for (let index = 0; index < observations.length; index += 1) {
    const current = observations[index]!;
    out.push(current);
    const next = observations[index + 1];
    if (!next) continue;
    const gapMs = next.timestampMs - current.timestampMs;
    const missing = Math.round(gapMs / frameIntervalMs) - 1;
    if (missing < 1 || missing > CROP_RECOVERY_GATES.maxBridgeFrames) continue;
    for (let step = 1; step <= missing; step += 1) {
      const fraction = step / (missing + 1);
      const box = {
        x: lerp(current.box.x, next.box.x, fraction),
        y: lerp(current.box.y, next.box.y, fraction),
        width: lerp(current.box.width, next.box.width, fraction),
        height: lerp(current.box.height, next.box.height, fraction),
      };
      out.push({
        timestampMs: Math.round(current.timestampMs + gapMs * fraction),
        box,
        center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        detectorScore: 0,
        trackId: current.trackId,
        confidence: Math.min(current.confidence, next.confidence) * 0.5,
        nearWrist: false,
        source: "tracked_estimate",
      });
    }
  }
  return out;
}

function lerp(a: number, b: number, fraction: number): number {
  return a + (b - a) * fraction;
}

function normalizeCropBox(
  box: [number, number, number, number],
  video: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: box[0] / video.width,
    y: box[1] / video.height,
    width: (box[2] - box[0]) / video.width,
    height: (box[3] - box[1]) / video.height,
  };
}

function nearAnyWrist(
  box: { x: number; y: number; width: number; height: number },
  frameWrists: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return frameWrists.some(
    (wrist) => Math.hypot(wrist.x - cx, wrist.y - cy) <= CROP_RECOVERY_GATES.wristGateRadius,
  );
}

function nearestWristEntry(
  wrists: WristSeries,
  timestampMs: number,
): Array<{ x: number; y: number }> | null {
  let best: WristSeries[number] | null = null;
  let bestDelta = Infinity;
  for (const entry of wrists) {
    const delta = Math.abs(entry.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  // ±150ms carry for missing joints (W12 probe policy).
  return best && bestDelta <= 150 && best.wrists.length > 0 ? best.wrists : null;
}
