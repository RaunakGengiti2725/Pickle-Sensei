import { fail, failure, ok, type Result } from "@pickle/shared-types";

export const MOTION_3D_FORMAT = "pickle.motion-3d.v1" as const;
export const MOTION_3D_ASSOCIATED_FORMAT = "pickle.motion-3d.v2" as const;
export const MOTION_3D_ASSOCIATION_VERSION = "motion-target-association-1" as const;
export const MOTION_3D_MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MOTION_3D_MAX_FRAMES = 1800;
export const MOTION_3D_MAX_DURATION_MS = 60_000;
export const MOTION_3D_JOINTS = [
  "root", "spine", "center_shoulder", "center_head", "top_head",
  "left_shoulder", "left_elbow", "left_wrist", "right_shoulder", "right_elbow", "right_wrist",
  "left_hip", "left_knee", "left_ankle", "right_hip", "right_knee", "right_ankle",
] as const;

export type Motion3DJointName = (typeof MOTION_3D_JOINTS)[number];
export type Motion3DFrameStatus = "estimated" | "no_person" | "multiple_people" | "unavailable";

export interface Motion3DJoint {
  name: Motion3DJointName;
  x: number;
  y: number;
  z: number;
  imageX: number;
  imageY: number;
  confidence: null;
  visibility2D: number | null;
}

export interface Motion3DFrame {
  frameIndex: number;
  timestampMs: number;
  ptsValue: number;
  ptsTimescale: number;
  segmentId: number;
  status: Motion3DFrameStatus;
  observationConfidence: number | null;
  height: { meters: number; source: "reference" | "measured" } | null;
  cameraOriginMatrix: number[] | null;
  joints: Motion3DJoint[];
}

export interface Motion3DArtifactV1 {
  schemaVersion: 1;
  format: typeof MOTION_3D_FORMAT;
  role: "reconstructed_estimate";
  coordinateSystem: "vision_root_relative";
  axes: "right_handed_y_up";
  units: "vision_estimated_meters";
  imageCoordinates: "normalized_image_top_left";
  uncertainty: "uncalibrated";
  temporalProcessing: "none";
  source: {
    captureId: string;
    videoSha256: string;
    videoByteLength: number;
    width: number;
    height: number;
    durationMs: number;
    nominalFrameRate: number;
    preferredTransform: number[];
    orientationPolicy: "preferred_track_transform_applied";
    mirroring: "as_encoded";
  };
  estimator: {
    providerId: "pose.apple-vision-3d";
    revision: 1;
    osVersion: string;
    modelAsset: "os_managed";
    modelAssetSha256: null;
    configurationVersion: "apple-vision-3d-raw-1";
    maxSampleRate: 30;
  };
  frames: Motion3DFrame[];
}

export interface Motion3DTargetSeed {
  x: number;
  y: number;
  timestampMs: number;
}

export interface Motion3DIdentityPolicy {
  version: typeof MOTION_3D_ASSOCIATION_VERSION;
  selection: "automatic_prominence" | "explicit_seed";
  seed: Motion3DTargetSeed | null;
  crossRecordIdentity: "unverified";
  residualUnit: "torso_spans";
  parameters: Record<string, number>;
}

export const MOTION_3D_ASSOCIATION_STATUSES = [
  "matched", "ambiguous", "target_lost", "wrong_player", "insufficient_support", "no_person", "not_selected",
] as const;

export interface Motion3DAssociation {
  status: (typeof MOTION_3D_ASSOCIATION_STATUSES)[number];
  trackId: number | null;
  candidateCount: number;
  selectedCandidate: number | null;
  commonJoints: number;
  reprojectionError: number | null;
  runnerUpError: number | null;
  continuity: "initial" | "continuous" | "broken";
}

export interface Motion3DAssociatedFrame extends Motion3DFrame {
  association: Motion3DAssociation;
}

export interface Motion3DArtifactV2 extends Omit<Motion3DArtifactV1, "schemaVersion" | "format" | "estimator" | "frames"> {
  schemaVersion: 2;
  format: typeof MOTION_3D_ASSOCIATED_FORMAT;
  estimator: Omit<Motion3DArtifactV1["estimator"], "configurationVersion"> & {
    configurationVersion: "apple-vision-3d-associated-2";
  };
  identityPolicy: Motion3DIdentityPolicy;
  frames: Motion3DAssociatedFrame[];
}

export type Motion3DArtifact = Motion3DArtifactV1 | Motion3DArtifactV2;

export function motion3DAssociation(frame: Motion3DFrame): Motion3DAssociation | null {
  return "association" in frame ? (frame as Motion3DAssociatedFrame).association : null;
}

const jointNames = new Set<string>(MOTION_3D_JOINTS);
const frameStatuses = new Set<string>(["estimated", "no_person", "multiple_people", "unavailable"]);
const associationStatuses = new Set<string>(MOTION_3D_ASSOCIATION_STATUSES);
const frameKeys = ["frameIndex", "timestampMs", "ptsValue", "ptsTimescale", "segmentId", "status", "observationConfidence", "height", "cameraOriginMatrix", "joints"];
const headerKeys = ["schemaVersion", "format", "role", "coordinateSystem", "axes", "units", "imageCoordinates", "uncertainty", "temporalProcessing", "source", "estimator", "frames"];

