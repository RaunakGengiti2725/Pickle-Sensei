import type { PaddleFrame, PhaseSpan, PoseFrame, Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type { IPhaseSegmenter, StrokeEvent } from "@pickle/vision-contracts";
import {
  mean,
  median,
  movingAverage,
  pathLength,
  speedSeries,
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
 */
export class GeometricPhaseSegmenter implements IPhaseSegmenter {
  public readonly modelVersion = "phase-geometry-2";
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

    // Phases describe measured motion, so their outer edges are the first and
    // last measured frame — never the requested window, which for an imported
    // clip is the whole file.
    let measuredStartMs = Number.POSITIVE_INFINITY;
    let measuredEndMs = Number.NEGATIVE_INFINITY;
    for (const frame of windowFrames) {
      measuredStartMs = Math.min(measuredStartMs, frame.timestampMs);
      measuredEndMs = Math.max(measuredEndMs, frame.timestampMs);
    }

    // The swinging hand is the wrist that travels farthest inside the window —
    // measured, not assumed from handedness.
    const wrist = this.swingingWrist(windowFrames, stroke);
    const rawSpeeds = speedSeries(windowFrames, wrist, this.aspectRatio);
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

    // Region on the smoothed curve; event at the raw instantaneous maximum
    // inside that region. Smoothing localizes, the raw extremum timestamps.
    const smoothedPeakIndex = this.contactIndex(speeds, stroke.contactMs);
    let peakIndex = smoothedPeakIndex;
    let rawBest = -1;
    for (
      let index = Math.max(0, smoothedPeakIndex - 3);
      index <= Math.min(rawSpeeds.length - 1, smoothedPeakIndex + 3);
      index += 1
    ) {
      const raw = rawSpeeds[index];
      if (raw && raw.value > rawBest) {
        rawBest = raw.value;
        peakIndex = index;
      }
    }

    // The recorded trigger measured contact on-device at capture time. When
    // the speed peak agrees with it to within about one sample, the recorded
    // event is the better sub-frame estimate — central differences smear the
    // peak across the junction. Only a clear disagreement overrides it.
    if (stroke.contactMs !== null) {
      const hint = stroke.contactMs;
      const rawPeakTs = rawSpeeds[peakIndex]?.timestampMs;
      if (rawPeakTs !== undefined && Math.abs(rawPeakTs - hint) <= sampleIntervalMs * 1.5) {
        let nearest = peakIndex;
        let nearestDelta = Number.POSITIVE_INFINITY;
        speeds.forEach((sample, index) => {
          const delta = Math.abs(sample.timestampMs - hint);
          if (delta < nearestDelta) {
            nearestDelta = delta;
            nearest = index;
          }
        });
        peakIndex = nearest;
      }
    }
    const peak = speeds[peakIndex];
    if (!peak) {
      return fail(
        failure("low_confidence", "phase.no_peak", "No speed peak found in the stroke window."),
      );
    }
    const quietSpeed = median(speeds.map((sample) => sample.value));
    if (peak.value < Math.max(quietSpeed * 2, 1e-6)) {
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

    const timeAt = (index: number): number =>
      speeds[Math.min(Math.max(index, 0), speeds.length - 1)]?.timestampMs ?? measuredStartMs;

    const halfSample = Math.max(8, sampleIntervalMs / 2);
    const confidence = this.trackingConfidence(windowFrames);

    const contactMs = peak.timestampMs;
    const boundaries = {
      prepareStart: timeAt(prepareStart),
      accelerateStart: timeAt(accelerateStart),
      contactStart: contactMs - halfSample,
      contactEnd: contactMs + halfSample,
      followEnd: timeAt(followEnd),
    };

    const spans: PhaseSpan[] = [
      span("ready", measuredStartMs, boundaries.prepareStart, confidence),
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
      span("recover", boundaries.followEnd, measuredEndMs, confidence),
    ];

    // Guarantee ordered, non-negative spans bounded by the measured frames.
    let cursor = measuredStartMs;
    for (const entry of spans) {
      entry.startMs = Math.min(Math.max(entry.startMs, cursor), measuredEndMs);
      entry.endMs = Math.min(Math.max(entry.endMs, entry.startMs), measuredEndMs);
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
