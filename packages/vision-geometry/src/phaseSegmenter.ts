import type {
  PaddleFrame,
  PhaseSpan,
  PoseFrame,
  PoseLandmarkName,
  Result,
} from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import {
  gridAlignedTimestamps,
  nominalFrameIntervalMs,
  positionalNoiseSigma,
} from "@pickle/swing-domain";
import type { IPhaseSegmenter, StrokeEvent } from "@pickle/vision-contracts";
import {
  distance,
  landmark,
  mean,
  median,
  movingAverage,
  pathLength,
  speedSeries,
  type Point,
  type TimedSample,
} from "./kinematics.js";

/**
 * Deterministic stroke-phase segmentation from wrist kinematics.
 *
 * The swinging wrist's speed profile over a stroke window has one dominant
 * peak (contact neighborhood for paddle sports). Phases are cut at measured
 * speed landmarks around that peak — no learned model, no invented frames:
 *   ready | prepare (speed rises past noise) | accelerate (run-up to peak) |
 *   contact (peak ± one sample) | follow_through (decay to quiet) | recover.
 *
 * Abstains (`low_confidence`) when the profile has no distinct peak or too few
 * measured frames, instead of guessing.
 *
 * Sampling robustness (randomized-fuzz XCF-09 / XCF-10): the speed profile
 * is read on the frame GRID rather than the raw device clock, and "distinct
 * peak" is judged against the measured positional noise of the estimator:
 *
 *  - Frame timestamps carry sub-frame capture/inference jitter. A central
 *    difference divided by the jittered Δt moves the peak sample and the
 *    contact by whole frames for perturbations far below one interval. The
 *    derivative is therefore taken on the grid-aligned clock (integer frame
 *    steps on a least-squares fit; gaps stay gaps), which is invariant to
 *    such jitter, while every reported boundary is the RAW timestamp of the
 *    measured frame it lands on — nothing is resampled or invented.
 *  - Estimator noise inflates both the quiet median and any single noisy
 *    peak sample; a single sample whose noise happens to align with the true
 *    motion can outgrow the median, so "peak ≥ 2 × quiet" was a knife-edge
 *    that MORE noise could push across in the committing direction. The
 *    decision now uses the SMOOTHED local maximum and adds a floor and a
 *    margin proportional to the noise-equivalent speed (torso-landmark
 *    roughness → σ; noise speed ≈ √π·σ / 2Δt). The threshold then grows at
 *    least three times as fast with noise as the smoothed peak can, so the
 *    segment/abstain decision is monotone in the noise level. On a clean
 *    stream σ is 0 and the decision is unchanged.
 *  - The contact SAMPLE is the frame that closes the fastest frame-to-frame
 *    displacement inside the smoothed peak's neighbourhood (approach speed).
 *    The chord-length central difference under-reads the frame where the
 *    wrist changes direction at contact (prev→next spans the corner), which
 *    used to pull the raw peak one or two frames early and then required
 *    the recorded trigger instant to be snapped in on a raw-clock tolerance
 *    — a decision that sub-frame clock jitter could flip by whole frames.
 *    The recorded instant now only localizes WHICH peak is the stroke; the
 *    sample itself is measured on the grid.
 */
export class GeometricPhaseSegmenter implements IPhaseSegmenter {
  public readonly modelVersion = "phase-geometry-1";
  public readonly source = "real" as const;

  private readonly aspectRatio: number;

  public constructor(options: { aspectRatio: number }) {
    this.aspectRatio = options.aspectRatio;
  }

