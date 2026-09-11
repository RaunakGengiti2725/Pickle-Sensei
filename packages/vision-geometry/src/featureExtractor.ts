import type {
  CameraView,
  Handedness,
  Measurement,
  PaddleFrame,
  PhaseSpan,
  PoseFrame,
  PoseLandmarkName,
  Result,
  ShotTypeSlug,
} from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type { IFeatureExtractor } from "@pickle/vision-contracts";
import {
  angularDifferenceDeg,
  clamp,
  distance,
  framesWithin,
  interiorAngleDeg,
  landmark,
  mean,
  median,
  midpoint,
  movingAverage,
  pathLength,
  segmentAngleDeg,
  standardDeviation,
  type Point,
} from "./kinematics.js";

/**
 * Deterministic biomechanical measurements for the sm-v1 metric vocabulary,
 * computed from measured pose landmarks only.
 *
 * Definitions (docs/ML_SYSTEM.md "Geometry measurement definitions"):
 * - Lengths are aspect-corrected and divided by measured torso length
 *   (shoulder-center to hip-center), so values are body-relative.
 * - Heights use the measured ankle line as ground.
 * - "Forward" is the direction the swinging wrist travels through accelerate.
 * - Paddle-position metrics (`paddle_*`) are measured at the dominant wrist —
 *   the hand holding the paddle — and carry reduced confidence until a real
 *   paddle detector exists. The wrist is a measured joint, not a guess, but it
 *   is not the paddle face.
 *
 * Every measurement's confidence is the mean measured visibility of the
 * joints it used, scaled by documented method factors. Metrics whose joints
 * were not measured are omitted so the scoring engine can abstain rather than
 * receive fabricated values.
 *
 * features-geometry-3 degrades instead of refusing (2026-09-10 field
 * failure: a live swing ended in "Acceleration and contact-proxy observations
 * are required" and no score). A missing phase now falls back to the
 * neighbouring measured phase, the torso length and ground line fall back to
 * the whole recording when the stroke window itself did not show them, and
 * the forward direction is read from the first and last visible wrist inside
 * the run-up when the exact boundary frames hide it. Nothing is invented:
 * every fallback is another measured frame of the same clip, and a metric
 * whose joints were never measured is still omitted.
 */

export const FEATURE_EXTRACTOR_VERSION = "features-geometry-3";

const PADDLE_PROXY_FACTOR = 0.75;
const SIDE_VIEW_TURN_FACTOR = 0.7;
/** Confidence factor for a phase span stood in for by a neighbouring phase. */
const FALLBACK_PHASE_FACTOR = 0.5;

interface Body {
  dominant: {
    wrist: PoseLandmarkName;
    elbow: PoseLandmarkName;
    shoulder: PoseLandmarkName;
    hip: PoseLandmarkName;
    knee: PoseLandmarkName;
    ankle: PoseLandmarkName;
  };
  torsoLength: number;
  groundY: number | null;
  forwardSign: 1 | -1 | null;
}

export class PoseGeometryFeatureExtractor implements IFeatureExtractor {
  public readonly version = FEATURE_EXTRACTOR_VERSION;

  private readonly aspectRatio: number;

  public constructor(options: { aspectRatio: number }) {
    this.aspectRatio = options.aspectRatio;
  }