function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return numberIn(value, min, max) && Number.isSafeInteger(value);
}

function matrix(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((v) => numberIn(v, -1e6, 1e6));
}

function validJoint(value: unknown): value is Motion3DJoint {
  return shape(value, ["name", "x", "y", "z", "imageX", "imageY", "confidence", "visibility2D"])
    && typeof value["name"] === "string" && jointNames.has(value["name"])
    && [value["x"], value["y"], value["z"]].every((v) => numberIn(v, -100, 100))
    && numberIn(value["imageX"], 0, 1) && numberIn(value["imageY"], 0, 1)
    && value["confidence"] === null
    && (value["visibility2D"] === null || numberIn(value["visibility2D"], 0, 1));
}

function validAssociation(value: unknown, estimated: boolean): value is Motion3DAssociation {
  if (!shape(value, ["status", "trackId", "candidateCount", "selectedCandidate", "commonJoints", "reprojectionError", "runnerUpError", "continuity"])
    || typeof value["status"] !== "string" || !associationStatuses.has(value["status"])
    || !integerIn(value["candidateCount"], 0, 64)
    || !(value["trackId"] === null || integerIn(value["trackId"], 1, 1_000_000))
    || !(value["selectedCandidate"] === null || integerIn(value["selectedCandidate"], 0, value["candidateCount"] - 1))
    || !integerIn(value["commonJoints"], 0, 17)
    || !(value["reprojectionError"] === null || numberIn(value["reprojectionError"], 0, 1e6))
    || !(value["runnerUpError"] === null || numberIn(value["runnerUpError"], 0, 1e6))
    || !["initial", "continuous", "broken"].includes(String(value["continuity"]))) return false;
  if (!estimated) return value["status"] !== "matched";
  return value["status"] === "matched" && value["continuity"] !== "broken"
    && value["trackId"] !== null && value["selectedCandidate"] !== null && value["commonJoints"] >= 4
    && value["reprojectionError"] !== null
    && (value["runnerUpError"] === null || value["runnerUpError"] > value["reprojectionError"]);
}

function validIdentityPolicy(value: unknown, durationMs: number): value is Motion3DIdentityPolicy {
  if (!shape(value, ["version", "selection", "seed", "crossRecordIdentity", "residualUnit", "parameters"])
    || value["version"] !== MOTION_3D_ASSOCIATION_VERSION || value["crossRecordIdentity"] !== "unverified"
    || value["residualUnit"] !== "torso_spans"
    || (value["selection"] !== "automatic_prominence" && value["selection"] !== "explicit_seed")) return false;
  const parameters = value["parameters"];
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return false;
  const entries = Object.entries(parameters);
  if (entries.length === 0 || entries.length > 32 || entries.some(([key, entry]) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || !numberIn(entry, 0, 1e6))) return false;
  const seed = value["seed"];
  return value["selection"] === "automatic_prominence" ? seed === null
    : shape(seed, ["x", "y", "timestampMs"]) && numberIn(seed["x"], 0, 1)
      && numberIn(seed["y"], 0, 1) && numberIn(seed["timestampMs"], 0, durationMs);
}

function validFrame(value: unknown, durationMs: number, version: 1 | 2): value is Motion3DFrame {
  if (!shape(value, version === 1 ? frameKeys : [...frameKeys, "association"])) return false;
  if (!integerIn(value["frameIndex"], 0, 1_000_000)
    || !numberIn(value["timestampMs"], 0, durationMs)
    || !integerIn(value["ptsValue"], 0, Number.MAX_SAFE_INTEGER)
    || !integerIn(value["ptsTimescale"], 1, 1_000_000_000)
    || Math.abs(value["timestampMs"] - (value["ptsValue"] * 1000) / value["ptsTimescale"]) > 0.0001
    || !integerIn(value["segmentId"], 0, MOTION_3D_MAX_FRAMES)
    || typeof value["status"] !== "string" || !frameStatuses.has(value["status"])
    || !Array.isArray(value["joints"]) || value["joints"].length > MOTION_3D_JOINTS.length
    || !value["joints"].every(validJoint)
    || (version === 2 && !validAssociation(value["association"], value["status"] === "estimated"))) return false;
  const joints = value["joints"] as Motion3DJoint[];
  if (new Set(joints.map((joint) => joint.name)).size !== joints.length) return false;
  if (value["status"] !== "estimated") {
    return joints.length === 0 && value["height"] === null
      && value["cameraOriginMatrix"] === null && value["observationConfidence"] === null;
  }
  const height = value["height"];
  return joints.some((joint) => joint.name === "root") && numberIn(value["observationConfidence"], 0, 1)
    && matrix(value["cameraOriginMatrix"], 16) && shape(height, ["meters", "source"])
    && numberIn(height["meters"], 0.01, 100)
    && (height["source"] === "measured" || (height["source"] === "reference" && Math.abs(height["meters"] - 1.8) < 0.0001));
}