  public async segmentPhases(
    poseFrames: PoseFrame[],
    _paddleFrames: PaddleFrame[],
    stroke: StrokeEvent,
  ): Promise<Result<PhaseSpan[]>> {
    const windowFrames = poseFrames.filter(
      (frame) => frame.timestampMs >= stroke.startMs && frame.timestampMs <= stroke.endMs,
    );
    if (windowFrames.length < 6) {
      return fail(
        failure(
          "low_confidence",
          "phase.too_few_pose_frames",
          `Only ${windowFrames.length} measured pose frames inside the stroke window; at least 6 are required.`,
        ),
      );
    }

    // The swinging hand is the wrist that travels farthest inside the window —
    // measured, not assumed from handedness.
    const wrist = this.swingingWrist(windowFrames, stroke);

    // Kinematics are read on the frame grid; boundaries are reported on the
    // raw clock of the frame they land on.
    const rawTimestamps = windowFrames.map((frame) => frame.timestampMs);
    const alignedTimestamps = gridAlignedTimestamps(rawTimestamps) ?? rawTimestamps;
    const rawByAligned = new Map<number, number>();
    const alignedFrames: PoseFrame[] = windowFrames.map((frame, index) => {
      const aligned = alignedTimestamps[index] ?? frame.timestampMs;
      rawByAligned.set(aligned, frame.timestampMs);
      return { ...frame, timestampMs: aligned };
    });
    const rawTimeOf = (alignedMs: number): number => rawByAligned.get(alignedMs) ?? alignedMs;

    const rawSpeeds = speedSeries(alignedFrames, wrist, this.aspectRatio);
    if (rawSpeeds.length < 4) {
      return fail(
        failure(
          "low_confidence",
          "phase.wrist_not_tracked",
          "The swinging wrist was not measured on enough frames to segment phases.",
        ),
      );
    }
    const speeds: TimedSample[] = rawSpeeds.map((sample, index) => ({
      timestampMs: sample.timestampMs,
      value:
        movingAverage(
          rawSpeeds.map((s) => s.value),
          5,
        )[index] ?? sample.value,
    }));

    const sampleIntervalMs = mean(
      speeds
        .slice(1)
        .map((sample, index) => sample.timestampMs - (speeds[index]?.timestampMs ?? 0)),
    );

    // Region on the smoothed curve; event at the approach-speed maximum inside
    // that region. Smoothing localizes, the measured extremum timestamps.
    const smoothedPeakIndex = this.contactIndex(speeds, stroke.contactMs);
    const approachSpeeds = approachSpeedSeries(alignedFrames, wrist, this.aspectRatio);
    let peakIndex = smoothedPeakIndex;
    let approachBest = -1;
    for (
      let index = Math.max(0, smoothedPeakIndex - 3);
      index <= Math.min(approachSpeeds.length - 1, smoothedPeakIndex + 3);
      index += 1
    ) {
      const sample = approachSpeeds[index];
      if (sample && sample.value > approachBest) {
        approachBest = sample.value;
        peakIndex = index;
      }
    }
    const peak = speeds[peakIndex];
    const smoothedPeak = speeds[smoothedPeakIndex];
    if (!peak || !smoothedPeak) {
      return fail(
        failure("low_confidence", "phase.no_peak", "No speed peak found in the stroke window."),
      );
    }
    const noiseSpeed = this.noiseEquivalentSpeed(poseFrames);
    const quietSpeed = Math.max(median(speeds.map((sample) => sample.value)), noiseSpeed);
    const distinctFloor = Math.max(quietSpeed * 2 + noiseSpeed * NOISE_MARGIN_MULTIPLE, 1e-6);
    if (smoothedPeak.value < distinctFloor) {
      return fail(
        failure(
          "low_confidence",
          "phase.no_distinct_stroke",
          "Wrist motion has no distinct stroke peak; the window looks like idle movement.",
        ),
      );
    }

    // Walk outward from the peak along measured speed landmarks.
    let accelerateStart = peakIndex;
    while (accelerateStart > 0) {
      const sample = speeds[accelerateStart - 1];
      if (!sample || sample.value < peak.value * 0.25) break;
      accelerateStart -= 1;
    }
    let followEnd = peakIndex;
    while (followEnd < speeds.length - 1) {
      const sample = speeds[followEnd + 1];
      if (!sample || sample.value < peak.value * 0.2) break;
      followEnd += 1;
    }
    // Preparation spans the whole backswing including the paddle-set hold, so
    // brief quiet moments (< SET_HOLD_MS) are bridged; only sustained
    // stillness — the ready stance — ends the walk.
    const SET_HOLD_MS = 300;
    let prepareStart = accelerateStart;
    let quietRunEndTs: number | null = null;
    for (let index = accelerateStart - 1; index >= 0; index -= 1) {
      const sample = speeds[index];
      if (!sample) break;
      if (sample.value >= peak.value * 0.1) {
        prepareStart = index;
        quietRunEndTs = null;
      } else {
        quietRunEndTs = quietRunEndTs ?? sample.timestampMs;
        if (quietRunEndTs - sample.timestampMs >= SET_HOLD_MS) break;
      }
    }

    const timeAt = (index: number): number => {
      const sample = speeds[Math.min(Math.max(index, 0), speeds.length - 1)];
      return sample ? rawTimeOf(sample.timestampMs) : stroke.startMs;
    };

    const halfSample = Math.max(8, sampleIntervalMs / 2);
    const confidence = this.trackingConfidence(windowFrames);

    const contactMs = rawTimeOf(peak.timestampMs);
    const boundaries = {
      prepareStart: timeAt(prepareStart),
      accelerateStart: timeAt(accelerateStart),
      contactStart: contactMs - halfSample,
      contactEnd: contactMs + halfSample,
      followEnd: timeAt(followEnd),
    };

    const spans: PhaseSpan[] = [
      span("ready", stroke.startMs, boundaries.prepareStart, confidence),
      span("prepare", boundaries.prepareStart, boundaries.accelerateStart, confidence),
      span("accelerate", boundaries.accelerateStart, boundaries.contactStart, confidence),
      {
        key: "contact",
        startMs: boundaries.contactStart,
        representativeMs: contactMs,
        endMs: boundaries.contactEnd,
        confidence,
      },
      span("follow_through", boundaries.contactEnd, boundaries.followEnd, confidence),
      span("recover", boundaries.followEnd, stroke.endMs, confidence),
    ];

    // Guarantee ordered, non-negative spans even at the window edges.
    let cursor = stroke.startMs;
    for (const entry of spans) {
      entry.startMs = Math.max(entry.startMs, cursor);
      entry.endMs = Math.max(entry.endMs, entry.startMs);
      entry.representativeMs = Math.min(
        Math.max(entry.representativeMs, entry.startMs),
        entry.endMs,
      );
      cursor = entry.endMs;
    }
    return ok(spans);
  }