  public async extractMeasurements(input: {
    poseFrames: PoseFrame[];
    paddleFrames: PaddleFrame[];
    phases: PhaseSpan[];
    shotType: ShotTypeSlug;
    handedness: Handedness;
    cameraView: CameraView;
  }): Promise<Result<Measurement[]>> {
    const { phases, handedness, cameraView } = input;
    const phaseByKey = new Map(phases.map((phase) => [phase.key, phase]));
    if (
      phaseByKey.size !== phases.length ||
      phases.some(
        (phase) =>
          ![phase.startMs, phase.representativeMs, phase.endMs, phase.confidence].every(
            Number.isFinite,
          ) ||
          phase.startMs < 0 ||
          phase.startMs > phase.representativeMs ||
          phase.representativeMs > phase.endMs ||
          phase.confidence < 0 ||
          phase.confidence > 1,
      )
    ) {
      return fail(
        failure(
          "low_confidence",
          "features.invalid_phase",
          "Phase observations are invalid or duplicated.",
        ),
      );
    }
    if (phases.length === 0) {
      return fail(
        failure(
          "low_confidence",
          "features.missing_phase",
          "No stroke phase was observed; nothing can be measured.",
        ),
      );
    }
    const { accelerate, contact } = resolveSwingSpans(phases, phaseByKey);
    const ready = phaseByKey.get("ready");
    const prepareSpan = phaseByKey.get("prepare");
    const followSpan = phaseByKey.get("follow_through");
    const observedPhases = [
      ...phases.filter((phase) => phase.key !== "recover"),
      accelerate,
      contact,
    ];
    const poseFrames = framesWithin(
      input.poseFrames,
      Math.min(...observedPhases.map((phase) => phase.startMs)),
      Math.max(...observedPhases.map((phase) => phase.endMs)),
    );
    const frameInPhase = (
      phase: PhaseSpan | undefined,
      position: "startMs" | "endMs" | "representativeMs",
    ) => (phase ? this.observedPhaseFrame(poseFrames, phase, phase[position]) : null);

    const body = this.measureBody(poseFrames, input.poseFrames, handedness, accelerate, contact);
    if (!body.ok) return body;
    const { torsoLength, groundY, forwardSign, dominant } = body.value;

    const aspect = this.aspectRatio;
    const measurements: Measurement[] = [];
    const add = (
      metricKey: string,
      value: number | null,
      unit: Measurement["unit"],
      confidence: number,
    ): void => {
      if (
        value === null ||
        !Number.isFinite(value) ||
        !Number.isFinite(confidence) ||
        confidence <= 0
      )
        return;
      measurements.push({
        metricKey,
        value,
        unit,
        confidence: clamp(confidence, 0, 1),
        source: "real",
      });
    };

    const readyFrame = frameInPhase(ready, "representativeMs");
    const prepareEndFrame = frameInPhase(prepareSpan, "endMs");
    const contactFrame = frameInPhase(contact, "representativeMs");
    const accelerateStartFrame = frameInPhase(accelerate, "startMs");

    // ready_position + athletic_base --------------------------------------
    if (readyFrame) {
      const ankles = this.pair(readyFrame, "left_ankle", "right_ankle");
      const shoulders = this.pair(readyFrame, "left_shoulder", "right_shoulder");
      if (ankles && shoulders) {
        const shoulderWidth = distance(shoulders[0], shoulders[1]);
        if (shoulderWidth > 1e-6) {
          add(
            "stance_width_ratio",
            distance(ankles[0], ankles[1]) / shoulderWidth,
            "ratio",
            this.visibility([...ankles, ...shoulders]),
          );
        }
      }
      const hip = landmark(readyFrame, dominant.hip, aspect);
      const knee = landmark(readyFrame, dominant.knee, aspect);
      const ankle = landmark(readyFrame, dominant.ankle, aspect);
      if (hip && knee && ankle) {
        add(
          "knee_flexion_deg",
          180 - interiorAngleDeg(hip, knee, ankle),
          "degrees",
          this.visibility([hip, knee, ankle]),
        );
      }
      const wrist = landmark(readyFrame, dominant.wrist, aspect);
      const hips = this.pair(readyFrame, "left_hip", "right_hip");
      if (wrist && hips) {
        add(
          "paddle_ready_height_ratio",
          (midpoint(hips[0], hips[1]).y - wrist.y) / torsoLength,
          "ratio",
          this.visibility([wrist, ...hips]) * PADDLE_PROXY_FACTOR,
        );
      }
    }

    // preparation ----------------------------------------------------------
    const turnFrames = prepareSpan
      ? framesWithin(poseFrames, prepareSpan.startMs, prepareSpan.endMs)
      : [];
    const turnSamples: number[] = [];
    let turnVisibility = 0;
    for (const frame of turnFrames) {
      const shoulders = this.pair(frame, "left_shoulder", "right_shoulder");
      const hips = this.pair(frame, "left_hip", "right_hip");
      if (!shoulders || !hips) continue;
      turnSamples.push(
        angularDifferenceDeg(
          segmentAngleDeg(shoulders[0], shoulders[1]),
          segmentAngleDeg(hips[0], hips[1]),
        ),
      );
      turnVisibility = Math.max(turnVisibility, this.visibility([...shoulders, ...hips]));
    }
    if (turnSamples.length > 0) {
      add(
        "shoulder_turn_deg",
        Math.max(...turnSamples),
        "degrees",
        turnVisibility * (cameraView === "side" ? SIDE_VIEW_TURN_FACTOR : 1),
      );
    }

    // paddle_set -----------------------------------------------------------
    if (prepareEndFrame) {
      const wrist = landmark(prepareEndFrame, dominant.wrist, aspect);
      const hips = this.pair(prepareEndFrame, "left_hip", "right_hip");
      if (wrist && hips) {
        const hipCenter = midpoint(hips[0], hips[1]);
        const visibility = this.visibility([wrist, ...hips]) * PADDLE_PROXY_FACTOR;
        add("paddle_set_height_ratio", (hipCenter.y - wrist.y) / torsoLength, "ratio", visibility);
        if (forwardSign !== null) {
          add(
            "paddle_set_forward_norm",
            ((wrist.x - hipCenter.x) * forwardSign) / torsoLength,
            "normalized",
            visibility,
          );
        }
      }
    }

    // swing_length ----------------------------------------------------------
    if (prepareSpan && this.wristSampleCount(poseFrames, prepareSpan, dominant.wrist) >= 2) {
      add(
        "backswing_length_norm",
        pathLength(poseFrames, dominant.wrist, prepareSpan.startMs, prepareSpan.endMs, aspect) /
          torsoLength,
        "normalized",
        this.spanWristVisibility(poseFrames, prepareSpan),
      );
    }

    // sequencing -----------------------------------------------------------
    const lag = this.hipShoulderLagMs(poseFrames, accelerate, contact);
    if (lag !== null) add("hip_shoulder_lag_ms", lag.valueMs, "ms", lag.confidence);
    if (accelerateStartFrame && contactFrame && forwardSign !== null) {
      const startHips = this.pair(accelerateStartFrame, "left_hip", "right_hip");
      const contactHips = this.pair(contactFrame, "left_hip", "right_hip");
      if (startHips && contactHips) {
        add(
          "weight_transfer_norm",
          ((midpoint(contactHips[0], contactHips[1]).x - midpoint(startHips[0], startHips[1]).x) *
            forwardSign) /
            torsoLength,
          "normalized",
          this.visibility([...startHips, ...contactHips]),
        );
      }
    }

    // paddle_path ----------------------------------------------------------
    // "Low to high" is measured from the lowest wrist point of the forward
    // swing up to contact — the drop-then-brush-up a coach looks for.
    if (contactFrame) {
      const contactWrist = landmark(contactFrame, dominant.wrist, aspect);
      const swingFrames = framesWithin(poseFrames, accelerate.startMs, contact.representativeMs);
      let lowest: Point | null = null;
      for (const frame of swingFrames) {
        const wrist = landmark(frame, dominant.wrist, aspect);
        if (wrist && (lowest === null || wrist.y > lowest.y)) lowest = wrist;
      }
      if (contactWrist && lowest) {
        const rise = lowest.y - contactWrist.y; // top-left origin: rising = y decreases
        const run = Math.max(Math.abs(contactWrist.x - lowest.x), torsoLength * 0.05);
        add(
          "path_low_to_high_slope",
          clamp(rise / run, -2, 2),
          "ratio",
          this.visibility([lowest, contactWrist]),
        );
      }
    }

    // contact_position -----------------------------------------------------
    if (contactFrame) {
      const wrist = landmark(contactFrame, dominant.wrist, aspect);
      const hips = this.pair(contactFrame, "left_hip", "right_hip");
      const shoulders = this.pair(contactFrame, "left_shoulder", "right_shoulder");
      if (wrist && hips && forwardSign !== null) {
        add(
          "contact_forward_of_hip_norm",
          ((wrist.x - midpoint(hips[0], hips[1]).x) * forwardSign) / torsoLength,
          "normalized",
          this.visibility([wrist, ...hips]),
        );
      }
      if (wrist && shoulders && groundY !== null) {
        const shoulderHeight = groundY - midpoint(shoulders[0], shoulders[1]).y;
        if (shoulderHeight > 1e-6) {
          add(
            "contact_height_ratio",
            (groundY - wrist.y) / shoulderHeight,
            "ratio",
            this.visibility([wrist, ...shoulders]),
          );
        }
      }
    }

    // face_wrist_stability ---------------------------------------------------
    const stabilityWindow = followSpan
      ? framesWithin(
          poseFrames,
          accelerate.endMs,
          followSpan.startMs + (followSpan.endMs - followSpan.startMs) / 2,
        )
      : [];
    const forearmAngles: number[] = [];
    let forearmVisibility = 0;
    for (const frame of stabilityWindow) {
      const elbow = landmark(frame, dominant.elbow, aspect);
      const wrist = landmark(frame, dominant.wrist, aspect);
      if (!elbow || !wrist) continue;
      forearmAngles.push(segmentAngleDeg(elbow, wrist));
      forearmVisibility = Math.max(forearmVisibility, this.visibility([elbow, wrist]));
    }
    if (forearmAngles.length >= 3) {
      add(
        "wrist_angle_variance_deg",
        standardDeviation(unwrapDegrees(forearmAngles)),
        "degrees",
        forearmVisibility,
      );
    }

    // follow_through + recovery ---------------------------------------------
    if (followSpan && this.wristSampleCount(poseFrames, followSpan, dominant.wrist) >= 2) {
      add(
        "follow_through_length_norm",
        pathLength(poseFrames, dominant.wrist, followSpan.startMs, followSpan.endMs, aspect) /
          torsoLength,
        "normalized",
        this.spanWristVisibility(poseFrames, followSpan),
      );
    }

    if (measurements.length === 0) {
      return fail(
        failure(
          "low_confidence",
          "features.nothing_measurable",
          "No metric's required joints were measured reliably enough to report.",
        ),
      );
    }
    return ok(measurements);
  }