function validSource(value: unknown): value is Motion3DArtifactV1["source"] {
  return shape(value, ["captureId", "videoSha256", "videoByteLength", "width", "height", "durationMs", "nominalFrameRate", "preferredTransform", "orientationPolicy", "mirroring"])
    && typeof value["captureId"] === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value["captureId"])
    && typeof value["videoSha256"] === "string" && /^[a-f0-9]{64}$/.test(value["videoSha256"])
    && integerIn(value["videoByteLength"], 1, 512 * 1024 * 1024)
    && integerIn(value["width"], 1, 8192) && integerIn(value["height"], 1, 8192)
    && numberIn(value["durationMs"], 1, MOTION_3D_MAX_DURATION_MS)
    && numberIn(value["nominalFrameRate"], 0.1, 240) && matrix(value["preferredTransform"], 6)
    && value["orientationPolicy"] === "preferred_track_transform_applied" && value["mirroring"] === "as_encoded";
}

function validEstimator(value: unknown, version: 1 | 2): boolean {
  return shape(value, ["providerId", "revision", "osVersion", "modelAsset", "modelAssetSha256", "configurationVersion", "maxSampleRate"])
    && value["providerId"] === "pose.apple-vision-3d" && value["revision"] === 1
    && typeof value["osVersion"] === "string" && value["osVersion"].length > 0 && value["osVersion"].length <= 128
    && value["modelAsset"] === "os_managed" && value["modelAssetSha256"] === null
    && value["configurationVersion"] === (version === 1 ? "apple-vision-3d-raw-1" : "apple-vision-3d-associated-2")
    && value["maxSampleRate"] === 30;
}

function exceedsByteLimit(text: string): boolean {
  if (text.length > MOTION_3D_MAX_JSON_BYTES) return true;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (code > 0xffff) i += 1;
    if (bytes > MOTION_3D_MAX_JSON_BYTES) return true;
  }
  return false;
}

export function parseMotion3D(json: string): Result<Motion3DArtifact> {
  const invalid = () => fail<Motion3DArtifact>(failure("corrupted_media", "motion_3d.invalid_artifact", "The 3D motion record is unsupported or invalid. It was not repaired."));
  if (typeof json !== "string" || exceedsByteLimit(json)) return invalid();
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return invalid(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const version = (raw as Record<string, unknown>)["schemaVersion"];
  if (version !== 1 && version !== 2) return invalid();
  if (!shape(raw, version === 1 ? headerKeys : [...headerKeys, "identityPolicy"])) return invalid();
  const value = raw;
  if (value["format"] !== (version === 1 ? MOTION_3D_FORMAT : MOTION_3D_ASSOCIATED_FORMAT)
    || value["role"] !== "reconstructed_estimate" || value["coordinateSystem"] !== "vision_root_relative"
    || value["axes"] !== "right_handed_y_up" || value["units"] !== "vision_estimated_meters"
    || value["imageCoordinates"] !== "normalized_image_top_left" || value["uncertainty"] !== "uncalibrated"
    || value["temporalProcessing"] !== "none" || !validSource(value["source"])
    || !validEstimator(value["estimator"], version) || !Array.isArray(value["frames"])
    || value["frames"].length === 0 || value["frames"].length > MOTION_3D_MAX_FRAMES) return invalid();
  const source = value["source"];
  const policy = version === 2 ? value["identityPolicy"] : null;
  if (version === 2 && !validIdentityPolicy(policy, source.durationMs)) return invalid();
  const seed = (policy as Motion3DIdentityPolicy | null)?.seed ?? null;
  let previous: Motion3DFrame | null = null;
  let lastEstimatedSegment = -1;
  let selectedTrack: number | null = null;
  let seedFrameSeen = seed === null;
  let gap = false;
  for (const frame of value["frames"]) {
    if (!validFrame(frame, source.durationMs, version)
      || (previous && (frame.timestampMs <= previous.timestampMs || frame.frameIndex <= previous.frameIndex || frame.segmentId < previous.segmentId))) return invalid();
    if (seed && Math.abs(frame.timestampMs - seed.timestampMs) < 0.0001) seedFrameSeen = true;
    if (frame.status === "estimated") {
      if (gap && frame.segmentId <= lastEstimatedSegment) return invalid();
      if (version === 2) {
        const association = (frame as Motion3DAssociatedFrame).association;
        if ((selectedTrack !== null && association.trackId !== selectedTrack) || (seed && frame.timestampMs < seed.timestampMs)) return invalid();
        selectedTrack = association.trackId;
      }
      lastEstimatedSegment = frame.segmentId;
      gap = false;
    } else gap = true;
    previous = frame;
  }
  return seedFrameSeen ? ok(value as unknown as Motion3DArtifact) : invalid();
}
