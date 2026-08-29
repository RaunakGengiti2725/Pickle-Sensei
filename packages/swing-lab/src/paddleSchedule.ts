import type { PaddleTrackCandidate, RawPaddleDetectionFile } from "./paddleTracker.js";

/**
 * Adaptive two-pass paddle detector schedule (HANDOFF_V3 §6 item 4).
 *
 * Static stride-3 was INVALIDATED downstream (H: contact-zone track death,
 * selection-margin erosion). The adaptive answer keeps the sparse scan but
 * buys density back exactly where the sparse pass shows it is needed:
 *
 *   pass 1 (sparse, stride N): whole detect span — locates the paddle
 *     trajectory and the action region cheaply.
 *   pass 2 (dense, stride 1): only around (a) event peaks, (b) track
 *     uncertainty (low-confidence observations + track birth/death inside
 *     the span), (c) high paddle-speed change, (d) missing frames (coverage
 *     holes). (b)–(d) are computed on the PRIMARY (densest) sparse candidate
 *     only — background/crowd tracks are permanently noisy and would densify
 *     the whole span.
 *
 * Everything here is a pure plan over the sparse artifacts — no detector or
 * video access — so it is unit-testable on Linux. The provenance record says
 * exactly which frame ran in which pass; nothing is inferred after the fact.
 */

export const PADDLE_SCHEDULE_VERSION = "paddle-two-pass-1";

export interface TwoPassScheduleConfig {
  /** Pass-1 stride (frames). */
  sparseStride: number;
  /** Dense pad around each event peak (contact scope; H recommendation). */
  eventPeakPadMs: number;
  /** Dense pad around uncertainty/speed-change anchors. */
  anchorPadMs: number;
  /** Primary-track observation confidence below this is an uncertainty
   *  anchor. The heuristic confidence is uncalibrated (~0.3–0.7 typical on
   *  real tracks), so this flags only the clearly-degraded tail. */
  lowConfidence: number;
  /** |Δspeed| ≥ factor × median |Δspeed| is a speed-change anchor. */
  speedChangeFactor: number;
  /** A hole in sparse track coverage longer than this many sparse frame
   *  intervals is a missing-frames region. */
  missingGapFactor: number;
}

export const DEFAULT_TWO_PASS_CONFIG: TwoPassScheduleConfig = {
  sparseStride: 3,
  eventPeakPadMs: 450,
  anchorPadMs: 150,
  lowConfidence: 0.3,
  speedChangeFactor: 2.5,
  missingGapFactor: 2.5,
};

export type DenseReason =
  "event_peak" | "track_uncertainty" | "paddle_speed_change" | "missing_frames";

export interface DenseRegion {
  startMs: number;
  endMs: number;
  reasons: DenseReason[];
}

export interface TwoPassSchedule {
  version: typeof PADDLE_SCHEDULE_VERSION;
  config: TwoPassScheduleConfig;
  detectSpan: { startMs: number; endMs: number };
  frameIntervalMs: number;
  sparse: { stride: number; plannedFrames: number };
  denseRegions: DenseRegion[];
  /** Planned frame accounting vs a full stride-1 scan of the span. */
  planned: {
    fullScanFrames: number;
    sparseFrames: number;
    denseOnlyFrames: number;
    totalFrames: number;
  };
}

export interface TwoPassScheduleInput {
  detectSpan: { startMs: number; endMs: number };
  /** 1000 / fps of the (CFR) video. */
  frameIntervalMs: number;
  /** Densest sparse candidate — null when the sparse pass tracked nothing. */
  primaryTrack: PaddleTrackCandidate | null;
  /** Paddle-speed series of the primary candidate. */
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  /** Kinematic event peaks (pose pre-pass or sparse-pass refinement). */
  eventPeaksMs: readonly number[];
  config?: Partial<TwoPassScheduleConfig>;
}

interface Anchor {
  atMs: number;
  padMs: number;
  reason: DenseReason;
}

