import type { Result, VersionedArtifactReference } from "@pickle/shared-types";
import { fail, failure, isVersionedArtifactReference, ok } from "@pickle/shared-types";
import { sha256Hex } from "@pickle/swing-domain";
import {
  BENCHMARK_PROVENANCES,
  type BenchmarkProvenance,
  type BenchmarkReport,
} from "./benchmark.js";

/**
 * Real-footage benchmark manifests and dataset splitting.
 *
 * Rules encoded here rather than in review comments:
 * - A real benchmark's provenance can never be "synthetic"; the loader
 *   rejects it, so synthetic sequences cannot masquerade as human data.
 * - Every case is keyed to consented capture bytes by SHA-256, so a
 *   benchmark result can always be traced to exact inputs.
 * - Splits are grouped by PLAYER, not by clip: clips of the same person in
 *   train and test would leak identity-specific style and inflate metrics.
 *   The split is a deterministic hash of (datasetId, playerId) so it never
 *   changes when cases are added or reordered.
 */

export const REAL_BENCHMARK_SCHEMA_VERSION = 1 as const;

export type DatasetSplit = "train" | "val" | "test";

export interface RealBenchmarkCase {
  caseId: string;
  /** SHA-256 of the exact video bytes this case was labeled against. */
  videoSha256: string;
  /** SHA-256 of the pose-sequence sidecar used for machine measurements. */
  poseSequenceSha256: string;
  /** Stable pseudonymous player key — the unit of split grouping. */
  playerId: string;
  declaredStroke: string;
  /** Path to the annotation file (labels live there, not in the manifest). */
  annotationPath: string;
  techniqueMetadata?: RealTechniqueBenchmarkMetadata;
}

export interface RealBenchmarkManifest {
  schemaVersion: typeof REAL_BENCHMARK_SCHEMA_VERSION;
  id: string;
  version: string;
  createdAtIso: string;
  provenance: Exclude<BenchmarkProvenance, "synthetic">;
  /** Split ratios must sum to 1; applied per player group. */
  splitRatios: { train: number; val: number; test: number };
  cases: RealBenchmarkCase[];
}

export const REAL_TECHNIQUE_METADATA_SCHEMA_VERSION = "real-technique-metadata-v1" as const;
export const REAL_TECHNIQUE_METADATA_TRUST_BOUNDARY =
  "Structural metadata and partition checks only: no evidence authentication, rights clearance, coach qualification, rating-anchor eligibility or numerical release approval is performed here.";

export interface PlayerRatingObservation {
  observationId: string;
  playerId: string;
  provider: "DUPR";
  ratingType: string;
  ratingVariant: string | null;
  value: number;
  ratingAsOfIso: string | null;
  observedAtIso: string;
  evidenceRole: "noisy_player_anchor_not_swing_truth";
  reliability:
    { status: "recorded"; scorePercent: number } | { status: "unavailable"; scorePercent?: never };
  verification:
    | {
        status: "verified";
        evidenceRef: string;
        evidenceSha256: string;
        verifierRef: string;
        verifiedAtIso: string;
      }
    | { status: "unverified"; reasonCode: "self_reported" | "source_unverified" };
  recordingAlignment:
    | { status: "historically_verified"; evidenceRef: string; evidenceSha256: string }
    | { status: "unverified" };
}

export interface CoachTechniqueReviewReference {
  reviewId: string;
  coachId: string;
  reviewSha256: string;
  qualificationPolicyVersion: string;
  qualificationEvidenceRef: string;
  reviewedAtIso: string;
  blindedToModelOutput: boolean | null;
  blindedToPlayerRatings: boolean | null;
}

export interface RealTechniqueBenchmarkMetadata {
  schemaVersion: typeof REAL_TECHNIQUE_METADATA_SCHEMA_VERSION;
  purpose: "validation_and_confound_analysis_only";
  protocol: VersionedArtifactReference | null;
  recordedAtIso: string | null;
  independence: {
    participantIds: string[];
    sessionId: string;
    recordingId: string;
    rawSourceSha256: string;
    duplicateGroupIds: string[];
  };
  eligibilityManifest: {
    schemaId: "eligible-temporal-dataset-v2";
    artifact: VersionedArtifactReference;
    itemId: string;
  } | null;
  playerRatings: PlayerRatingObservation[];
  coachReviews: CoachTechniqueReviewReference[];
}

