import type { PaddleFrame, PhaseSpan, PoseFrame, Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type { IPhaseSegmenter, StrokeEvent, VideoClipRef } from "@pickle/vision-contracts";
import {
  distance,
  frameNearest,
  landmark,
  mean,
  median,
  midpoint,
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
 *   ready | prepare (backswing up to the paddle-set dip) | accelerate (the
 *   forward run-up from the dip to the peak) | contact proxy (peak ± half a
 *   sample) | follow_through (decay to quiet).
 *
 * phase-geometry-3 makes the segmentation ROBUST to real captures instead of
 * abstaining on them (2026-09-10 field failure: "Acceleration and
 * contact-proxy observations are required" on a live swing):
 *
 * - Every emitted boundary is a WHOLE millisecond and every representative
 *   frame is an observed frame timestamp. The v2 contact proxy was cut at
 *   peak ± half a (fractional) sample interval and the sync ingress refused
 *   the whole read (`shot.invalid_payload`).
 * - `accelerate` and `contact` are guaranteed whenever a peak exists: the
 *   run-up always includes the sample before the peak (or the first observed
 *   frame when the peak is the first sample), so a window that opens
 *   mid-swing, or a wrist that reappears from behind the body right at the
 *   forward swing, still segments.
 * - `prepare` always includes the sample before the run-up when one exists —
 *   a stroke with no visible backswing is measured as a SHORT backswing, not
 *   left unobserved.
 * - The run-up starts at the last speed DIP before the peak (the paddle-set
 *   reversal), not at 25% of the peak: a brisk backswing is preparation, not
 *   acceleration.
 * - Analysis reads CONTEXT frames around the trigger window (the capture's
 *   own pre-roll/post-roll) so ready and follow-through can be measured when
 *   the trigger window starts or ends on the motion itself. The peak is
 *   still chosen inside the trigger window.
 * - The peak is the FASTEST candidate whose run-up actually carried the
 *   wrist somewhere (body-relative travel): a label swap or a jitter spike
 *   is skipped, never mistaken for contact and never a reason to refuse a
 *   read that holds a real swing behind it.
 * - A window that is mostly swing (peak < 2× the window median) is no longer
 *   "idle movement": it lowers the phases' confidence. The segmenter abstains
 *   only when nothing measurable exists — too few frames anywhere, a wrist
 *   never tracked, or a wrist that does not move at all.
 */
export class GeometricPhaseSegmenter implements IPhaseSegmenter {
  public readonly modelVersion = "phase-geometry-3";
  public readonly source = "real" as const;

  /** Pre-roll a capture legitimately carries before the trigger window. */
  public static readonly PRE_CONTEXT_MS = 2_000;
  /** Post-roll a capture legitimately carries after the trigger window. */
  public static readonly POST_CONTEXT_MS = 1_500;
  /** Longest ready span borrowed from before the backswing, ms. */
  public static readonly READY_CONTEXT_MS = 500;
  /** Smoothed wrist speed (image-heights/s) below which nothing moved. */
  public static readonly MIN_PEAK_SPEED = 0.05;
  /**
   * Sensor jitter on a still wrist reads as a flat speed profile (peak ≈
   * median) of small magnitude. A profile that is BOTH flatter than this
   * ratio AND slower than `JITTER_PEAK_SPEED` at its smoothed peak is
   * stillness, not a stroke. Either alone is a real stroke: a mostly-swing
   * window is flat but fast; a far, soft dink is slow but distinct against
   * its quiet context.
   */
  public static readonly JITTER_DISTINCTNESS = 1.8;
  public static readonly JITTER_PEAK_SPEED = 0.45;
  /**
   * A stroke's run-up carries the wrist a real distance: from the paddle-set
   * dip to the peak it travels at least this many torso lengths (a compact
   * volley punch covers ≈ 0.3, a drive > 1). Sensor jitter on a still wrist
   * is a zero-mean random walk whose net travel stays far below it, however
   * fast its instantaneous speed reads, and a left/right label swap jumps
   * the wrist without any run-up at all. Applied only when a torso was
   * measured (the rule is body-relative, never an image-space constant).
   */
  public static readonly MIN_RUN_UP_TRAVEL_TORSOS = 0.1;
  /** Fewest measured pose frames a segmentation can be cut from. */
  public static readonly MIN_FRAMES = 6;
  /** Fewest wrist speed samples a segmentation can be cut from. */
  public static readonly MIN_SPEED_SAMPLES = 4;

  private readonly aspectRatio: number;

  public constructor(options?: { aspectRatio: number }) {
    this.aspectRatio = options?.aspectRatio ?? Number.NaN;
  }

  public async segmentPhases(
    poseFrames: PoseFrame[],
    _paddleFrames: PaddleFrame[],
    stroke: StrokeEvent,
    video?: Pick<VideoClipRef, "width" | "height">,
  ): Promise<Result<PhaseSpan[]>> {
    const aspectRatio = video ? video.width / video.height : this.aspectRatio;
    if (
      !Number.isFinite(aspectRatio) ||
      aspectRatio <= 0 ||
      (video &&
        (!Number.isFinite(video.width) ||
          !Number.isFinite(video.height) ||
          video.width <= 0 ||
          video.height <= 0)) ||
      !Number.isFinite(stroke.startMs) ||
      !Number.isFinite(stroke.endMs) ||
      stroke.startMs < 0 ||
      stroke.endMs <= stroke.startMs ||
      poseFrames.some(
        (frame, index) =>
          !Number.isFinite(frame.timestampMs) ||
          frame.timestampMs < 0 ||
          !Number.isFinite(frame.confidence) ||
          frame.confidence < 0 ||
          frame.confidence > 1 ||
          (index > 0 && frame.timestampMs <= poseFrames[index - 1]!.timestampMs),
      )
    ) {
      return fail(
        failure(
          "low_confidence",
          "phase.invalid_observations",
          "Phase timing observations are invalid or unordered.",
        ),
      );
    }

    const inWindow = (frame: PoseFrame) =>
      frame.timestampMs >= stroke.startMs && frame.timestampMs <= stroke.endMs;
    const windowFrames = poseFrames.filter(inWindow);
    // Context: the frames a capture carries around the trigger window. Ready
    // and follow-through may extend into it; the peak never comes from it.
    const contextStart = stroke.startMs - GeometricPhaseSegmenter.PRE_CONTEXT_MS;
    const contextEnd = stroke.endMs + GeometricPhaseSegmenter.POST_CONTEXT_MS;
    let analysisFrames = poseFrames.filter(
      (frame) => frame.timestampMs >= contextStart && frame.timestampMs <= contextEnd,
    );
    // A window too thin to segment widens to everything that was measured:
    // the trigger's bounds are a hint about WHERE the stroke is, not a
    // reason to refuse frames that exist.
    if (analysisFrames.length < GeometricPhaseSegmenter.MIN_FRAMES) analysisFrames = poseFrames;
    if (analysisFrames.length < GeometricPhaseSegmenter.MIN_FRAMES) {
      return fail(
        failure(
          "low_confidence",
          "phase.too_few_pose_frames",
          `Only ${analysisFrames.length} measured pose frames around the stroke window; at least ${GeometricPhaseSegmenter.MIN_FRAMES} are required.`,
        ),
      );
    }

    // The swinging hand is the wrist that travels farthest inside the window —
    // measured, not assumed from handedness.
    const wrist = this.swingingWrist(
      windowFrames.length >= 2 ? windowFrames : analysisFrames,
      stroke,
      aspectRatio,
    );
    let rawSpeeds = speedSeries(analysisFrames, wrist, aspectRatio);
    if (
      rawSpeeds.length < GeometricPhaseSegmenter.MIN_SPEED_SAMPLES &&
      analysisFrames !== poseFrames
    ) {
      analysisFrames = poseFrames;
      rawSpeeds = speedSeries(analysisFrames, wrist, aspectRatio);
    }
    if (rawSpeeds.length < GeometricPhaseSegmenter.MIN_SPEED_SAMPLES) {
      return fail(
        failure(
          "low_confidence",
          "phase.wrist_not_tracked",
          "The swinging wrist was not measured on enough frames to segment phases.",
        ),
      );
    }
    const smoothed = movingAverage(
      rawSpeeds.map((s) => s.value),
      5,
    );
    const speeds: TimedSample[] = rawSpeeds.map((sample, index) => ({
      timestampMs: sample.timestampMs,
      value: smoothed[index] ?? sample.value,
    }));

    const sampleIntervalMs = mean(
      speeds
        .slice(1)
        .map((sample, index) => sample.timestampMs - (speeds[index]?.timestampMs ?? 0)),
    );

    // Candidate peaks: every local maximum of the smoothed curve inside the
    // trigger window (the whole span when the window holds no sample), the
    // recorded contact hint's neighbourhood first, then fastest first. The
    // stroke is the FASTEST candidate whose run-up actually carried the wrist
    // somewhere: a label swap or a jitter spike reads fast but travels
    // nowhere and is skipped, never mistaken for contact and never a reason
    // to refuse the read while a real swing sits behind it.
    const windowSample = (sample: TimedSample) =>
      sample.timestampMs >= stroke.startMs && sample.timestampMs <= stroke.endMs;
    const eligible = speeds.some(windowSample) ? windowSample : () => true;
    const quietSpeed = median(speeds.map((sample) => sample.value));
    const torso = this.medianTorso(analysisFrames, aspectRatio);
    const candidates = this.peakCandidates(speeds, stroke.contactMs, eligible);
    if (candidates.length === 0) {
      return fail(
        failure("low_confidence", "phase.no_peak", "No speed peak found in the stroke window."),
      );
    }

    let peakIndex = -1;
    let accelerateStart = -1;
    for (const candidate of candidates) {
      // Region on the smoothed curve; event at the raw instantaneous maximum
      // inside that region. Smoothing localizes, the raw extremum timestamps.
      let index = candidate;
      let rawBest = -1;
      for (
        let probe = Math.max(0, candidate - 3);
        probe <= Math.min(rawSpeeds.length - 1, candidate + 3);
        probe += 1
      ) {
        const raw = rawSpeeds[probe];
        if (raw && raw.value > rawBest && eligible(raw)) {
          rawBest = raw.value;
          index = probe;
        }
      }
      // The recorded trigger supplies a motion/contact proxy at capture time.
      // When the speed peak agrees within about one sample, its timestamp
      // helps localize the proxy despite the central-difference smoothing.
      // Agreement is not evidence of observed ball-paddle contact or
      // sub-frame accuracy.
      if (stroke.contactMs !== null) {
        const hint = stroke.contactMs;
        const rawPeakTs = rawSpeeds[index]?.timestampMs;
        if (rawPeakTs !== undefined && Math.abs(rawPeakTs - hint) <= sampleIntervalMs * 1.5) {
          let nearest = index;
          let nearestDelta = Number.POSITIVE_INFINITY;
          speeds.forEach((sample, sampleIndex) => {
            const delta = Math.abs(sample.timestampMs - hint);
            if (delta < nearestDelta) {
              nearestDelta = delta;
              nearest = sampleIndex;
            }
          });
          index = nearest;
        }
      }
      const value = speeds[index]?.value;
      if (value === undefined) continue;
      // Nothing moved: a frozen wrist, or one whose only "motion" is sensor
      // jitter (flat AND slow), is not a stroke.
      if (
        !(value >= GeometricPhaseSegmenter.MIN_PEAK_SPEED) ||
        (value / Math.max(quietSpeed, 1e-6) < GeometricPhaseSegmenter.JITTER_DISTINCTNESS &&
          value < GeometricPhaseSegmenter.JITTER_PEAK_SPEED)
      )
        continue;
      const runUpStart = this.runUpStart(speeds, index);
      // Body-relative travel: a run-up that never carries the wrist a
      // measurable distance is stillness (jitter on a resting hand, a label
      // swap), whatever its instantaneous speed reads.
      if (torso !== null) {
        const travel = this.runUpTravel(
          analysisFrames,
          wrist,
          aspectRatio,
          timeAtIndex(speeds, runUpStart, stroke.startMs),
          speeds[index]!.timestampMs,
        );
        if (travel !== null && travel < GeometricPhaseSegmenter.MIN_RUN_UP_TRAVEL_TORSOS * torso)
          continue;
      }
      peakIndex = index;
      accelerateStart = runUpStart;
      break;
    }
    if (peakIndex < 0) {
      return fail(
        failure(
          "low_confidence",
          "phase.no_motion",
          "The swinging wrist did not move inside the stroke window.",
        ),
      );
    }
    const peak = speeds[peakIndex]!;
    const distinctness = peak.value / Math.max(quietSpeed, 1e-6);

    let followEnd = peakIndex;
    while (followEnd < speeds.length - 1) {
      const sample = speeds[followEnd + 1];
      if (!sample || sample.value < peak.value * 0.2) break;
      followEnd += 1;
    }
    if (followEnd === peakIndex && peakIndex < speeds.length - 1) followEnd = peakIndex + 1;

    // Preparation spans the whole backswing including the paddle-set hold, so
    // brief quiet moments (< SET_HOLD_MS) are bridged; only sustained
    // stillness — the ready stance — ends the walk. It always keeps the
    // sample before the run-up: no visible backswing is a short backswing.
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
    if (prepareStart === accelerateStart && accelerateStart > 0) prepareStart = accelerateStart - 1;

    const timeAt = (index: number): number => timeAtIndex(speeds, index, stroke.startMs);
    const firstObserved = analysisFrames[0]!.timestampMs;
    const observedEnd = analysisFrames[analysisFrames.length - 1]!.timestampMs;

    const halfSample = Math.max(8, Math.round(sampleIntervalMs / 2));
    const confidence =
      this.trackingConfidence(windowFrames.length > 0 ? windowFrames : analysisFrames) *
      clampUnit(distinctness / 2, 0.5, 1);

    const contactMs = peak.timestampMs;
    // The run-up starts at its sample, or at the first observed frame when
    // the peak is the very first sample (no earlier sample exists).
    const accelerateStartMs =
      peakIndex === 0 ? Math.min(firstObserved, contactMs - 1) : timeAt(accelerateStart);
    const prepareStartMs =
      prepareStart < accelerateStart ? timeAt(prepareStart) : accelerateStartMs;
    // Ready: from the trigger's own start when it precedes the backswing,
    // else borrowed from the context just before the backswing began.
    const readyStartMs = Math.max(
      firstObserved,
      Math.min(stroke.startMs, prepareStartMs - GeometricPhaseSegmenter.READY_CONTEXT_MS),
    );
    const boundaries = {
      readyStart: readyStartMs,
      prepareStart: prepareStartMs,
      accelerateStart: accelerateStartMs,
      contactStart: Math.max(contactMs - halfSample, accelerateStartMs + 1),
      contactEnd: Math.min(
        contactMs + halfSample,
        followEnd > peakIndex ? timeAt(followEnd) - 1 : observedEnd,
      ),
      followEnd: timeAt(followEnd),
    };
    boundaries.contactEnd = Math.max(boundaries.contactEnd, contactMs);

    const spans: PhaseSpan[] = [
      span("ready", boundaries.readyStart, boundaries.prepareStart, confidence),
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
    ];

    // Guarantee ordered, non-negative, whole-millisecond spans inside the
    // observations; every representative is an observed frame timestamp.
    let cursor = firstObserved;
    const observedSpans: PhaseSpan[] = [];
    for (const entry of spans) {
      entry.startMs = Math.max(Math.min(Math.round(entry.startMs), observedEnd), cursor);
      entry.endMs = Math.min(Math.max(Math.round(entry.endMs), entry.startMs), observedEnd);
      entry.representativeMs = Math.min(
        Math.max(Math.round(entry.representativeMs), entry.startMs),
        entry.endMs,
      );
      cursor = entry.endMs;
      const representative = frameNearest(
        analysisFrames.filter(
          (frame) => frame.timestampMs >= entry.startMs && frame.timestampMs <= entry.endMs,
        ),
        entry.representativeMs,
      );
      if (entry.endMs > entry.startMs && representative) {
        observedSpans.push({
          ...entry,
          representativeMs: representative.timestampMs,
          confidence: clampUnit(entry.confidence, 0, 1),
        });
      }
    }
    return ok(observedSpans);
  }

  private swingingWrist(
    frames: readonly PoseFrame[],
    stroke: StrokeEvent,
    aspectRatio: number,
  ): "left_wrist" | "right_wrist" {
    const first = frames[0]?.timestampMs ?? stroke.startMs;
    const last = frames[frames.length - 1]?.timestampMs ?? stroke.endMs;
    const startMs = Math.min(stroke.startMs, first);
    const endMs = Math.max(stroke.endMs, last);
    const left = pathLength(frames, "left_wrist", startMs, endMs, aspectRatio);
    const right = pathLength(frames, "right_wrist", startMs, endMs, aspectRatio);
    return right >= left ? "right_wrist" : "left_wrist";
  }

  /**
   * Indices of the smoothed-speed local maxima among eligible samples, the
   * recorded contact hint's neighbourhood (≤ 120 ms) first when it holds one,
   * then fastest first. A flat plateau contributes its first sample; a window
   * with no interior maximum (monotonic, e.g. it opens on the decay after
   * the peak) contributes its fastest sample.
   */
  private peakCandidates(
    speeds: readonly TimedSample[],
    hintMs: number | null,
    eligible: (sample: TimedSample) => boolean,
  ): number[] {
    const maxima: number[] = [];
    let fastest = -1;
    speeds.forEach((sample, index) => {
      if (!eligible(sample)) return;
      if (fastest < 0 || sample.value > speeds[fastest]!.value) fastest = index;
      const previous = speeds[index - 1]?.value ?? -Infinity;
      const next = speeds[index + 1]?.value ?? -Infinity;
      if (sample.value > previous && sample.value >= next) maxima.push(index);
    });
    if (fastest >= 0 && !maxima.includes(fastest)) maxima.push(fastest);
    maxima.sort((a, b) => speeds[b]!.value - speeds[a]!.value);
    if (hintMs === null) return maxima;
    // Snap the recorded contact hint to the nearest local speed maximum when
    // one exists within 120ms; the fastest candidates follow.
    let hinted: number | null = null;
    let hintedValue = -1;
    for (const index of maxima) {
      const sample = speeds[index]!;
      if (Math.abs(sample.timestampMs - hintMs) > 120) continue;
      if (sample.value > hintedValue) {
        hintedValue = sample.value;
        hinted = index;
      }
    }
    return hinted === null ? maxima : [hinted, ...maxima.filter((index) => index !== hinted)];
  }

  /**
   * Start of the run-up to the peak at `peakIndex`: walking backwards the
   * speed falls toward the paddle-set dip; the run-up ends where it starts
   * rising again (the backswing) or drops under 25% of the peak. It always
   * keeps at least the sample before the peak.
   */
  private runUpStart(speeds: readonly TimedSample[], peakIndex: number): number {
    const peak = speeds[peakIndex]!.value;
    let start = peakIndex;
    while (start > 0) {
      const previous = speeds[start - 1];
      const current = speeds[start];
      if (!previous || !current) break;
      const rising = previous.value > current.value * 1.15 + peak * 0.05;
      if (previous.value < peak * 0.25 || (rising && start < peakIndex)) break;
      start -= 1;
    }
    if (start === peakIndex && peakIndex > 0) start = peakIndex - 1;
    return start;
  }

  private trackingConfidence(frames: readonly PoseFrame[]): number {
    const frameConfidence = mean(frames.map((frame) => frame.confidence));
    return Math.min(1, Math.max(0, frameConfidence));
  }

  /** Median shoulder-center → hip-center distance (aspect-corrected), or null when never measured. */
  private medianTorso(frames: readonly PoseFrame[], aspectRatio: number): number | null {
    const samples: number[] = [];
    for (const frame of frames) {
      const ls = landmark(frame, "left_shoulder", aspectRatio);
      const rs = landmark(frame, "right_shoulder", aspectRatio);
      const lh = landmark(frame, "left_hip", aspectRatio);
      const rh = landmark(frame, "right_hip", aspectRatio);
      if (!ls || !rs || !lh || !rh) continue;
      const torso = distance(midpoint(ls, rs), midpoint(lh, rh));
      if (Number.isFinite(torso) && torso > 1e-4) samples.push(torso);
    }
    return samples.length > 0 ? median(samples) : null;
  }

  /**
   * Farthest the wrist gets from where the run-up started, across the run-up
   * frames [startMs, peakMs] that measured it. null when fewer than two such
   * frames exist (nothing to compare).
   */
  private runUpTravel(
    frames: readonly PoseFrame[],
    wrist: "left_wrist" | "right_wrist",
    aspectRatio: number,
    startMs: number,
    peakMs: number,
  ): number | null {
    let origin: ReturnType<typeof landmark> = null;
    let travel = 0;
    let samples = 0;
    for (const frame of frames) {
      if (frame.timestampMs < startMs || frame.timestampMs > peakMs) continue;
      const point = landmark(frame, wrist, aspectRatio);
      if (!point) continue;
      samples += 1;
      if (!origin) {
        origin = point;
        continue;
      }
      travel = Math.max(travel, distance(origin, point));
    }
    return samples >= 2 ? travel : null;
  }
}

function timeAtIndex(speeds: readonly TimedSample[], index: number, fallback: number): number {
  return speeds[Math.min(Math.max(index, 0), speeds.length - 1)]?.timestampMs ?? fallback;
}

function clampUnit(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
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
    representativeMs: Math.round(startMs + (orderedEnd - startMs) / 2),
    confidence,
  };
}