export function planTwoPassSchedule(input: TwoPassScheduleInput): TwoPassSchedule {
  const config: TwoPassScheduleConfig = { ...DEFAULT_TWO_PASS_CONFIG, ...input.config };
  const { detectSpan, frameIntervalMs } = input;
  const anchors: Anchor[] = [];
  const regions: DenseRegion[] = [];

  for (const peakMs of input.eventPeaksMs) {
    anchors.push({ atMs: peakMs, padMs: config.eventPeakPadMs, reason: "event_peak" });
  }

  const spanStart = detectSpan.startMs;
  const spanEnd = detectSpan.endMs;
  const edgeTolerance = config.sparseStride * frameIntervalMs * 1.5;
  const observations = input.primaryTrack?.observations ?? [];
  if (observations.length > 0) {
    const first = observations[0]!.timestampMs;
    const last = observations[observations.length - 1]!.timestampMs;
    // Track birth/death INSIDE the span means the sparse pass lost (or found)
    // the paddle mid-action — exactly the H failure mode (track death at the
    // fastest motion). Ends at the span edge are just the window boundary.
    if (first - spanStart > edgeTolerance) {
      anchors.push({ atMs: first, padMs: config.anchorPadMs, reason: "track_uncertainty" });
    }
    if (spanEnd - last > edgeTolerance) {
      anchors.push({ atMs: last, padMs: config.anchorPadMs, reason: "track_uncertainty" });
    }
    for (const observation of observations) {
      if (observation.confidence < config.lowConfidence) {
        anchors.push({
          atMs: observation.timestampMs,
          padMs: config.anchorPadMs,
          reason: "track_uncertainty",
        });
      }
    }
  }

  if (input.paddleSpeeds && input.paddleSpeeds.length >= 3) {
    const deltas: Array<{ atMs: number; magnitude: number }> = [];
    for (let index = 1; index < input.paddleSpeeds.length; index += 1) {
      const previous = input.paddleSpeeds[index - 1]!;
      const current = input.paddleSpeeds[index]!;
      deltas.push({
        atMs: (previous.timestampMs + current.timestampMs) / 2,
        magnitude: Math.abs(current.value - previous.value),
      });
    }
    const sorted = deltas.map((delta) => delta.magnitude).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const threshold = median * config.speedChangeFactor;
    if (threshold > 0) {
      for (const delta of deltas) {
        if (delta.magnitude >= threshold) {
          anchors.push({
            atMs: delta.atMs,
            padMs: config.anchorPadMs,
            reason: "paddle_speed_change",
          });
        }
      }
    }
  }

  // Missing frames: holes in the primary track's observation coverage.
  const covered = observations
    .map((observation) => observation.timestampMs)
    .filter((tMs) => tMs >= spanStart && tMs <= spanEnd)
    .sort((a, b) => a - b);
  const maxGapMs = config.missingGapFactor * config.sparseStride * frameIntervalMs;
  if (covered.length > 0) {
    for (let index = 1; index < covered.length; index += 1) {
      const gapStart = covered[index - 1]!;
      const gapEnd = covered[index]!;
      if (gapEnd - gapStart > maxGapMs) {
        regions.push({ startMs: gapStart, endMs: gapEnd, reasons: ["missing_frames"] });
      }
    }
  }

  for (const anchor of anchors) {
    regions.push({
      startMs: anchor.atMs - anchor.padMs,
      endMs: anchor.atMs + anchor.padMs,
      reasons: [anchor.reason],
    });
  }

  const denseRegions = mergeRegions(regions, detectSpan, frameIntervalMs, spanStart);

  const spanFrames = frameCount(spanStart, spanEnd, frameIntervalMs, 1);
  const sparseFrames = frameCount(spanStart, spanEnd, frameIntervalMs, config.sparseStride);
  const denseOnlyFrames = denseRegions.reduce((total, region) => {
    const frames = frameCount(region.startMs, region.endMs, frameIntervalMs, 1);
    const alreadySparse = sparseFramesInside(
      region,
      spanStart,
      frameIntervalMs,
      config.sparseStride,
    );
    return total + Math.max(0, frames - alreadySparse);
  }, 0);

  return {
    version: PADDLE_SCHEDULE_VERSION,
    config,
    detectSpan: { startMs: spanStart, endMs: spanEnd },
    frameIntervalMs,
    sparse: { stride: config.sparseStride, plannedFrames: sparseFrames },
    denseRegions,
    planned: {
      fullScanFrames: spanFrames,
      sparseFrames,
      denseOnlyFrames,
      totalFrames: sparseFrames + denseOnlyFrames,
    },
  };
}

/** Clamp to the span, snap boundaries onto the pass-1 frame grid (so dense
 *  timestamps land on the same CFR grid as the sparse pass), and merge
 *  overlapping/adjacent regions, unioning their reasons. */