export type RealBenchmarkPartition = DatasetSplit | "calibration" | "external_test";
export type PartitionedRealBenchmarkCase = RealBenchmarkCase & { split: RealBenchmarkPartition };

export function validateRealBenchmarkManifest(raw: unknown): Result<RealBenchmarkManifest> {
  const manifest = raw as Partial<RealBenchmarkManifest> | null;
  if (!manifest || typeof manifest !== "object") {
    return invalid("real_benchmark.not_object", "Manifest root must be an object.");
  }
  if (manifest.schemaVersion !== REAL_BENCHMARK_SCHEMA_VERSION) {
    return invalid(
      "real_benchmark.unsupported_schema",
      `Unsupported schema version ${String(manifest.schemaVersion)}.`,
    );
  }
  if (
    typeof manifest.provenance !== "string" ||
    manifest.provenance === ("synthetic" as string) ||
    !BENCHMARK_PROVENANCES.includes(manifest.provenance as BenchmarkProvenance)
  ) {
    return invalid(
      "real_benchmark.invalid_provenance",
      `Real benchmark provenance must be one of ${BENCHMARK_PROVENANCES.filter(
        (value) => value !== "synthetic",
      ).join(
        ", ",
      )}; got ${String(manifest.provenance)}. Synthetic data must use the synthetic benchmark path.`,
    );
  }
  const ratios = manifest.splitRatios;
  if (
    !ratios ||
    ![ratios.train, ratios.val, ratios.test].every(
      (value) => typeof value === "number" && value >= 0 && value <= 1,
    ) ||
    Math.abs(ratios.train + ratios.val + ratios.test - 1) > 1e-9
  ) {
    return invalid("real_benchmark.invalid_split", "splitRatios must be fractions summing to 1.");
  }
  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    return invalid("real_benchmark.missing_id", "Manifest id is required.");
  }
  if (!Array.isArray(manifest.cases)) {
    return invalid("real_benchmark.invalid_cases", "cases must be an array.");
  }
  const seenCaseIds = new Set<string>();
  for (const [index, benchmarkCase] of manifest.cases.entries()) {
    if (
      !benchmarkCase ||
      typeof benchmarkCase.caseId !== "string" ||
      !/^[0-9a-f]{64}$/.test(benchmarkCase.videoSha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(benchmarkCase.poseSequenceSha256 ?? "") ||
      typeof benchmarkCase.playerId !== "string" ||
      benchmarkCase.playerId.length === 0 ||
      typeof benchmarkCase.declaredStroke !== "string" ||
      typeof benchmarkCase.annotationPath !== "string"
    ) {
      return invalid(
        "real_benchmark.corrupt_case",
        `Case ${index} is missing required fields or has malformed hashes.`,
      );
    }
    if (seenCaseIds.has(benchmarkCase.caseId)) {
      return invalid("real_benchmark.duplicate_case", `Duplicate caseId ${benchmarkCase.caseId}.`);
    }
    seenCaseIds.add(benchmarkCase.caseId);
    if (Object.hasOwn(benchmarkCase, "techniqueMetadata")) {
      const metadata = validateRealTechniqueBenchmarkMetadata(benchmarkCase.techniqueMetadata);
      if (!metadata.ok) return metadata;
      if (!metadataMatchesPlayer(metadata.value, benchmarkCase.playerId)) {
        return invalid(
          "real_benchmark.metadata_player_mismatch",
          `Case ${index} has unrelated player metadata.`,
        );
      }
    }
  }
  return ok(manifest as RealBenchmarkManifest);
}

/**
 * Deterministic player-grouped split. The same (datasetId, playerId) always
 * lands in the same split regardless of case count or ordering, so growing
 * the dataset never silently moves a player from test into train.
 */