  /**
   * Torso length (shoulder-center → hip-center) and ground line (lowest
   * ankle) as measured across `frames`; both are body constants, so the
   * stroke window is preferred and the whole recording stands in when the
   * window itself did not show the joints.
   */
  private bodyConstants(frames: readonly PoseFrame[]): {
    torsoSamples: number[];
    groundSamples: number[];
  } {
    const torsoSamples: number[] = [];
    const groundSamples: number[] = [];
    for (const frame of frames) {
      const shoulders = this.pair(frame, "left_shoulder", "right_shoulder");
      const hips = this.pair(frame, "left_hip", "right_hip");
      if (shoulders && hips) {
        const torso = distance(midpoint(shoulders[0], shoulders[1]), midpoint(hips[0], hips[1]));
        if (Number.isFinite(torso) && torso >= 1e-4) torsoSamples.push(torso);
      }
      const ankles = this.pair(frame, "left_ankle", "right_ankle");
      if (ankles) {
        const ground = Math.max(ankles[0].y, ankles[1].y);
        if (Number.isFinite(ground)) groundSamples.push(ground);
      }
    }
    return { torsoSamples, groundSamples };
  }

  private measureBody(
    poseFrames: readonly PoseFrame[],
    allFrames: readonly PoseFrame[],
    handedness: Handedness,
    accelerate: PhaseSpan,
    contact: PhaseSpan,
  ): Result<Body> {
    const aspect = this.aspectRatio;
    const inWindow = this.bodyConstants(poseFrames);
    const whole =
      inWindow.torsoSamples.length >= 4 && inWindow.groundSamples.length > 0
        ? inWindow
        : this.bodyConstants(allFrames);
    const torsoSamples =
      inWindow.torsoSamples.length >= 4 ? inWindow.torsoSamples : whole.torsoSamples;
    const groundSamples =
      inWindow.groundSamples.length > 0 ? inWindow.groundSamples : whole.groundSamples;
    const torsoLength = median(torsoSamples);
    if (torsoSamples.length === 0 || !Number.isFinite(torsoLength) || torsoLength < 1e-4) {
      return fail(
        failure(
          "low_confidence",
          "features.torso_not_measured",
          "Torso landmarks were not measured anywhere in the recording; body-relative metrics are impossible.",
        ),
      );
    }
    const groundY = groundSamples.length > 0 ? median(groundSamples) : null;

    const side =
      handedness === "left"
        ? "left"
        : handedness === "right"
          ? "right"
          : this.busierWristSide(poseFrames, accelerate);
    const dominant: Body["dominant"] =
      side === "left"
        ? {
            wrist: "left_wrist",
            elbow: "left_elbow",
            shoulder: "left_shoulder",
            hip: "left_hip",
            knee: "left_knee",
            ankle: "left_ankle",
          }
        : {
            wrist: "right_wrist",
            elbow: "right_elbow",
            shoulder: "right_shoulder",
            hip: "right_hip",
            knee: "right_knee",
            ankle: "right_ankle",
          };

    // Forward = measured travel direction of the swinging wrist to contact:
    // the run-up's first frame to the contact frame when both show the wrist,
    // else the first and last frames inside the run-up that do.
    const startFrame = this.observedPhaseFrame(poseFrames, accelerate, accelerate.startMs);
    const contactFrame = this.observedPhaseFrame(poseFrames, contact, contact.representativeMs);
    let forwardSign: 1 | -1 | null = null;
    const start =
      (startFrame && landmark(startFrame, dominant.wrist, aspect)) ??
      this.firstWrist(poseFrames, dominant.wrist, accelerate.startMs, contact.representativeMs);
    const end =
      (contactFrame && landmark(contactFrame, dominant.wrist, aspect)) ??
      this.lastWrist(poseFrames, dominant.wrist, accelerate.startMs, contact.endMs);
    if (start && end && end.x !== start.x) forwardSign = end.x > start.x ? 1 : -1;
    return ok({ dominant, torsoLength, groundY, forwardSign });
  }

