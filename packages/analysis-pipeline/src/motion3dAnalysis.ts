import {
  SELECTABLE_TECHNIQUES_V1,
  SHOT_TYPES,
  fail,
  failure,
  ok,
  type Handedness,
  type Result,
  type ShotTypeSlug,
} from "@pickle/shared-types";
import {
  parseMotion3D,
  sha256Hex,
  type Motion3DArtifact,
  type Motion3DFrame,
  type Motion3DJointName,
} from "@pickle/swing-domain";
import { ANALYSIS_PLAN_VERSION } from "./analysisPlan.js";

export const MOTION_3D_GEOMETRY_VERSION = "motion-3d-geometry-1" as const;
export const MOTION_3D_ANGLE_JOINTS = [
  "left_elbow",
  "right_elbow",
  "left_knee",
  "right_knee",
] as const;
export type Motion3DAngleJoint = (typeof MOTION_3D_ANGLE_JOINTS)[number];

const angleTriples: Record<
  Motion3DAngleJoint,
  readonly [Motion3DJointName, Motion3DJointName, Motion3DJointName]
> = {
  left_elbow: ["left_shoulder", "left_elbow", "left_wrist"],
  right_elbow: ["right_shoulder", "right_elbow", "right_wrist"],
  left_knee: ["left_hip", "left_knee", "left_ankle"],
  right_knee: ["right_hip", "right_knee", "right_ankle"],
};

export interface Motion3DAngleRange {
  joint: Motion3DAngleJoint;
  minDegrees: number;
  maxDegrees: number;
  sampleCount: number;
}

export interface Motion3DSummary {
  sampleCount: number;
  estimatedFrameCount: number;
  missingFrameCount: number;
  multiplePersonFrameCount: number;
  unavailableFrameCount: number;
  continuitySegments: number;
  referenceScaleUsed: boolean;
  angleRanges: Motion3DAngleRange[];
}

export interface Motion3DAnalysisRecord {
  schemaVersion: 1;
  engine: "motion_3d";
  purpose: "development_validation";
  policyVersion: typeof ANALYSIS_PLAN_VERSION;
  geometryVersion: typeof MOTION_3D_GEOMETRY_VERSION;
  id: string;
  captureId: string;
  createdAtIso: string;
  capturedAtIso: string;
  declaredStroke: ShotTypeSlug | null;
  declaredCanonical: string | null;
  handedness: Handedness;
  artifactSha256: string;
  sourceVideoSha256: string;
  summary: Motion3DSummary;
  capabilities: {
    visualization: "development_only";
    comparison: "blocked";
    coaching: "blocked";
    correction: "blocked";
    scoring: "blocked";
  };
}

export interface Motion3DAnalysis {
  record: Motion3DAnalysisRecord;
  artifact: Motion3DArtifact;
  artifactJson: string;
}

const verifiedAnalyses = new WeakSet<Motion3DAnalysis>();

function freezeValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeValue(child);
  Object.freeze(value);
}

function verified(analysis: Motion3DAnalysis): Motion3DAnalysis {
  freezeValue(analysis);
  verifiedAnalyses.add(analysis);
  return analysis;
}

export function isVerifiedMotion3DAnalysis(analysis: Motion3DAnalysis): boolean {
  return verifiedAnalyses.has(analysis);
}

function retainedSummary(raw: unknown, expected: Motion3DSummary): Motion3DSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const summary = raw as Record<string, unknown>;
  const keys = Object.keys(expected) as (keyof Motion3DSummary)[];
  if (
    Object.keys(summary).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(summary, key))
  )
    return null;
  if (keys.some((key) => key !== "angleRanges" && summary[key] !== expected[key])) return null;
  const ranges = summary["angleRanges"];
  if (!Array.isArray(ranges) || ranges.length !== expected.angleRanges.length) return null;
  const seen = new Set<string>();
  for (const item of ranges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const range = item as Record<string, unknown>;
    if (
      Object.keys(range).length !== 4 ||
      typeof range["joint"] !== "string" ||
      seen.has(range["joint"])
    )
      return null;
    const target = expected.angleRanges.find((candidate) => candidate.joint === range["joint"]);
    if (!target || range["sampleCount"] !== target.sampleCount) return null;
    for (const key of ["minDegrees", "maxDegrees"] as const) {
      const value = range[key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 180 ||
        Math.abs(value - target[key]) > 0.100000001
      )
        return null;
    }
    if ((range["minDegrees"] as number) > (range["maxDegrees"] as number)) return null;
    seen.add(range["joint"]);
  }
  return raw as Motion3DSummary;
}