export function splitForPlayer(
  datasetId: string,
  playerId: string,
  ratios: { train: number; val: number; test: number },
): DatasetSplit {
  const digest = sha256Hex(`${datasetId}\u0000${playerId}`);
  // First 12 hex chars → uniform fraction in [0, 1).
  const fraction = parseInt(digest.slice(0, 12), 16) / 0x1000000000000;
  if (fraction < ratios.train) return "train";
  if (fraction < ratios.train + ratios.val) return "val";
  return "test";
}

export function assignSplits(
  manifest: RealBenchmarkManifest,
): Array<RealBenchmarkCase & { split: DatasetSplit }> {
  return manifest.cases.map((benchmarkCase) => ({
    ...benchmarkCase,
    split: splitForPlayer(manifest.id, benchmarkCase.playerId, manifest.splitRatios),
  }));
}

/**
 * Report banner: synthetic and real results must never be visually
 * conflatable in logs or docs.
 */
export function reportBanner(report: BenchmarkReport): string {
  const tag = report.benchmark.provenance === "synthetic" ? "SYNTHETIC" : "REAL";
  return `[${tag}] ${report.benchmark.id}@${report.benchmark.version} · ${report.benchmark.task} · ${report.benchmark.caseCount} cases · subject ${report.subject}`;
}

export function validateRealTechniqueBenchmarkMetadata(
  raw: unknown,
): Result<RealTechniqueBenchmarkMetadata> {
  if (
    !isMetadataRecord(raw) ||
    !hasExactMetadataFields(raw, [
      "schemaVersion",
      "purpose",
      "protocol",
      "recordedAtIso",
      "independence",
      "eligibilityManifest",
      "playerRatings",
      "coachReviews",
    ]) ||
    raw.schemaVersion !== REAL_TECHNIQUE_METADATA_SCHEMA_VERSION ||
    raw.purpose !== "validation_and_confound_analysis_only" ||
    (raw.protocol !== null && !isVersionedArtifactReference(raw.protocol)) ||
    (raw.recordedAtIso !== null && !isMetadataInstant(raw.recordedAtIso))
  ) {
    return invalid(
      "real_benchmark.invalid_technique_metadata",
      "Expected versioned validation-only metadata with explicit unknowns.",
    );
  }
  const independence = raw.independence;
  if (
    !isMetadataRecord(independence) ||
    !hasExactMetadataFields(independence, [
      "participantIds",
      "sessionId",
      "recordingId",
      "rawSourceSha256",
      "duplicateGroupIds",
    ]) ||
    !isOpaqueIdArray(independence.participantIds, 1, 64) ||
    !isOpaqueId(independence.sessionId) ||
    !isOpaqueId(independence.recordingId) ||
    !isMetadataSha256(independence.rawSourceSha256) ||
    !isOpaqueIdArray(independence.duplicateGroupIds, 0, 128)
  ) {
    return invalid(
      "real_benchmark.invalid_independence",
      "Participant, recording, session and duplicate lineage are required.",
    );
  }
  const eligibility = raw.eligibilityManifest;
  if (
    eligibility !== null &&
    (!isMetadataRecord(eligibility) ||
      !hasExactMetadataFields(eligibility, ["schemaId", "artifact", "itemId"]) ||
      eligibility.schemaId !== "eligible-temporal-dataset-v2" ||
      !isVersionedArtifactReference(eligibility.artifact) ||
      !isOpaqueId(eligibility.itemId))
  ) {
    return invalid(
      "real_benchmark.invalid_eligibility_reference",
      "Reference the existing consent/rights manifest or record null; a reference is not clearance.",
    );
  }
  if (!Array.isArray(raw.playerRatings) || raw.playerRatings.length > 256) {
    return invalid(
      "real_benchmark.invalid_player_ratings",
      "playerRatings must be an explicit bounded array.",
    );
  }
  const observations = new Set<string>();
  for (const rating of raw.playerRatings as unknown[]) {
    if (
      !isPlayerRatingObservation(rating, raw.recordedAtIso as string | null) ||
      !independence.participantIds.includes(rating.playerId) ||
      observations.has(rating.observationId)
    ) {
      return invalid(
        "real_benchmark.invalid_player_rating",
        "Player ratings require distinct, attributed metadata; they are never exact swing labels.",
      );
    }
    observations.add(rating.observationId);
  }
  if (!Array.isArray(raw.coachReviews) || raw.coachReviews.length > 256) {
    return invalid(
      "real_benchmark.invalid_coach_references",
      "coachReviews must be an explicit bounded array.",
    );
  }
  const reviews = new Set<string>();
  for (const review of raw.coachReviews as unknown[]) {
    if (
      !isCoachReviewReference(review) ||
      reviews.has(review.reviewId) ||
      (typeof raw.recordedAtIso === "string" &&
        Date.parse(review.reviewedAtIso) < Date.parse(raw.recordedAtIso))
    ) {
      return invalid(
        "real_benchmark.invalid_coach_reference",
        "Coach reviews require distinct hashed references and qualification lineage, not fabricated labels.",
      );
    }
    reviews.add(review.reviewId);
  }
  return ok(raw as unknown as RealTechniqueBenchmarkMetadata);
}