  private firstWrist(
    frames: readonly PoseFrame[],
    wrist: PoseLandmarkName,
    startMs: number,
    endMs: number,
  ): Point | null {
    for (const frame of framesWithin(frames, startMs, endMs)) {
      const point = landmark(frame, wrist, this.aspectRatio);
      if (point) return point;
    }
    return null;
  }

  private lastWrist(
    frames: readonly PoseFrame[],
    wrist: PoseLandmarkName,
    startMs: number,
    endMs: number,
  ): Point | null {
    const inSpan = framesWithin(frames, startMs, endMs);
    for (let index = inSpan.length - 1; index >= 0; index -= 1) {
      const point = landmark(inSpan[index]!, wrist, this.aspectRatio);
      if (point) return point;
    }
    return null;
  }

  private busierWristSide(
    poseFrames: readonly PoseFrame[],
    accelerate: PhaseSpan,
  ): "left" | "right" {
    const left = pathLength(
      poseFrames,
      "left_wrist",
      accelerate.startMs,
      accelerate.endMs,
      this.aspectRatio,
    );
    const right = pathLength(
      poseFrames,
      "right_wrist",
      accelerate.startMs,
      accelerate.endMs,
      this.aspectRatio,
    );
    return right >= left ? "right" : "left";
  }

  private observedPhaseFrame(
    frames: readonly PoseFrame[],
    phase: PhaseSpan,
    timestampMs: number,
  ): PoseFrame | null {
    return (
      frames.find(
        (frame) =>
          frame.timestampMs === timestampMs &&
          frame.timestampMs >= phase.startMs &&
          frame.timestampMs <= phase.endMs,
      ) ?? null
    );
  }