export function motion3DAngle(frame: Motion3DFrame, joint: Motion3DAngleJoint): number | null {
  if (frame.status !== "estimated") return null;
  const [a, b, c] = angleTriples[joint].map((name) =>
    frame.joints.find((point) => point.name === name),
  );
  if (!a || !b || !c) return null;
  const u = [a.x - b.x, a.y - b.y, a.z - b.z];
  const v = [c.x - b.x, c.y - b.y, c.z - b.z];
  const lengths = Math.hypot(...u) * Math.hypot(...v);
  if (!Number.isFinite(lengths) || lengths <= 1e-12) return null;
  const cosine = (u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!) / lengths;
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

export function summarizeMotion3D(artifact: Motion3DArtifact): Motion3DSummary {
  const estimated = artifact.frames.filter((frame) => frame.status === "estimated");
  return {
    sampleCount: artifact.frames.length,
    estimatedFrameCount: estimated.length,
    missingFrameCount: artifact.frames.filter((frame) => frame.status === "no_person").length,
    multiplePersonFrameCount: artifact.frames.filter((frame) => frame.status === "multiple_people")
      .length,
    unavailableFrameCount: artifact.frames.filter((frame) => frame.status === "unavailable").length,
    continuitySegments: new Set(estimated.map((frame) => frame.segmentId)).size,
    referenceScaleUsed: estimated.some((frame) => frame.height?.source === "reference"),
    angleRanges: MOTION_3D_ANGLE_JOINTS.flatMap((joint) => {
      const angles = estimated.flatMap((frame) => {
        const value = motion3DAngle(frame, joint);
        return value === null ? [] : [value];
      });
      return angles.length === 0
        ? []
        : [
            {
              joint,
              minDegrees: Math.round(Math.min(...angles) * 10) / 10,
              maxDegrees: Math.round(Math.max(...angles) * 10) / 10,
              sampleCount: angles.length,
            },
          ];
    }),
  };
}

export function buildMotion3DAnalysis(input: {
  id: string;
  captureId: string;
  createdAtIso: string;
  capturedAtIso: string;
  declaredStroke: ShotTypeSlug | null;
  declaredCanonical?: string | null;
  handedness: Handedness;
  artifactJson: string;
  artifactSha256: string;
}): Result<Motion3DAnalysis> {
  const invalid = () =>
    fail<Motion3DAnalysis>(
      failure(
        "corrupted_media",
        "motion_3d.invalid_analysis",
        "The 3D analysis could not be verified. No rating was created.",
      ),
    );
  const declaredCanonical = input.declaredCanonical ?? null;
  if (
    ![input.id, input.captureId].every(
      (id) => typeof id === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(id),
    ) ||
    ![input.createdAtIso, input.capturedAtIso].every(
      (value) => typeof value === "string" && Number.isFinite(Date.parse(value)),
    ) ||
    !["right", "left", "ambidextrous"].includes(input.handedness) ||
    (input.declaredStroke !== null &&
      !(SHOT_TYPES as readonly string[]).includes(input.declaredStroke)) ||
    (declaredCanonical !== null &&
      !SELECTABLE_TECHNIQUES_V1.some(
        (technique) =>
          technique.canonical === declaredCanonical &&
          technique.legacySlug === input.declaredStroke,
      ))
  )
    return invalid();
  const parsed = parseMotion3D(input.artifactJson);
  if (!parsed.ok) return parsed;
  if (
    parsed.value.source.captureId !== input.captureId ||
    sha256Hex(input.artifactJson) !== input.artifactSha256
  )
    return invalid();
  return ok(
    verified({
      artifact: parsed.value,
      artifactJson: input.artifactJson,
      record: {
        schemaVersion: 1,
        engine: "motion_3d",
        purpose: "development_validation",
        policyVersion: ANALYSIS_PLAN_VERSION,
        geometryVersion: MOTION_3D_GEOMETRY_VERSION,
        id: input.id,
        captureId: input.captureId,
        createdAtIso: input.createdAtIso,
        capturedAtIso: input.capturedAtIso,
        declaredStroke: input.declaredStroke,
        declaredCanonical,
        handedness: input.handedness,
        artifactSha256: input.artifactSha256,
        sourceVideoSha256: parsed.value.source.videoSha256,
        summary: summarizeMotion3D(parsed.value),
        capabilities: {
          visualization: "development_only",
          comparison: "blocked",
          coaching: "blocked",
          correction: "blocked",
          scoring: "blocked",
        },
      },
    }),
  );
}

export function parseMotion3DAnalysis(
  recordJson: string,
  artifactJson: string,
): Result<Motion3DAnalysis> {
  const invalid = () =>
    fail<Motion3DAnalysis>(
      failure(
        "corrupted_media",
        "motion_3d.invalid_analysis",
        "The saved 3D analysis is unsupported or could not be verified.",
      ),
    );
  if (typeof recordJson !== "string" || recordJson.length > 16_384) return invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(recordJson);
  } catch {
    return invalid();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const record = raw as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "engine",
    "purpose",
    "policyVersion",
    "geometryVersion",
    "id",
    "captureId",
    "createdAtIso",
    "capturedAtIso",
    "declaredStroke",
    "declaredCanonical",
    "handedness",
    "artifactSha256",
    "sourceVideoSha256",
    "summary",
    "capabilities",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    record["schemaVersion"] !== 1 ||
    record["engine"] !== "motion_3d" ||
    record["purpose"] !== "development_validation" ||
    record["policyVersion"] !== ANALYSIS_PLAN_VERSION ||
    record["geometryVersion"] !== MOTION_3D_GEOMETRY_VERSION ||
    ![
      "id",
      "captureId",
      "createdAtIso",
      "capturedAtIso",
      "handedness",
      "artifactSha256",
      "sourceVideoSha256",
    ].every((key) => typeof record[key] === "string") ||
    (record["declaredCanonical"] !== null && typeof record["declaredCanonical"] !== "string") ||
    (record["declaredStroke"] !== null && typeof record["declaredStroke"] !== "string")
  )
    return invalid();
  const parsed = buildMotion3DAnalysis({
    ...(record as unknown as Motion3DAnalysisRecord),
    artifactJson,
  });
  if (!parsed.ok) return parsed;
  const summary = retainedSummary(record["summary"], parsed.value.record.summary);
  const capabilities = record["capabilities"];
  if (
    record["sourceVideoSha256"] !== parsed.value.record.sourceVideoSha256 ||
    !summary ||
    !capabilities ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities) ||
    Object.keys(capabilities).length !== 5 ||
    Object.entries(parsed.value.record.capabilities).some(
      ([key, value]) => (capabilities as Record<string, unknown>)[key] !== value,
    )
  )
    return invalid();
  return ok(verified({ ...parsed.value, record: { ...parsed.value.record, summary } }));
}
