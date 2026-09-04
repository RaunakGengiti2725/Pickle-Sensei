import type {
  CameraView,
  Handedness,
  Measurement,
  PaddleFrame,
  PhaseKey,
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
  frameNearest,
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
 * - Heights use the measured ankle line as ground; when no ankle pair was
 *   measured anywhere in the clip there is no ground line and every
 *   ground-relative metric is omitted (never defaulted to the image bottom).
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
 */

export const FEATURE_EXTRACTOR_VERSION = "features-geometry-2";

const PADDLE_PROXY_FACTOR = 0.75;
const SIDE_VIEW_TURN_FACTOR = 0.7;

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
  /** Median measured ankle line; null when no ankle pair was ever measured. */
  groundY: number | null;
  forwardSign: 1 | -1;
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
    const { poseFrames, phases, handedness, cameraView } = input;
    const phaseByKey = new Map(phases.map((phase) => [phase.key, phase]));
    const required: PhaseKey[] = [
      "ready",
      "prepare",
      "accelerate",
      "contact",
      "follow_through",
      "recover",
    ];
    for (const key of required) {
      if (!phaseByKey.has(key)) {
        return fail(
          failure("low_confidence", "features.missing_phase", `Phase "${key}" is missing.`),
        );
      }
    }
    const phase = (key: PhaseKey): PhaseSpan => phaseByKey.get(key) as PhaseSpan;

    const body = this.measureBody(poseFrames, handedness, phase("accelerate"), phase("contact"));
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
      if (value === null || !Number.isFinite(value)) return;
      measurements.push({
        metricKey,
        value,
        unit,
        confidence: clamp(confidence, 0, 1),
        source: "real",
      });
    };

    const readyFrame = frameNearest(poseFrames, phase("ready").representativeMs);
    const prepareEndFrame = frameNearest(poseFrames, phase("prepare").endMs);
    const contactFrame = frameNearest(poseFrames, phase("contact").representativeMs);
    const accelerateStartFrame = frameNearest(poseFrames, phase("accelerate").startMs);

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
    const turnFrames = framesWithin(
      poseFrames,
      phase("prepare").startMs,
      phase("accelerate").startMs,
    );
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
        add(
          "paddle_set_forward_norm",
          ((wrist.x - hipCenter.x) * forwardSign) / torsoLength,
          "normalized",
          visibility,
        );
      }
    }

    // swing_length ----------------------------------------------------------
    const prepareSpan = phase("prepare");
    add(
      "backswing_length_norm",
      pathLength(poseFrames, dominant.wrist, prepareSpan.startMs, prepareSpan.endMs, aspect) /
        torsoLength,
      "normalized",
      this.spanWristVisibility(poseFrames, prepareSpan),
    );

    // sequencing -----------------------------------------------------------
    const lag = this.hipShoulderLagMs(poseFrames, phase("accelerate"), phase("contact"));
    if (lag !== null) add("hip_shoulder_lag_ms", lag.valueMs, "ms", lag.confidence);
    if (accelerateStartFrame && contactFrame) {
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
      const swingFrames = framesWithin(
        poseFrames,
        phase("accelerate").startMs,
        phase("contact").representativeMs,
      );
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
      if (wrist && hips) {
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
    const stabilityWindow = framesWithin(
      poseFrames,
      phase("accelerate").endMs,
      phase("follow_through").startMs +
        (phase("follow_through").endMs - phase("follow_through").startMs) / 2,
    );
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
    const followSpan = phase("follow_through");
    add(
      "follow_through_length_norm",
      pathLength(poseFrames, dominant.wrist, followSpan.startMs, followSpan.endMs, aspect) /
        torsoLength,
      "normalized",
      this.spanWristVisibility(poseFrames, followSpan),
    );
    const recoverSpan = phase("recover");
    add("recovery_time_ms", recoverSpan.endMs - followSpan.endMs, "ms", recoverSpan.confidence);

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

  private measureBody(
    poseFrames: readonly PoseFrame[],
    handedness: Handedness,
    accelerate: PhaseSpan,
    contact: PhaseSpan,
  ): Result<Body> {
    const aspect = this.aspectRatio;
    const torsoSamples: number[] = [];
    const groundSamples: number[] = [];
    for (const frame of poseFrames) {
      const shoulders = this.pair(frame, "left_shoulder", "right_shoulder");
      const hips = this.pair(frame, "left_hip", "right_hip");
      if (shoulders && hips) {
        torsoSamples.push(
          distance(midpoint(shoulders[0], shoulders[1]), midpoint(hips[0], hips[1])),
        );
      }
      const ankles = this.pair(frame, "left_ankle", "right_ankle");
      if (ankles) groundSamples.push(Math.max(ankles[0].y, ankles[1].y));
    }
    const torsoLength = median(torsoSamples);
    if (torsoSamples.length < 4 || torsoLength < 1e-4) {
      return fail(
        failure(
          "low_confidence",
          "features.torso_not_measured",
          "Torso landmarks were not measured reliably; body-relative metrics are impossible.",
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

    // Forward = measured travel direction of the swinging wrist to contact.
    const startFrame = frameNearest(poseFrames, accelerate.startMs);
    const contactFrame = frameNearest(poseFrames, contact.representativeMs);
    let forwardSign: 1 | -1 = 1;
    if (startFrame && contactFrame) {
      const start = landmark(startFrame, dominant.wrist, aspect);
      const end = landmark(contactFrame, dominant.wrist, aspect);
      if (start && end && end.x !== start.x) forwardSign = end.x > start.x ? 1 : -1;
    }
    return ok({ dominant, torsoLength, groundY, forwardSign });
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