  private pair(
    frame: PoseFrame,
    left: PoseLandmarkName,
    right: PoseLandmarkName,
  ): [Point, Point] | null {
    const a = landmark(frame, left, this.aspectRatio);
    const b = landmark(frame, right, this.aspectRatio);
    return a && b ? [a, b] : null;
  }

  private visibility(points: readonly Point[]): number {
    return mean(points.map((point) => point.visibility));
  }

  private wristSampleCount(
    poseFrames: readonly PoseFrame[],
    span: PhaseSpan,
    wrist: PoseLandmarkName,
  ): number {
    return framesWithin(poseFrames, span.startMs, span.endMs).filter(
      (frame) => landmark(frame, wrist, this.aspectRatio) !== null,
    ).length;
  }

  private spanWristVisibility(poseFrames: readonly PoseFrame[], span: PhaseSpan): number {
    const frames = framesWithin(poseFrames, span.startMs, span.endMs);
    if (frames.length === 0) return 0;
    return mean(frames.map((frame) => frame.confidence));
  }

  /**
   * Timing between peak hip-line and shoulder-line angular speeds inside the
   * accelerate→contact window. Positive lag means hips led — the measured
   * kinetic-chain order.
   */
  private hipShoulderLagMs(
    poseFrames: readonly PoseFrame[],
    accelerate: PhaseSpan,
    contact: PhaseSpan,
  ): { valueMs: number; confidence: number } | null {
    const frames = framesWithin(poseFrames, accelerate.startMs, contact.endMs);
    const samples: Array<{ timestampMs: number; hipDeg: number; shoulderDeg: number }> = [];
    for (const frame of frames) {
      const shoulders = this.pair(frame, "left_shoulder", "right_shoulder");
      const hips = this.pair(frame, "left_hip", "right_hip");
      if (!shoulders || !hips) continue;
      samples.push({
        timestampMs: frame.timestampMs,
        hipDeg: segmentAngleDeg(hips[0], hips[1]),
        shoulderDeg: segmentAngleDeg(shoulders[0], shoulders[1]),
      });
    }
    if (samples.length < 4) return null;
    const hipSpeed: number[] = [];
    const shoulderSpeed: number[] = [];
    const times: number[] = [];
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (!previous || !current) continue;
      const dt = current.timestampMs - previous.timestampMs;
      if (dt <= 0) continue;
      hipSpeed.push(angularDifferenceDeg(current.hipDeg, previous.hipDeg) / dt);
      shoulderSpeed.push(angularDifferenceDeg(current.shoulderDeg, previous.shoulderDeg) / dt);
      times.push(current.timestampMs);
    }
    if (times.length < 3) return null;
    const smoothHip = movingAverage(hipSpeed, 3);
    const smoothShoulder = movingAverage(shoulderSpeed, 3);
    const hipPeakAt = times[indexOfMax(smoothHip)] ?? null;
    const shoulderPeakAt = times[indexOfMax(smoothShoulder)] ?? null;
    if (hipPeakAt === null || shoulderPeakAt === null) return null;
    return {
      valueMs: Math.max(0, shoulderPeakAt - hipPeakAt),
      confidence: mean(frames.map((frame) => frame.confidence)) * 0.85,
    };
  }
}