export function validateRealBenchmarkPartitionIsolation(
  raw: unknown,
): Result<PartitionedRealBenchmarkCase[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(
      "real_benchmark.invalid_partitions",
      "Partition validation requires an explicit nonempty case list.",
    );
  }
  const groups = new Map<string, string>();
  const caseIds = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (
      !isMetadataRecord(entry) ||
      !isOpaqueId(entry.caseId) ||
      !isOpaqueId(entry.playerId) ||
      !isMetadataSha256(entry.videoSha256) ||
      !isMetadataSha256(entry.poseSequenceSha256) ||
      !isMetadataText(entry.declaredStroke) ||
      !isMetadataText(entry.annotationPath) ||
      typeof entry.split !== "string" ||
      !["train", "val", "calibration", "test", "external_test"].includes(entry.split)
    ) {
      return invalid(
        "real_benchmark.invalid_partition_case",
        "Every case requires exact input hashes and an explicit known partition.",
      );
    }
    if (caseIds.has(entry.caseId)) {
      return invalid(
        "real_benchmark.duplicate_case",
        "A partitioned case id must appear only once.",
      );
    }
    caseIds.add(entry.caseId);
    const metadata = validateRealTechniqueBenchmarkMetadata(entry.techniqueMetadata);
    if (!metadata.ok) return metadata;
    if (!metadataMatchesPlayer(metadata.value, entry.playerId)) {
      return invalid(
        "real_benchmark.metadata_player_mismatch",
        "Partitioned case metadata must bind to its target player.",
      );
    }
    const independence = metadata.value.independence;
    const keys = [
      ...independence.participantIds.map((player) => `participant:${player}`),
      `session:${independence.sessionId}`,
      `recording:${independence.recordingId}`,
      `bytes:${independence.rawSourceSha256}`,
      `bytes:${entry.videoSha256}`,
      `bytes:${entry.poseSequenceSha256}`,
      ...independence.duplicateGroupIds.map((group) => `duplicate:${group}`),
    ];
    for (const key of keys) {
      const assigned = groups.get(key);
      if (assigned !== undefined && assigned !== entry.split) {
        return invalid(
          "real_benchmark.partition_leakage",
          "Connected participant, session, recording, raw bytes or duplicate groups cross partitions.",
        );
      }
      groups.set(key, entry.split);
    }
  }
  return ok(raw as PartitionedRealBenchmarkCase[]);
}

function metadataMatchesPlayer(
  metadata: RealTechniqueBenchmarkMetadata,
  playerId: string,
): boolean {
  return (
    metadata.independence.participantIds.includes(playerId) &&
    metadata.playerRatings.every((rating) => rating.playerId === playerId)
  );
}