  private swingingWrist(
    frames: readonly PoseFrame[],
    stroke: StrokeEvent,
  ): "left_wrist" | "right_wrist" {
    const left = pathLength(frames, "left_wrist", stroke.startMs, stroke.endMs, this.aspectRatio);
    const right = pathLength(frames, "right_wrist", stroke.startMs, stroke.endMs, this.aspectRatio);
    return right >= left ? "right_wrist" : "left_wrist";
  }

  private contactIndex(speeds: readonly TimedSample[], hintMs: number | null): number {
    let globalIndex = 0;
    let globalValue = -1;
    speeds.forEach((sample, index) => {
      if (sample.value > globalValue) {
        globalValue = sample.value;
        globalIndex = index;
      }
    });
    if (hintMs === null) return globalIndex;
    // Snap the recorded contact hint to the nearest local speed maximum when
    // one exists within 120ms; the global peak wins otherwise.
    let hintedIndex: number | null = null;
    let hintedValue = -1;
    speeds.forEach((sample, index) => {
      if (Math.abs(sample.timestampMs - hintMs) > 120) return;
      if (sample.value > hintedValue) {
        hintedValue = sample.value;
        hintedIndex = index;
      }
    });
    return hintedIndex ?? globalIndex;
  }

  private trackingConfidence(frames: readonly PoseFrame[]): number {
    const frameConfidence = mean(frames.map((frame) => frame.confidence));
    return Math.min(1, Math.max(0, frameConfidence));
  }

  /**
   * Speed (units/s) that pure estimator noise produces in a central
   * difference over two frame intervals: the displacement of two independent
   * noisy points has per-axis variance 2σ², a Rayleigh magnitude with mean
   * σ√2·√(π/2) = σ√π, divided by 2Δt. Zero when the stream is too short to
   * measure its noise — absence of measurement is not evidence of noise.
   */
  private noiseEquivalentSpeed(frames: readonly PoseFrame[]): number {
    const interval = nominalFrameIntervalMs(frames.map((frame) => frame.timestampMs));
    if (interval === null || interval <= 0) return 0;
    const sigma = positionalNoiseSigma(frames, this.aspectRatio);
    if (sigma === null) return 0;
    return ((Math.sqrt(Math.PI) * sigma) / (2 * interval)) * 1000;
  }
}

/**
 * Distinct-peak margin in noise-equivalent speeds. The smoothed peak can rise
 * by at most ≈1 noise speed as noise grows (|v + n| ≤ |v| + |n|), while the
 * threshold rises by 2 (quiet floor) + this margin — monotone with room.
 */
const NOISE_MARGIN_MULTIPLE = 1;

/**
 * Approach speed at each interior tracked frame: the wrist's displacement
 * over the interval ENDING at that frame divided by that interval's
 * duration. Same tracked frames and sample indices as `speedSeries`, so the
 * two series address the same samples. The frame that closes the fastest
 * interval is the last frame of maximal approach speed — the wrist arrives
 * there at full speed and is slower afterwards — which is the contact frame
 * both for a smooth speed peak (within one frame) and for a corner where
 * the chord-length central difference under-reads the peak frame.
 */
function approachSpeedSeries(
  frames: readonly PoseFrame[],
  name: PoseLandmarkName,
  aspectRatio: number,
): TimedSample[] {
  const tracked: Array<{ timestampMs: number; point: Point }> = [];
  for (const frame of frames) {
    const point = landmark(frame, name, aspectRatio);
    if (point) tracked.push({ timestampMs: frame.timestampMs, point });
  }
  if (tracked.length < 3) return [];
  const speeds: TimedSample[] = [];
  for (let index = 1; index < tracked.length - 1; index += 1) {
    const previous = tracked[index - 1];
    const current = tracked[index];
    if (!previous || !current) continue;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0) continue;
    speeds.push({
      timestampMs: current.timestampMs,
      value: (distance(previous.point, current.point) / dtMs) * 1000,
    });
  }
  return speeds;
}

function span(
  key: PhaseSpan["key"],
  startMs: number,
  endMs: number,
  confidence: number,
): PhaseSpan {
  const orderedEnd = Math.max(startMs, endMs);
  return {
    key,
    startMs,
    endMs: orderedEnd,
    representativeMs: startMs + (orderedEnd - startMs) / 2,
    confidence,
  };
}