function mergeRegions(
  regions: DenseRegion[],
  span: { startMs: number; endMs: number },
  frameIntervalMs: number,
  gridOriginMs: number,
): DenseRegion[] {
  const snapped = regions
    .map((region) => ({
      startMs: snapDown(Math.max(span.startMs, region.startMs), gridOriginMs, frameIntervalMs),
      endMs: snapUp(Math.min(span.endMs, region.endMs), gridOriginMs, frameIntervalMs),
      reasons: [...region.reasons],
    }))
    .filter((region) => region.endMs > region.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: DenseRegion[] = [];
  for (const region of snapped) {
    const previous = merged[merged.length - 1];
    if (previous && region.startMs <= previous.endMs + frameIntervalMs) {
      previous.endMs = Math.max(previous.endMs, region.endMs);
      for (const reason of region.reasons) {
        if (!previous.reasons.includes(reason)) previous.reasons.push(reason);
      }
    } else {
      merged.push(region);
    }
  }
  return merged;
}

function snapDown(tMs: number, originMs: number, frameIntervalMs: number): number {
  return originMs + Math.floor((tMs - originMs) / frameIntervalMs) * frameIntervalMs;
}

function snapUp(tMs: number, originMs: number, frameIntervalMs: number): number {
  return originMs + Math.ceil((tMs - originMs) / frameIntervalMs) * frameIntervalMs;
}

function frameCount(
  startMs: number,
  endMs: number,
  frameIntervalMs: number,
  stride: number,
): number {
  if (endMs <= startMs) return 0;
  return Math.floor((endMs - startMs) / (frameIntervalMs * stride)) + 1;
}

function sparseFramesInside(
  region: { startMs: number; endMs: number },
  gridOriginMs: number,
  frameIntervalMs: number,
  stride: number,
): number {
  const strideMs = frameIntervalMs * stride;
  const firstIndex = Math.ceil((region.startMs - gridOriginMs) / strideMs);
  const lastIndex = Math.floor((region.endMs - gridOriginMs) / strideMs);
  return Math.max(0, lastIndex - firstIndex + 1);
}

/** Which pass produced each merged frame — the provenance record. */
export interface SchedulePassRecord {
  tMs: number;
  pass: "sparse" | "dense";
}

export interface MergedDetectionResult {
  file: RawPaddleDetectionFile;
  passes: SchedulePassRecord[];
}

/**
 * Merge the sparse-pass detection file with the dense-region files into one
 * artifact for the tracker. Near-duplicate frames (same CFR grid slot, seen
 * by both passes) keep the DENSE copy; frames are sorted by timestamp. The
 * detector block is the sparse pass's with the realized schedule attached.
 */
export function mergePaddleDetectionFiles(
  sparse: RawPaddleDetectionFile,
  dense: readonly RawPaddleDetectionFile[],
  schedule: TwoPassSchedule,
): MergedDetectionResult {
  const halfFrame = schedule.frameIntervalMs / 2;
  type Frame = RawPaddleDetectionFile["frames"][number];
  const slots = new Map<number, { frame: Frame; pass: "sparse" | "dense" }>();
  const slot = (tMs: number): number => Math.round(tMs / halfFrame / 2);
  for (const frame of sparse.frames) {
    slots.set(slot(frame.tMs), { frame, pass: "sparse" });
  }
  for (const file of dense) {
    for (const frame of file.frames) {
      slots.set(slot(frame.tMs), { frame, pass: "dense" });
    }
  }
  const ordered = [...slots.values()].sort((a, b) => a.frame.tMs - b.frame.tMs);
  const framesProcessed =
    sparse.timing.framesProcessed +
    dense.reduce((total, file) => total + file.timing.framesProcessed, 0);
  const inferenceSecTotal =
    sparse.timing.inferenceSecTotal +
    dense.reduce((total, file) => total + file.timing.inferenceSecTotal, 0);
  const file: RawPaddleDetectionFile = {
    ...sparse,
    detector: { ...sparse.detector },
    timing: {
      ...sparse.timing,
      framesProcessed,
      inferenceSecTotal: Number(inferenceSecTotal.toFixed(3)),
      inferenceMsPerFrame: Number(
        ((1000 * inferenceSecTotal) / Math.max(1, framesProcessed)).toFixed(1),
      ),
      wallSecTotal: Number(
        (
          sparse.timing.wallSecTotal +
          dense.reduce((total, entry) => total + entry.timing.wallSecTotal, 0)
        ).toFixed(3),
      ),
    },
    frames: ordered.map((entry) => entry.frame),
  };
  return {
    file,
    passes: ordered.map((entry) => ({ tMs: entry.frame.tMs, pass: entry.pass })),
  };
}