function isPlayerRatingObservation(
  value: unknown,
  recordedAtIso: string | null,
): value is PlayerRatingObservation {
  if (
    !isMetadataRecord(value) ||
    !hasExactMetadataFields(value, [
      "observationId",
      "playerId",
      "provider",
      "ratingType",
      "ratingVariant",
      "value",
      "ratingAsOfIso",
      "observedAtIso",
      "evidenceRole",
      "reliability",
      "verification",
      "recordingAlignment",
    ]) ||
    !isOpaqueId(value.observationId) ||
    !isOpaqueId(value.playerId) ||
    value.provider !== "DUPR" ||
    !isMetadataText(value.ratingType) ||
    (value.ratingVariant !== null && !isMetadataText(value.ratingVariant)) ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    value.value < 2 ||
    value.value > 8 ||
    !isMetadataInstant(value.observedAtIso) ||
    (value.ratingAsOfIso !== null &&
      (!isRatingAsOfIso(value.ratingAsOfIso) ||
        Date.parse(value.ratingAsOfIso) > Date.parse(value.observedAtIso))) ||
    value.evidenceRole !== "noisy_player_anchor_not_swing_truth" ||
    !isMetadataRecord(value.reliability) ||
    !isMetadataRecord(value.verification) ||
    !isMetadataRecord(value.recordingAlignment)
  ) {
    return false;
  }
  const reliability = value.reliability;
  if (reliability.status === "recorded") {
    if (
      !hasExactMetadataFields(reliability, ["status", "scorePercent"]) ||
      typeof reliability.scorePercent !== "number" ||
      !Number.isFinite(reliability.scorePercent) ||
      reliability.scorePercent < 0 ||
      reliability.scorePercent > 100
    )
      return false;
  } else if (
    reliability.status !== "unavailable" ||
    !hasExactMetadataFields(reliability, ["status"])
  ) {
    return false;
  }
  const verification = value.verification;
  if (verification.status === "verified") {
    if (
      !hasExactMetadataFields(verification, [
        "status",
        "evidenceRef",
        "evidenceSha256",
        "verifierRef",
        "verifiedAtIso",
      ]) ||
      !isOpaqueId(verification.evidenceRef) ||
      !isMetadataSha256(verification.evidenceSha256) ||
      !isOpaqueId(verification.verifierRef) ||
      !isMetadataInstant(verification.verifiedAtIso) ||
      Date.parse(verification.verifiedAtIso) < Date.parse(value.observedAtIso)
    )
      return false;
  } else if (
    verification.status !== "unverified" ||
    !hasExactMetadataFields(verification, ["status", "reasonCode"]) ||
    (verification.reasonCode !== "self_reported" && verification.reasonCode !== "source_unverified")
  ) {
    return false;
  }
  const alignment = value.recordingAlignment;
  if (alignment.status === "unverified") return hasExactMetadataFields(alignment, ["status"]);
  return (
    alignment.status === "historically_verified" &&
    hasExactMetadataFields(alignment, ["status", "evidenceRef", "evidenceSha256"]) &&
    isOpaqueId(alignment.evidenceRef) &&
    isMetadataSha256(alignment.evidenceSha256) &&
    verification.status === "verified" &&
    value.ratingAsOfIso !== null &&
    recordedAtIso !== null
  );
}

function isCoachReviewReference(value: unknown): value is CoachTechniqueReviewReference {
  return (
    isMetadataRecord(value) &&
    hasExactMetadataFields(value, [
      "reviewId",
      "coachId",
      "reviewSha256",
      "qualificationPolicyVersion",
      "qualificationEvidenceRef",
      "reviewedAtIso",
      "blindedToModelOutput",
      "blindedToPlayerRatings",
    ]) &&
    isOpaqueId(value.reviewId) &&
    isOpaqueId(value.coachId) &&
    isMetadataSha256(value.reviewSha256) &&
    isMetadataText(value.qualificationPolicyVersion) &&
    isOpaqueId(value.qualificationEvidenceRef) &&
    isMetadataInstant(value.reviewedAtIso) &&
    (value.blindedToModelOutput === null || typeof value.blindedToModelOutput === "boolean") &&
    (value.blindedToPlayerRatings === null || typeof value.blindedToPlayerRatings === "boolean")
  );
}

function isOpaqueIdArray(value: unknown, min: number, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    new Set(value).size === value.length &&
    Array.from(value).every(isOpaqueId)
  );
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactMetadataFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key))
  );
}

function isMetadataText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isMetadataSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRatingAsOfIso(value: unknown): value is string {
  return (
    isMetadataInstant(value) ||
    (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value)
  );
}

function isMetadataInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  return (
    match !== null &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
  );
}

function invalid<T>(code: string, message: string): Result<T> {
  return fail(failure("permanent", code, message));
}
