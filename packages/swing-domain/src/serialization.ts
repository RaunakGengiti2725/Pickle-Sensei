import type { PoseFrame, Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import {
  COORDINATE_SYSTEMS,
  POSE_FPS_SOURCES,
  POSE_SEQUENCE_FORMAT,
  POSE_SEQUENCE_SCHEMA_VERSION,
  type CanonicalPoseFrame,
  type CoordinateSystem,
  type PoseFpsSource,
  type PoseSequence,
  type PoseSequenceVideo,
} from "./observations.js";
import type { ModelRef } from "./provenance.js";

/**
 * Pose-sequence serialization. The wire format is compact JSON written by the
 * native capture layer beside each clip; this module is the single reader and
 * writer, and it validates hard: unknown schema versions, non-monotonic
 * timestamps, and malformed landmarks are rejected rather than repaired.
 *
 * Wire shape (keys shortened deliberately; documented here, versioned by
 * `schemaVersion` + `format`):
 *   { schemaVersion, format, coordinateSystem, poseModelVersion,
 *     video: { w, h, fps, nominalFps?, fpsSource?, fpsMismatch? },
 *     frames: [ { i, t, c, l: [ { n, x, y, v, z? } ] } ] }
 *
 * `video.fps` is the effective sample rate of `frames`. The three optional
 * cadence-provenance keys are additive (files written before them parse
 * unchanged): writers that measure the cadence from sample timestamps record
 * the asset's declared rate as `nominalFps` and flag `fpsMismatch` when the
 * two disagree, so a wrong nominalFrameRate is disclosed instead of trusted.
 */

interface WireFrame {
  i: number;
  t: number;
  c: number;
  l: Array<{ n: string; x: number; y: number; v: number; z?: number }>;
}

interface WireVideo {
  w: number;
  h: number;
  fps: number;
  nominalFps?: number;
  fpsSource?: PoseFpsSource;
  fpsMismatch?: boolean;
}

interface WireSequence {
  schemaVersion: number;
  format: string;
  coordinateSystem: string;
  poseModelVersion: string;
  video: WireVideo;
  frames: WireFrame[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function serializePoseSequence(sequence: PoseSequence): string {
  const wire: WireSequence = {
    schemaVersion: sequence.schemaVersion,
    format: sequence.format,
    coordinateSystem: sequence.coordinateSystem,
    poseModelVersion: sequence.producedBy.modelVersion,
    video: {
      w: sequence.video.width,
      h: sequence.video.height,
      fps: sequence.video.fps,
      ...(sequence.video.nominalFps !== undefined ? { nominalFps: sequence.video.nominalFps } : {}),
      ...(sequence.video.fpsSource !== undefined ? { fpsSource: sequence.video.fpsSource } : {}),
      ...(sequence.video.fpsMismatch !== undefined
        ? { fpsMismatch: sequence.video.fpsMismatch }
        : {}),
    },
    frames: sequence.frames.map((frame) => ({
      i: frame.frameIndex,
      t: frame.timestampMs,
      c: frame.confidence,
      l: frame.landmarks.map((mark) => ({
        n: mark.name,
        x: mark.x,
        y: mark.y,
        v: mark.visibility,
        ...(mark.z !== undefined ? { z: mark.z } : {}),
      })),
    })),
  };
  return JSON.stringify(wire);
}

export function parsePoseSequence(
  json: string,
  producedBy: Omit<ModelRef, "modelVersion">,
): Result<PoseSequence> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return invalid("pose_sequence.not_json", "The pose sequence file is not valid JSON.");
  }
  const wire = raw as Partial<WireSequence> | null;
  if (!wire || typeof wire !== "object") {
    return invalid("pose_sequence.not_object", "The pose sequence root must be an object.");
  }
  if (wire.schemaVersion !== POSE_SEQUENCE_SCHEMA_VERSION) {
    return invalid(
      "pose_sequence.unsupported_schema",
      `Unsupported pose sequence schema version: ${String(wire.schemaVersion)}.`,
    );
  }
  if (wire.format !== POSE_SEQUENCE_FORMAT) {
    return invalid(
      "pose_sequence.unsupported_format",
      `Unsupported pose sequence format: ${String(wire.format)}.`,
    );
  }
  if (!COORDINATE_SYSTEMS.includes(wire.coordinateSystem as CoordinateSystem)) {
    return invalid(
      "pose_sequence.unknown_coordinate_system",
      `Unknown coordinate system: ${String(wire.coordinateSystem)}.`,
    );
  }
  if (typeof wire.poseModelVersion !== "string" || wire.poseModelVersion.length === 0) {
    return invalid("pose_sequence.missing_model_version", "poseModelVersion is required.");
  }
  const video = wire.video;
  if (
    !video ||
    !isFiniteNumber(video.w) ||
    !isFiniteNumber(video.h) ||
    !isFiniteNumber(video.fps) ||
    video.w <= 0 ||
    video.h <= 0 ||
    video.fps <= 0
  ) {
    return invalid("pose_sequence.invalid_video", "video {w,h,fps} must be positive numbers.");
  }
  if (
    video.nominalFps !== undefined &&
    (!isFiniteNumber(video.nominalFps) || video.nominalFps < 0)
  ) {
    return invalid(
      "pose_sequence.invalid_video",
      "video.nominalFps must be a non-negative number when present.",
    );
  }
  if (
    video.fpsSource !== undefined &&
    !POSE_FPS_SOURCES.includes(video.fpsSource as PoseFpsSource)
  ) {
    return invalid(
      "pose_sequence.invalid_video",
      `video.fpsSource must be one of ${POSE_FPS_SOURCES.join(", ")} when present.`,
    );
  }
  if (video.fpsMismatch !== undefined && typeof video.fpsMismatch !== "boolean") {
    return invalid(
      "pose_sequence.invalid_video",
      "video.fpsMismatch must be a boolean when present.",
    );
  }
  const parsedVideo: PoseSequenceVideo = {
    width: video.w,
    height: video.h,
    fps: video.fps,
    ...(video.nominalFps !== undefined ? { nominalFps: video.nominalFps } : {}),
    ...(video.fpsSource !== undefined ? { fpsSource: video.fpsSource } : {}),
    ...(video.fpsMismatch !== undefined ? { fpsMismatch: video.fpsMismatch } : {}),
  };
  if (!Array.isArray(wire.frames)) {
    return invalid("pose_sequence.invalid_frames", "frames must be an array.");
  }

  const frames: CanonicalPoseFrame[] = [];
  let previousTimestamp = -Infinity;
  for (const [index, frame] of wire.frames.entries()) {
    if (!frame || typeof frame !== "object") {
      return invalid("pose_sequence.corrupt_frame", `Frame ${index} is not an object.`);
    }
    if (!isFiniteNumber(frame.t) || !isFiniteNumber(frame.c) || !Number.isInteger(frame.i)) {
      return invalid(
        "pose_sequence.corrupt_frame",
        `Frame ${index} has invalid index/time/confidence.`,
      );
    }
    if (frame.t <= previousTimestamp) {
      return invalid(
        "pose_sequence.non_monotonic",
        `Frame ${index} timestamp ${frame.t} is not strictly after ${previousTimestamp}.`,
      );
    }
    previousTimestamp = frame.t;
    if (!Array.isArray(frame.l) || frame.l.length === 0) {
      return invalid("pose_sequence.corrupt_frame", `Frame ${index} has no landmarks.`);
    }
    const landmarks = [];
    for (const mark of frame.l) {
      if (
        !mark ||
        typeof mark.n !== "string" ||
        mark.n.length === 0 ||
        !isFiniteNumber(mark.x) ||
        !isFiniteNumber(mark.y) ||
        !isFiniteNumber(mark.v) ||
        (mark.z !== undefined && !isFiniteNumber(mark.z))
      ) {
        return invalid(
          "pose_sequence.corrupt_landmark",
          `Frame ${index} has a malformed landmark.`,
        );
      }
      landmarks.push({
        name: mark.n,
        x: mark.x,
        y: mark.y,
        visibility: mark.v,
        ...(mark.z !== undefined ? { z: mark.z } : {}),
      });
    }
    frames.push({
      frameIndex: frame.i,
      timestampMs: frame.t,
      confidence: frame.c,
      landmarks,
    });
  }

  return ok({
    schemaVersion: POSE_SEQUENCE_SCHEMA_VERSION,
    format: POSE_SEQUENCE_FORMAT,
    coordinateSystem: wire.coordinateSystem as CoordinateSystem,
    producedBy: { ...producedBy, modelVersion: wire.poseModelVersion },
    video: parsedVideo,
    frames,
  });
}

function invalid<T>(code: string, message: string): Result<T> {
  return fail(failure("corrupted_media", code, message));
}

/**
 * Bridge into the legacy shared-types PoseFrame consumed by today's
 * providers. Canonical landmarks with names outside the legacy vocabulary
 * are dropped here (the canonical record keeps them; only this projection is
 * lossy, and only for consumers of the legacy shape).
 */
export function toLegacyPoseFrames(sequence: PoseSequence): PoseFrame[] {
  return sequence.frames.map((frame) => ({
    timestampMs: frame.timestampMs,
    space: "normalized-image" as const,
    confidence: frame.confidence,
    landmarks: frame.landmarks
      .filter((mark) => LEGACY_LANDMARKS.has(mark.name))
      .map((mark) => ({
        name: mark.name as PoseFrame["landmarks"][number]["name"],
        x: mark.x,
        y: mark.y,
        visibility: mark.visibility,
      })),
  }));
}

const LEGACY_LANDMARKS = new Set([
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
]);
