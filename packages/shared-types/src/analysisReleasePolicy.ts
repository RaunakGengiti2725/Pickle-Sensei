import {
  CAMERA_VIEWS,
  SHOT_TYPES,
  type CameraView,
  type Handedness,
  type ShotTypeSlug,
} from "./domain.js";
import {
  isAnalysisReleaseEligibility,
  type AnalysisReleaseEligibility,
} from "./analysisOutcome.js";
import {
  isVersionedArtifactReference,
  type NumericalOutputLineage,
  type VersionedArtifactReference,
} from "./techniqueBenchmark.js";

export const ANALYSIS_RELEASE_POLICY_SCHEMA_VERSION = "analysis-release-policy-v1" as const;
type Released = Extract<AnalysisReleaseEligibility, { status: "eligible" }>;
type ArtifactLineage = Omit<NumericalOutputLineage, "policy">;

export interface AnalysisReleaseInputDomain {
  shotType: ShotTypeSlug;
  cameraView: CameraView;
  handedness: Handedness;
  captureMode: "automatic_pose_trigger" | "imported_video";
}
export interface ObservedAnalysisReleaseInput extends AnalysisReleaseInputDomain {
  source: "real" | "fixture";
  intentConfirmed: boolean;
}

/** Canonical immutable artifact. The policy reference is its independently
 * computed digest, attached to output lineage only after hashing these bytes;
 * excluding that reference here avoids a self-referential hash. */
export interface AnalysisReleasePolicyDocument {
  schemaVersion: typeof ANALYSIS_RELEASE_POLICY_SCHEMA_VERSION;
  version: string;
  validFrom: number;
  validUntil: number;
  mechanics: { lineage: ArtifactLineage };
  benchmark: Omit<Released["benchmark"], "lineage"> & { lineage: ArtifactLineage };
  supportedInputs: AnalysisReleaseInputDomain[];
}

/** Server-owned decisions; never deserialize this from an analysis submission.
 * Approval of mechanics is independent of approval of the numerical benchmark.
 * Neither a deployed artifact nor a successful validator grants approval. */
export interface AnalysisReleaseApproval {
  policy: VersionedArtifactReference;
  mechanicsApprovedAt: number | null;
  benchmarkApprovedAt: number | null;
  withdrawnAt: number | null;
  denyNewAuthorizations: boolean;
}

const artifactKeys = [
  "pipeline",
  "definition",
  "model",
  "preprocessing",
  "calibration",
  "dataset",
  "validationReport",
  "supportedDomain",
] as const;
const inputKeys = ["shotType", "cameraView", "handedness", "captureMode"] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key))
  );
};
const timestamp = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 253_402_300_799;
const lineage = (value: unknown): value is ArtifactLineage =>
  record(value) &&
  exact(value, artifactKeys) &&
  artifactKeys.every((key) => isVersionedArtifactReference(value[key]));

function domain(value: unknown): value is AnalysisReleaseInputDomain {
  return (
    record(value) &&
    exact(value, inputKeys) &&
    SHOT_TYPES.some((shot) => shot === value.shotType) &&
    CAMERA_VIEWS.some((view) => view === value.cameraView) &&
    ["right", "left", "ambidextrous"].includes(String(value.handedness)) &&
    ["automatic_pose_trigger", "imported_video"].includes(String(value.captureMode))
  );
}

export function validateAnalysisReleasePolicy(
  value: unknown,
): value is AnalysisReleasePolicyDocument {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "version",
      "validFrom",
      "validUntil",
      "mechanics",
      "benchmark",
      "supportedInputs",
    ]) ||
    value.schemaVersion !== ANALYSIS_RELEASE_POLICY_SCHEMA_VERSION ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    value.version.length > 128 ||
    value.version.trim() !== value.version ||
    !timestamp(value.validFrom) ||
    !timestamp(value.validUntil) ||
    value.validFrom >= value.validUntil ||
    !record(value.mechanics) ||
    !exact(value.mechanics, ["lineage"]) ||
    !lineage(value.mechanics.lineage) ||
    !record(value.benchmark) ||
    !lineage(value.benchmark.lineage) ||
    !Array.isArray(value.supportedInputs) ||
    value.supportedInputs.length === 0 ||
    value.supportedInputs.length > 128 ||
    Reflect.ownKeys(value.supportedInputs).length !== value.supportedInputs.length + 1 ||
    !Array.from(value.supportedInputs).every(domain)
  )
    return false;
  const mechanics = value.mechanics.lineage;
  const benchmark = value.benchmark.lineage;
  if (
    mechanics.pipeline.version !== benchmark.pipeline.version ||
    mechanics.pipeline.sha256 !== benchmark.pipeline.sha256
  )
    return false;
  // The real policy digest is computed independently by the loader. This
  // local reference checks only the remaining shared boundary constraints.
  const shapeReference = { version: value.version, sha256: "0".repeat(64) };
  return isAnalysisReleaseEligibility({
    status: "eligible",
    mechanics: { lineage: { ...mechanics, policy: shapeReference } },
    benchmark: { ...value.benchmark, lineage: { ...benchmark, policy: shapeReference } },
  });
}

export function resolveAnalysisReleaseEligibility(
  document: unknown,
  approval: unknown,
  observed: unknown,
  nowEpochSeconds: number,
): AnalysisReleaseEligibility {
  const unavailable = (
    reasonCode: Extract<AnalysisReleaseEligibility, { status: "ineligible" }>["reasonCode"],
  ): AnalysisReleaseEligibility => ({ status: "ineligible", reasonCode });
  if (
    !validateAnalysisReleasePolicy(document) ||
    !validateAnalysisReleaseApproval(approval) ||
    !timestamp(nowEpochSeconds)
  )
    return unavailable("unverified");
  if (document.version !== approval.policy.version) return unavailable("lineage_mismatch");
  if (
    approval.denyNewAuthorizations ||
    (typeof approval.withdrawnAt === "number" && approval.withdrawnAt <= nowEpochSeconds)
  )
    return unavailable("withdrawn");
  if (
    typeof approval.mechanicsApprovedAt !== "number" ||
    typeof approval.benchmarkApprovedAt !== "number" ||
    approval.mechanicsApprovedAt > nowEpochSeconds ||
    approval.benchmarkApprovedAt > nowEpochSeconds ||
    nowEpochSeconds < document.validFrom
  )
    return unavailable("unreleased");
  if (nowEpochSeconds >= document.validUntil) return unavailable("expired");
  if (
    !record(observed) ||
    !exact(observed, [...inputKeys, "source", "intentConfirmed"]) ||
    observed.source !== "real" ||
    observed.intentConfirmed !== true ||
    !document.supportedInputs.some((candidate) =>
      inputKeys.every((key) => candidate[key] === observed[key]),
    )
  )
    return unavailable("unsupported");
  return {
    status: "eligible",
    mechanics: { lineage: { ...document.mechanics.lineage, policy: approval.policy } },
    benchmark: {
      ...document.benchmark,
      lineage: { ...document.benchmark.lineage, policy: approval.policy },
    },
  };
}

export function validateAnalysisReleaseApproval(value: unknown): value is AnalysisReleaseApproval {
  return (
    record(value) &&
    exact(value, [
      "policy",
      "mechanicsApprovedAt",
      "benchmarkApprovedAt",
      "withdrawnAt",
      "denyNewAuthorizations",
    ]) &&
    isVersionedArtifactReference(value.policy) &&
    typeof value.denyNewAuthorizations === "boolean" &&
    [value.mechanicsApprovedAt, value.benchmarkApprovedAt, value.withdrawnAt].every(
      (at) => at === null || timestamp(at),
    )
  );
}