/**
 * The run-up and contact-proxy spans the measurements are anchored on. The
 * segmenter emits both for every peak it finds; when one is absent (an older
 * or foreign segmenter), the neighbouring measured phase stands in at
 * reduced confidence rather than refusing every metric of the read.
 */
function resolveSwingSpans(
  phases: readonly PhaseSpan[],
  phaseByKey: ReadonlyMap<PhaseSpan["key"], PhaseSpan>,
): { accelerate: PhaseSpan; contact: PhaseSpan } {
  let contact = phaseByKey.get("contact");
  let accelerate = phaseByKey.get("accelerate");
  if (!contact) {
    // The contact proxy is the peak-speed instant; without it, the end of
    // the latest phase that precedes any follow-through stands in.
    const anchor =
      accelerate ??
      [...phases]
        .filter((phase) => phase.key !== "follow_through" && phase.key !== "recover")
        .sort((a, b) => b.endMs - a.endMs)[0] ??
      phases[0]!;
    contact = {
      key: "contact",
      startMs: anchor.endMs,
      representativeMs: anchor.endMs,
      endMs: anchor.endMs,
      confidence: anchor.confidence * FALLBACK_PHASE_FACTOR,
    };
  }
  if (!accelerate) {
    const proxyStart = contact.startMs;
    const before = [...phases]
      .filter((phase) => phase.key !== "contact" && phase.endMs <= proxyStart)
      .sort((a, b) => b.endMs - a.endMs)[0];
    accelerate = before
      ? {
          key: "accelerate",
          startMs: before.startMs,
          representativeMs: before.representativeMs,
          endMs: proxyStart,
          confidence: before.confidence * FALLBACK_PHASE_FACTOR,
        }
      : {
          key: "accelerate",
          startMs: proxyStart,
          representativeMs: proxyStart,
          endMs: proxyStart,
          confidence: contact.confidence * FALLBACK_PHASE_FACTOR,
        };
  }
  return { accelerate, contact };
}

function indexOfMax(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? -Infinity) > (values[best] ?? -Infinity)) best = index;
  }
  return best;
}

/** Unwraps angle jumps at the ±180° seam so variance reflects real wobble. */
function unwrapDegrees(angles: readonly number[]): number[] {
  const result: number[] = [];
  let offset = 0;
  let previous: number | null = null;
  for (const angle of angles) {
    if (previous !== null) {
      const delta = angle - previous;
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    result.push(angle + offset);
    previous = angle;
  }
  return result;
}
