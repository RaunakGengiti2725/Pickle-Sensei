import {
  fail,
  failure,
  independentTrialsForZeroEventUpperBound95,
  isVersionedArtifactReference,
  ok,
  zeroEventUpperBound95,
  type Result,
  type VersionedArtifactReference,
} from "@pickle/shared-types";
import { calibrationReport, meanAbsoluteError, timingReport } from "./metrics.js";
import {
  validateRealBenchmarkPartitionIsolation,
  validateRealTechniqueBenchmarkMetadata,
  type PartitionedRealBenchmarkCase,
  type PlayerRatingObservation,
  type RealBenchmarkPartition,
  type RealTechniqueBenchmarkMetadata,
} from "./realBenchmark.js";

export const BENCHMARK_RELEASE_STUDY_SCHEMA_VERSION = "technique-benchmark-study-v1" as const;
export const BENCHMARK_RELEASE_REPORT_SCHEMA_VERSION =
  "technique-benchmark-release-report-v1" as const;
export const BENCHMARK_PARTITION_ROLES = Object.freeze({
  train: "training",
  val: "model_selection",
  calibration: "uncertainty_calibration",
  test: "locked_final_test",
  external_test: "external_generalization",
});
export const BENCHMARK_RELEASE_GATE_IDS = Object.freeze([
  "independent_evidence",
  "coach_agreement",
  "primary_error",
  "proxy_rating_validity",
  "range_coverage",
  "useful_width",
  "selective_coverage",
  "gross_error",
  "probability_calibration",
  "rating_type_confounding",
  "perturbations",
  "subgroups",
  "frozen_mechanics_fault_drill_gates",
] as const);
export const PROPOSED_BENCHMARK_RELEASE_TARGETS = Object.freeze({
  status: "PROPOSED_NOT_RATIFIED",
  independentPlayers: Object.freeze({ overall: 300, perStroke: 100, perStrokeReferenceBand: 50 }),
  coachAgreement: Object.freeze({ minimum: 0.75, minimumLower95: 0.6 }),
  primaryError: Object.freeze({
    maximumMae: 0.35,
    maximumUpper95: 0.5,
    sliceMaximumMae: 0.5,
    sliceMaximumUpper95: 0.75,
  }),
  rangeCoverage: Object.freeze({ nominal: 0.9, minimumEmpirical: 0.9, minimumLower95: 0.85 }),
  usefulWidth: Object.freeze({ maximumMedian: 1, maximumP90: 1.5, separatelyEvaluatedWidth: 0.5 }),
  selectiveCoverage: Object.freeze({ minimum: 0.5 }),
  grossError: Object.freeze({ errorExceedingLevels: 1, maximumUpper95: 0.02 }),
  probabilityCalibration: Object.freeze({ maximumEce: 0.05 }),
  ratingTypeConfounding: Object.freeze({
    residualBiasInvestigation: 0.25,
    maeDegradationInvestigation: 0.15,
  }),
  perturbations: Object.freeze({
    identicalOutputDelta: 0,
    maximumMedianMidpointDelta: 0.25,
    maximumP95MidpointDelta: 0.5,
  }),
  ratingMetadata: Object.freeze({ initialReliabilityFloorPercent: 60 }),
});
export const BENCHMARK_SUBGROUP_DIMENSIONS = Object.freeze([
  "device_os",
  "camera_view",
  "capture_conditions",
  "handedness",
  "participant_subgroup",
] as const);
export const W06_PROTECTED_CASE_IDS = Object.freeze(["wm-dink-01", "afn-vic-rally1"] as const);
export const W06_PROTECTED_SESSION_IDS = Object.freeze([
  "wm-tournament-2014",
  "afn-vic-2025",
] as const);
const protectedSourceHashes = new Set([
  "024decaeb66e7eacd2b4d98673aa3adc02d00af591afcc5ccc851a679836a05c",
  "274544640cc6483e3ce0a677c49054e59658d84a90c72637a753a1fdfe2f1611",
  "72cd8795bdc2be6860a16ffa7245d4b889ea4c2482c3001812b883ed9e0486f6",
  "7d396a6d65669fc3b7fc3c33988e257be08f830e93ca20c51f38171fca0959a7",
  "8b77606225ba0e3543accc6195c7fb10a7d312f445a73a5e4a03ab68b8862c15",
  "ac6c9d7b50558a0cb02dd3253841a9a3a68b3c7d8b602f6ee30142f7c07d3d8f",
  "b6f280b2900c9f338daa7d5e6b4ac82a8ba4b8ff74d1c7762e3e0905ee946b62",
]);
const partitions = Object.keys(BENCHMARK_PARTITION_ROLES) as RealBenchmarkPartition[];
const robustnessKinds = ["reencode", "crop", "brightness", "fps"] as const;
const evidenceKeys = [
  "coachAgreement",
  "groupedUncertainty",
  "simultaneousCoverage",
  "proxyRatingValidity",
  "ratingTypeConfounding",
  "frozenMechanicsFaultDrillGates",
] as const;
const subjectKeys = [
  "pipeline",
  "definition",
  "model",
  "preprocessing",
  "calibration",
  "supportedDomain",
] as const;
type SubgroupDimension = (typeof BENCHMARK_SUBGROUP_DIMENSIONS)[number];
type GateId = (typeof BENCHMARK_RELEASE_GATE_IDS)[number];
type Interval = { lower: number; upper: number };

export interface BenchmarkProtocolSubmission {
  artifact: VersionedArtifactReference;
  status: "proposed" | "unapproved";
  rubric: VersionedArtifactReference | null;
  powerPrecision: VersionedArtifactReference | null;
  groupedUncertaintyMethod: VersionedArtifactReference | null;
  simultaneousInferenceMethod: VersionedArtifactReference | null;
  intervalLoss: VersionedArtifactReference | null;
  probabilityEvent: VersionedArtifactReference | null;
  highConfidenceThreshold: number | null;
  frozenBeforeEvaluationEvidence: VersionedArtifactReference | null;
}

export type BenchmarkCandidateSubject = Record<
  (typeof subjectKeys)[number],
  VersionedArtifactReference
> & {
  modelKind: "multivariate_form" | "ordinal_form" | "distributional_form";
  inputKinds: Array<
    "observed_form" | "temporal_motion" | "confirmed_stroke" | "handedness" | "capture_geometry"
  >;
};

export type BenchmarkPrediction =
  | { status: "abstained"; reason: string }
  | {
      status: "range";
      interval: Interval;
      unformattedInterval: Interval;
      nominalCoverage: number;
      calibrationEvent: {
        definition: VersionedArtifactReference;
        probability: number;
        outcome: boolean;
      } | null;
      grosslyWrongCoachVerdict: boolean | null;
    };

export interface BenchmarkReleaseCase {
  input: PartitionedRealBenchmarkCase & { techniqueMetadata: RealTechniqueBenchmarkMetadata };
  dataOrigin:
    "consented_first_party_capture" | "commissioned_capture" | "licensed_media" | "synthetic_test";
  supportedInput: boolean;
  referenceBand: number | null;
  subgroups: Record<SubgroupDimension, string | null>;
  swingTarget: {
    kind: "independent_coach_swing_interval";
    interval: Interval;
    reviewIds: string[];
    disagreement: boolean;
    adjudicationReviewId: string | null;
  } | null;
  prediction: BenchmarkPrediction;
}

export interface BenchmarkPerturbation {
  caseId: string;
  kind: "identical_bytes" | "reencode" | "crop" | "brightness" | "fps" | "padding" | "unsupported";
  variantVideoSha256: string;
  baselineVersionsAndIntentSha256: string;
  variantVersionsAndIntentSha256: string;
  measurement: "full_video_pipeline" | "synthetic_math";
  evidence: VersionedArtifactReference | null;
  prediction: BenchmarkPrediction;
  baselineRecoveryDecision: string | null;
  variantRecoveryDecision: string | null;
}

export interface BenchmarkReleaseStudy {
  schemaVersion: typeof BENCHMARK_RELEASE_STUDY_SCHEMA_VERSION;
  protocol: BenchmarkProtocolSubmission | null;
  subject: BenchmarkCandidateSubject | null;
  scope: {
    strokes: string[];
    referenceBands: number[];
    subgroups: Array<{ dimension: SubgroupDimension; value: string }>;
  };
  cases: BenchmarkReleaseCase[];
  evidence: Record<(typeof evidenceKeys)[number], VersionedArtifactReference | null>;
  perturbations: BenchmarkPerturbation[];
}

export interface BenchmarkSupport {
  cases: number;
  players: number;
  physicalRecordings: number;
  sessions: number;
  independentUnits: number;
}

export interface BenchmarkSliceDiagnostic {
  partition: "test" | "external_test";
  id: string;
  support: BenchmarkSupport;
  proposedMinimumIndependentPlayers: number | null;
  proposedEvidenceFloorMet: boolean;
  supportedAttempts: number;
  unsupportedAttempts: number;
  abstentions: number;
  numericalOutputs: number;
  numericalCoverage: number | null;
  displayedIntervalCoverage: number | null;
  coverageDefinition: "whole_coach_target_contained_in_displayed_interval_player_weighted_diagnostic";
  coverageConfidenceInterval: null;
  intervalLossBounds: {
    minimumPossiblePlayerWeightedMae: number;
    maximumPossiblePlayerWeightedMae: number;
    interpretation: "target_ambiguity_not_confidence_interval";
  } | null;
  maeConfidenceInterval: null;
  width: { median: number; p90: number; p90Method: "nearest_rank" } | null;
  halfLevelRanges: { count: number; coverage: number | null; lower95: null };
  probabilityCalibration: ReturnType<typeof probabilityDiagnostic> | null;
  probabilityCalibrationByEvent: Array<ReturnType<typeof probabilityDiagnostic>>;
  grossError: {
    independentUnits: number;
    observedErrorUnits: number;
    unresolvedUnits: number;
    upper95: null;
  };
  proposedViolations: GateId[];
  missingEvidence: string[];
}

export interface BenchmarkDiagnosticReport {
  evidenceStatus: "NOT_RELEASE_EVIDENCE";
  provenance: "synthetic_math_only" | "unverified_candidate_diagnostics";
  missingPartitions: RealBenchmarkPartition[];
  missingSubgroupDimensions: SubgroupDimension[];
  slices: BenchmarkSliceDiagnostic[];
  proxyRatings: Array<{
    playerId: string;
    observation: PlayerRatingObservation;
    initialMetadataPrerequisitesPresent: boolean;
    evidenceAuthenticated: false;
    representativeSwingSelection: "NOT_EVALUABLE";
  }>;
  proxyValidity: { status: "NOT_EVALUABLE"; reason: string };
  perturbations: ReturnType<typeof perturbationDiagnostics>;
}

export interface BenchmarkReleaseBlocker {
  code: string;
  status: "BLOCKED_EXTERNAL" | "NOT_EVALUABLE";
  action: string;
  caseIds: string[];
}

export interface BenchmarkReleaseReport {
  schemaVersion: typeof BENCHMARK_RELEASE_REPORT_SCHEMA_VERSION;
  status: "BLOCKED_EXTERNAL" | "NOT_EVALUABLE";
  numericalReleaseAuthorized: false;
  scientificResults: null;
  protocol: BenchmarkProtocolSubmission | null;
  subject: BenchmarkCandidateSubject | null;
  proposedTargets: typeof PROPOSED_BENCHMARK_RELEASE_TARGETS;
  partitionRoles: typeof BENCHMARK_PARTITION_ROLES;
  gates: Array<{ id: GateId; verdict: "NOT_EVALUABLE"; requiredEvidence: string[] }>;
  blockers: BenchmarkReleaseBlocker[];
  diagnostics: BenchmarkDiagnosticReport | null;
}

const gateRequirements: Record<GateId, string[]> = {
  independent_evidence: [
    "authenticated_eligible_dataset",
    "five_disjoint_connected_partitions",
    "player_and_recording_denominators",
    "ratified_power_precision_plan",
  ],
  coach_agreement: [
    "two_independently_provisioned_qualified_coaches",
    "blinded_original_reviews_and_adjudication",
    "frozen_rubric",
    "approved_grouped_agreement_lower95",
  ],
  primary_error: [
    "independent_swing_target_not_player_rating",
    "approved_interval_aware_loss",
    "player_weighted_mae_and_grouped_upper95",
  ],
  proxy_rating_validity: [
    "verified_historically_aligned_ratings",
    "prespecified_representative_swings",
    "mae_rmse_rank_bias_calibration_per_rating_definition",
  ],
  range_coverage: [
    "displayed_range_coverage",
    "grouped_lower95",
    "simultaneous_slice_uncertainty",
    "separate_half_level_range_coverage",
  ],
  useful_width: [
    "released_domain_displayed_width_distribution",
    "outward_rounding_and_clamping_replay",
  ],
  selective_coverage: [
    "prespecified_supported_population",
    "all_attempts_and_abstentions",
    "pooled_and_per_stroke_coverage",
  ],
  gross_error: [
    "preregistered_high_confidence_event_and_independent_unit",
    "qualified_gross_error_verdicts",
    "approved_nonzero_or_exact_zero_event_upper95",
  ],
  probability_calibration: [
    "frozen_level_band_probability_events_not_visibility",
    "reliability_bins_and_brier_or_interval_score",
    "independent_sample_support",
  ],
  rating_type_confounding: [
    "stratified_and_adjusted_residual_bias",
    "matched_comparisons_and_sensitivity",
    "pooled_reference_mae_degradation",
    "no_runtime_rating_metadata_shortcuts",
  ],
  perturbations: [
    "full_video_pipeline_variants",
    "identical_bytes_versions_intent_output",
    "supported_reencode_crop_brightness_fps_pairs",
    "unsupported_abstentions",
    "padding_recovery_invariance",
    "unchanged_mechanics_s4_s6",
  ],
  subgroups: [
    "stroke_reference_band_intersections",
    "device_os_view_conditions_handedness",
    "lawfully_collected_participant_subgroups",
    "external_capture_cohort",
    "sparse_slices_not_evaluable",
  ],
  frozen_mechanics_fault_drill_gates: [
    "authenticated_existing_frozen_s_f_d_reports",
    "no_gate_replacement_or_weakening",
  ],
};

export function validateBenchmarkReleaseStudy(raw: unknown): Result<BenchmarkReleaseStudy> {
  return validateStudy(raw, false);
}

function validateStudy(raw: unknown, diagnosticOnly: boolean): Result<BenchmarkReleaseStudy> {
  if (
    !record(raw) ||
    !fields(raw, [
      "schemaVersion",
      "protocol",
      "subject",
      "scope",
      "cases",
      "evidence",
      "perturbations",
    ]) ||
    raw.schemaVersion !== BENCHMARK_RELEASE_STUDY_SCHEMA_VERSION
  ) {
    return invalid(
      "invalid_study",
      "Require the exact versioned study fields; approval flags and precomputed passing summaries are not inputs.",
    );
  }
  if (!protocolSubmission(raw.protocol))
    return invalid(
      "invalid_protocol",
      "Only proposed/unapproved protocol submissions are supported; references cannot ratify a protocol.",
    );
  if (!candidateSubject(raw.subject))
    return invalid(
      "invalid_subject",
      "Require exact candidate lineage and form inputs, not a total rescale or rating/identity shortcut.",
    );
  if (
    !record(raw.scope) ||
    !fields(raw.scope, ["strokes", "referenceBands", "subgroups"]) ||
    !textArray(raw.scope.strokes, 64) ||
    !list(raw.scope.referenceBands, 12) ||
    !raw.scope.referenceBands.every(referenceBand) ||
    new Set(raw.scope.referenceBands).size !== raw.scope.referenceBands.length ||
    !list(raw.scope.subgroups, 256)
  ) {
    return invalid(
      "invalid_scope",
      "Declare released strokes, distinct half-level reference bands and explicit required subgroups.",
    );
  }
  const subgroupIds = new Set<string>();
  for (const subgroup of raw.scope.subgroups) {
    if (
      !record(subgroup) ||
      !fields(subgroup, ["dimension", "value"]) ||
      !BENCHMARK_SUBGROUP_DIMENSIONS.includes(subgroup.dimension as SubgroupDimension) ||
      !text(subgroup.value)
    ) {
      return invalid(
        "invalid_subgroup",
        "Subgroups require known dimensions and explicit values, not pooled averages.",
      );
    }
    const id = `${String(subgroup.dimension)}:${subgroup.value}`;
    if (subgroupIds.has(id))
      return invalid("duplicate_subgroup", "Required subgroup entries must be distinct.");
    subgroupIds.add(id);
  }
  if (
    !record(raw.evidence) ||
    !fields(raw.evidence, evidenceKeys) ||
    !evidenceKeys.every((key) =>
      nullableRef(raw.evidence && (raw.evidence as Record<string, unknown>)[key]),
    )
  ) {
    return invalid(
      "invalid_evidence",
      "Evidence references must be exact version/hash pairs or explicit null, never asserted passing metrics.",
    );
  }
  if (!list(raw.cases, 50000) || !list(raw.perturbations, 100000))
    return invalid("invalid_cases", "Cases and perturbations must be bounded, dense arrays.");
  for (const entry of raw.cases) {
    const validation = validateStudyCase(entry);
    if (!validation.ok) return validation;
  }
  const cases = raw.cases as unknown as BenchmarkReleaseCase[];
  if (cases.length > 0) {
    const isolation = validateRealBenchmarkPartitionIsolation(cases.map((entry) => entry.input));
    if (!isolation.ok) return isolation;
  }
  const byCase = new Map(cases.map((entry) => [entry.input.caseId, entry]));
  const bytesPartitions = new Map<string, RealBenchmarkPartition>();
  for (const entry of cases) {
    for (const digest of [
      entry.input.videoSha256,
      entry.input.poseSequenceSha256,
      entry.input.techniqueMetadata.independence.rawSourceSha256,
    ])
      bytesPartitions.set(digest, entry.input.split);
  }
  const variantIds = new Set<string>();
  for (const variant of raw.perturbations) {
    if (
      !record(variant) ||
      !fields(variant, [
        "caseId",
        "kind",
        "variantVideoSha256",
        "baselineVersionsAndIntentSha256",
        "variantVersionsAndIntentSha256",
        "measurement",
        "evidence",
        "prediction",
        "baselineRecoveryDecision",
        "variantRecoveryDecision",
      ]) ||
      !text(variant.caseId) ||
      !byCase.has(variant.caseId) ||
      ![
        "identical_bytes",
        "reencode",
        "crop",
        "brightness",
        "fps",
        "padding",
        "unsupported",
      ].includes(String(variant.kind)) ||
      !sha(variant.variantVideoSha256) ||
      !sha(variant.baselineVersionsAndIntentSha256) ||
      !sha(variant.variantVersionsAndIntentSha256) ||
      !["full_video_pipeline", "synthetic_math"].includes(String(variant.measurement)) ||
      !nullableRef(variant.evidence) ||
      !prediction(variant.prediction) ||
      !nullableText(variant.baselineRecoveryDecision) ||
      !nullableText(variant.variantRecoveryDecision)
    ) {
      return invalid(
        "invalid_perturbation",
        "Require matched full-pipeline variant lineage and exact prediction fields; unknowns remain null.",
      );
    }
    if (protectedSourceHashes.has(variant.variantVideoSha256))
      return invalid(
        "protected_holdout",
        "Protected footage and its source groups cannot enter W06.",
      );
    const split = byCase.get(variant.caseId)!.input.split;
    const assigned = bytesPartitions.get(variant.variantVideoSha256);
    if (assigned !== undefined && assigned !== split)
      return invalid(
        "real_benchmark.partition_leakage",
        "Perturbation bytes and every connected original/derivative must remain in one partition.",
      );
    bytesPartitions.set(variant.variantVideoSha256, split);
    const id = `${variant.caseId}:${String(variant.kind)}:${variant.variantVideoSha256}`;
    if (variantIds.has(id))
      return invalid("duplicate_perturbation", "Repeated variants are not new evidence.");
    variantIds.add(id);
  }
  if (
    !diagnosticOnly &&
    (cases.some((entry) => entry.dataOrigin === "synthetic_test") ||
      (raw.perturbations as unknown as BenchmarkPerturbation[]).some(
        (entry) => entry.measurement === "synthetic_math",
      ))
  ) {
    return invalid(
      "synthetic_evidence",
      "Synthetic examples may exercise diagnostic math only and cannot enter a release report's evidence.",
    );
  }
  return ok(raw as unknown as BenchmarkReleaseStudy);
}

function validateStudyCase(raw: unknown): Result<BenchmarkReleaseCase> {
  if (
    !record(raw) ||
    !fields(raw, [
      "input",
      "dataOrigin",
      "supportedInput",
      "referenceBand",
      "subgroups",
      "swingTarget",
      "prediction",
    ]) ||
    !record(raw.input) ||
    !fields(raw.input, [
      "caseId",
      "playerId",
      "videoSha256",
      "poseSequenceSha256",
      "declaredStroke",
      "annotationPath",
      "split",
      "techniqueMetadata",
    ])
  )
    return invalid(
      "invalid_case",
      "Every case requires exact input, target, prediction and grouping metadata.",
    );
  const metadata = validateRealTechniqueBenchmarkMetadata(raw.input.techniqueMetadata);
  if (!metadata.ok) return metadata;
  const input = raw.input;
  const independence = metadata.value.independence;
  if (
    W06_PROTECTED_CASE_IDS.some(
      (id) => String(input.caseId).includes(id) || String(input.annotationPath).includes(id),
    ) ||
    W06_PROTECTED_SESSION_IDS.some((id) => independence.sessionId === id) ||
    [independence.rawSourceSha256, input.videoSha256, input.poseSequenceSha256].some(
      (value) => typeof value === "string" && protectedSourceHashes.has(value),
    )
  )
    return invalid(
      "protected_holdout",
      "Protected case, recording and session groups are excluded from all W06 partitions, including acquisition and tuning.",
    );
  if (
    ![
      "consented_first_party_capture",
      "commissioned_capture",
      "licensed_media",
      "synthetic_test",
    ].includes(String(raw.dataOrigin))
  )
    return invalid(
      "ineligible_media_origin",
      "Public/platform media and generated footage are not qualified capture origins.",
    );
  if (
    typeof raw.supportedInput !== "boolean" ||
    (raw.referenceBand !== null && !referenceBand(raw.referenceBand)) ||
    !record(raw.subgroups) ||
    !fields(raw.subgroups, BENCHMARK_SUBGROUP_DIMENSIONS) ||
    !BENCHMARK_SUBGROUP_DIMENSIONS.every((key) =>
      nullableText((raw.subgroups as Record<string, unknown>)[key]),
    )
  )
    return invalid(
      "invalid_case_scope",
      "Preserve explicit support, half-level reference metadata and unknown subgroup values.",
    );
  if (raw.swingTarget !== null) {
    const target = raw.swingTarget;
    if (
      !record(target) ||
      !fields(target, ["kind", "interval", "reviewIds", "disagreement", "adjudicationReviewId"]) ||
      target.kind !== "independent_coach_swing_interval" ||
      !interval(target.interval, true, true) ||
      !textArray(target.reviewIds, 256) ||
      typeof target.disagreement !== "boolean" ||
      !nullableText(target.adjudicationReviewId)
    )
      return invalid(
        "invalid_swing_target",
        "Swing targets must remain independently anchored coach intervals, never a player rating or a silently chosen midpoint.",
      );
  }
  if (!prediction(raw.prediction))
    return invalid(
      "invalid_prediction",
      "Require finite nonvacuous displayed ranges, outward rounding, predictive events and explicit abstentions; no point rescale or visibility confidence.",
    );
  return ok(raw as unknown as BenchmarkReleaseCase);
}

export function benchmarkSliceDiagnostics(
  raw: unknown,
  purpose: BenchmarkDiagnosticReport["provenance"],
): Result<BenchmarkDiagnosticReport> {
  if (purpose !== "synthetic_math_only" && purpose !== "unverified_candidate_diagnostics")
    return invalid(
      "invalid_diagnostic_purpose",
      "Diagnostics must explicitly disclose their non-release purpose.",
    );
  const validation = validateStudy(raw, purpose === "synthetic_math_only");
  if (!validation.ok) return validation;
  const study = validation.value;
  if (
    purpose === "synthetic_math_only" &&
    study.cases.some((entry) => entry.dataOrigin !== "synthetic_test")
  )
    return invalid(
      "mixed_diagnostic_provenance",
      "Synthetic math must not relabel repository records as fixtures.",
    );
  const cases = [...study.cases].sort((a, b) => compare(a.input.caseId, b.input.caseId));
  const grouping = studyGrouping(cases, study.perturbations);
  const predicates: Array<{
    id: string;
    floor: number | null;
    select: (entry: BenchmarkReleaseCase) => boolean;
  }> = [{ id: "overall", floor: 300, select: () => true }];
  for (const stroke of [...study.scope.strokes].sort(compare)) {
    predicates.push({
      id: `stroke:${stroke}`,
      floor: 100,
      select: (entry) => entry.input.declaredStroke === stroke,
    });
    for (const band of [...study.scope.referenceBands].sort((a, b) => a - b))
      predicates.push({
        id: `stroke:${stroke}/reference_band:${band}`,
        floor: 50,
        select: (entry) => entry.input.declaredStroke === stroke && entry.referenceBand === band,
      });
  }
  for (const band of [...study.scope.referenceBands].sort((a, b) => a - b))
    predicates.push({
      id: `reference_band:${band}`,
      floor: 50,
      select: (entry) => entry.referenceBand === band,
    });
  const subgroupMap = new Map(
    study.scope.subgroups.map((entry) => [`${entry.dimension}:${entry.value}`, entry]),
  );
  for (const entry of cases)
    for (const dimension of BENCHMARK_SUBGROUP_DIMENSIONS) {
      const value = entry.subgroups[dimension];
      if (value !== null) subgroupMap.set(`${dimension}:${value}`, { dimension, value });
    }
  for (const [id, subgroup] of [...subgroupMap].sort(([a], [b]) => compare(a, b)))
    predicates.push({
      id,
      floor: null,
      select: (entry) => entry.subgroups[subgroup.dimension] === subgroup.value,
    });
  const slices: BenchmarkSliceDiagnostic[] = [];
  for (const partition of ["test", "external_test"] as const) {
    for (const predicate of predicates)
      slices.push(
        sliceDiagnostic(
          cases.filter((entry) => entry.input.split === partition && predicate.select(entry)),
          partition,
          predicate.id,
          predicate.floor,
          study.protocol,
          grouping,
        ),
      );
  }
  const ratings = new Map<string, BenchmarkDiagnosticReport["proxyRatings"][number]>();
  for (const entry of cases)
    for (const observation of entry.input.techniqueMetadata.playerRatings) {
      const key = canonical([observation.playerId, observation.observationId]);
      const previous = ratings.get(key);
      if (previous && canonical(previous.observation) !== canonical(observation))
        return invalid(
          "conflicting_rating_observation",
          "The same player-rating observation must not change between cases.",
        );
      ratings.set(key, {
        playerId: observation.playerId,
        observation,
        initialMetadataPrerequisitesPresent: initialRatingPrerequisites(observation),
        evidenceAuthenticated: false,
        representativeSwingSelection: "NOT_EVALUABLE",
      });
    }
  return ok({
    evidenceStatus: "NOT_RELEASE_EVIDENCE",
    provenance: purpose,
    missingPartitions: partitions.filter(
      (partition) => !cases.some((entry) => entry.input.split === partition),
    ),
    missingSubgroupDimensions: BENCHMARK_SUBGROUP_DIMENSIONS.filter(
      (dimension) => !study.scope.subgroups.some((entry) => entry.dimension === dimension),
    ),
    slices,
    proxyRatings: [...ratings].sort(([a], [b]) => compare(a, b)).map(([, value]) => value),
    proxyValidity: {
      status: "NOT_EVALUABLE",
      reason:
        "No authenticated rating provenance, approved representative-swing selection or per-definition validity method is installed; ratings remain metadata, not swing truth.",
    },
    perturbations: perturbationDiagnostics(study, grouping, predicates),
  });
}

function sliceDiagnostic(
  cases: BenchmarkReleaseCase[],
  partition: BenchmarkSliceDiagnostic["partition"],
  id: string,
  floor: number | null,
  protocol: BenchmarkProtocolSubmission | null,
  grouping: StudyGrouping,
): BenchmarkSliceDiagnostic {
  const supported = cases.filter((entry) => entry.supportedInput);
  const answered = supported.filter((entry) => entry.prediction.status === "range");
  const paired = answered.filter((entry) => entry.swingTarget !== null);
  const support = supportFor(supported, grouping);
  const missing: string[] = [
    "protocol_and_evidence_not_authenticated",
    "approved_grouped_confidence_method_missing",
    "simultaneous_slice_method_missing",
  ];
  if (supported.length === 0) missing.push("no_supported_attempts");
  if (floor === null) missing.push("subgroup_sample_floor_requires_ratification");
  if (paired.length !== answered.length) missing.push("missing_independent_swing_targets");
  if (answered.length === 0) missing.push("no_numerical_outputs");
  const allTargetsPresent = answered.length > 0 && paired.length === answered.length;
  const coverage = allTargetsPresent
    ? playerMean(paired, (entry) => (targetContained(entry) ? 1 : 0))
    : null;
  const halfLevel = answered.filter(
    (entry) =>
      entry.prediction.status === "range" &&
      Math.abs(entry.prediction.interval.upper - entry.prediction.interval.lower - 0.5) < 1e-12,
  );
  const halfCoverage =
    halfLevel.length > 0 && halfLevel.every((entry) => entry.swingTarget !== null)
      ? playerMean(halfLevel, (entry) => (targetContained(entry) ? 1 : 0))
      : null;
  const loss = allTargetsPresent
    ? {
        minimumPossiblePlayerWeightedMae: playerMean(paired, (entry) => errorBounds(entry)[0])!,
        maximumPossiblePlayerWeightedMae: playerMean(paired, (entry) => errorBounds(entry)[1])!,
        interpretation: "target_ambiguity_not_confidence_interval" as const,
      }
    : null;
  const widths = answered.map((entry) =>
    entry.prediction.status === "range"
      ? entry.prediction.interval.upper - entry.prediction.interval.lower
      : 0,
  );
  const width =
    widths.length > 0
      ? {
          median: timingReport(widths.map((value) => ({ truthMs: 0, predictedMs: value })))
            .medianAbsoluteErrorMs,
          p90: nearestRank(widths, 0.9)!,
          p90Method: "nearest_rank" as const,
        }
      : null;
  const events = new Map<string, BenchmarkReleaseCase[]>();
  for (const entry of answered)
    if (entry.prediction.status === "range" && entry.prediction.calibrationEvent !== null) {
      const key = canonical(entry.prediction.calibrationEvent.definition);
      events.set(key, [...(events.get(key) ?? []), entry]);
    }
  const probabilityCalibrationByEvent = [...events]
    .sort(([a], [b]) => compare(a, b))
    .map(([, rows]) => probabilityDiagnostic(rows, grouping));
  if (probabilityCalibrationByEvent.length !== 1)
    missing.push("missing_or_unlike_probability_event_definitions");
  if (
    answered.some(
      (entry) => entry.prediction.status === "range" && entry.prediction.calibrationEvent === null,
    )
  )
    missing.push("incomplete_probability_event_support");
  if (protocol?.highConfidenceThreshold == null || protocol.probabilityEvent === null)
    missing.push("high_confidence_event_and_threshold_missing");
  if (
    probabilityCalibrationByEvent.some(
      (event) => !sameRef(event.eventDefinition, protocol?.probabilityEvent ?? null),
    )
  )
    missing.push("probability_event_not_protocol_bound");
  const highConfidence = answered.filter(
    (entry) =>
      entry.prediction.status === "range" &&
      entry.prediction.calibrationEvent !== null &&
      protocol?.highConfidenceThreshold != null &&
      sameRef(entry.prediction.calibrationEvent.definition, protocol.probabilityEvent) &&
      entry.prediction.calibrationEvent.probability >= protocol.highConfidenceThreshold,
  );
  const groups = subsetGroups(highConfidence, grouping.independent);
  const grossUnitStatuses = groups.map((rows) => {
    if (
      rows.some(
        (entry) =>
          (entry.prediction.status === "range" &&
            entry.prediction.grosslyWrongCoachVerdict === true) ||
          (entry.swingTarget !== null && errorBounds(entry)[0] > 1),
      )
    )
      return "observed_error";
    if (
      rows.some(
        (entry) =>
          entry.swingTarget === null ||
          (entry.prediction.status === "range" &&
            entry.prediction.grosslyWrongCoachVerdict === null) ||
          (entry.swingTarget !== null && errorBounds(entry)[0] <= 1 && errorBounds(entry)[1] > 1),
      )
    )
      return "unresolved";
    return "no_observed_error";
  });
  const grossError = {
    independentUnits: groups.length,
    observedErrorUnits: grossUnitStatuses.filter((status) => status === "observed_error").length,
    unresolvedUnits: grossUnitStatuses.filter((status) => status === "unresolved").length,
    upper95: null,
  };
  const numericalCoverage = supported.length === 0 ? null : answered.length / supported.length;
  const violations: GateId[] = [];
  if (numericalCoverage !== null && numericalCoverage < 0.5) violations.push("selective_coverage");
  if (
    (coverage !== null && coverage < 0.9) ||
    (halfCoverage !== null && halfCoverage < 0.9) ||
    answered.some(
      (entry) =>
        entry.prediction.status === "range" &&
        entry.prediction.nominalCoverage !==
          PROPOSED_BENCHMARK_RELEASE_TARGETS.rangeCoverage.nominal,
    )
  )
    violations.push("range_coverage");
  if (loss !== null && loss.minimumPossiblePlayerWeightedMae > (id === "overall" ? 0.35 : 0.5))
    violations.push("primary_error");
  if (width !== null && (width.median > 1 || width.p90 > 1.5)) violations.push("useful_width");
  if (probabilityCalibrationByEvent.some((entry) => entry.expectedCalibrationError > 0.05))
    violations.push("probability_calibration");
  if (cases.some((entry) => !entry.supportedInput && entry.prediction.status === "range"))
    violations.push("subgroups");
  return {
    partition,
    id,
    support,
    proposedMinimumIndependentPlayers: floor,
    proposedEvidenceFloorMet:
      floor !== null &&
      support.players >= floor &&
      support.independentUnits >= floor &&
      support.sessions >= 2,
    supportedAttempts: supported.length,
    unsupportedAttempts: cases.length - supported.length,
    abstentions: cases.filter((entry) => entry.prediction.status === "abstained").length,
    numericalOutputs: answered.length,
    numericalCoverage,
    displayedIntervalCoverage: coverage,
    coverageDefinition:
      "whole_coach_target_contained_in_displayed_interval_player_weighted_diagnostic",
    coverageConfidenceInterval: null,
    intervalLossBounds: loss,
    maeConfidenceInterval: null,
    width,
    halfLevelRanges: { count: halfLevel.length, coverage: halfCoverage, lower95: null },
    probabilityCalibration:
      probabilityCalibrationByEvent.length === 1 ? probabilityCalibrationByEvent[0]! : null,
    probabilityCalibrationByEvent,
    grossError,
    proposedViolations: violations,
    missingEvidence: missing,
  };
}

function probabilityDiagnostic(rows: BenchmarkReleaseCase[], grouping: StudyGrouping) {
  const events = rows.flatMap((entry) =>
    entry.prediction.status === "range" && entry.prediction.calibrationEvent !== null
      ? [entry.prediction.calibrationEvent]
      : [],
  );
  const report = calibrationReport(
    events.map((event) => ({ confidence: event.probability, correct: event.outcome })),
  );
  const independentUnits = subsetGroups(rows, grouping.independent).length;
  const warnings = [
    ...report.warnings,
    "descriptive_case_weighted_bins_not_grouped_inference_or_release_evidence",
  ];
  if (independentUnits < 10) warnings.push("insufficient_independent_probability_units");
  if (independentUnits !== rows.length)
    warnings.push("correlated_events_require_approved_grouped_method");
  return {
    eventDefinition: events[0]!.definition,
    cases: events.length,
    independentUnits,
    expectedCalibrationError: report.expectedCalibrationError,
    reliabilityBins: report.bins,
    brierScore:
      events.reduce((sum, event) => sum + (event.probability - Number(event.outcome)) ** 2, 0) /
      events.length,
    confidenceInterval: null,
    warnings,
  };
}

type MatchedPerturbation = {
  baseline: BenchmarkReleaseCase;
  kind: BenchmarkPerturbation["kind"];
  delta: number;
};

function perturbationDiagnostics(
  study: BenchmarkReleaseStudy,
  grouping: StudyGrouping,
  predicates: Array<{ id: string; select: (entry: BenchmarkReleaseCase) => boolean }>,
) {
  const byCase = new Map(study.cases.map((entry) => [entry.input.caseId, entry]));
  const violations: string[] = [];
  const measured: MatchedPerturbation[] = [];
  const kinds = new Set<string>();
  let missingPipelineEvidenceReferences = 0;
  let unresolvedPaddingPairs = 0;
  for (const variant of [...study.perturbations].sort((a, b) =>
    compare(canonical(a), canonical(b)),
  )) {
    const baseline = byCase.get(variant.caseId)!;
    kinds.add(variant.kind);
    if (variant.evidence === null || variant.measurement !== "full_video_pipeline")
      missingPipelineEvidenceReferences += 1;
    if (variant.baselineVersionsAndIntentSha256 !== variant.variantVersionsAndIntentSha256) {
      violations.push(`${variant.caseId}:versions_or_intent_mismatch`);
      continue;
    }
    if (
      variant.kind === "identical_bytes" &&
      (variant.variantVideoSha256 !== baseline.input.videoSha256 ||
        canonical(variant.prediction) !== canonical(baseline.prediction))
    )
      violations.push(`${variant.caseId}:identical_input_changed`);
    if (
      (variant.kind === "unsupported" || !baseline.supportedInput) &&
      variant.prediction.status !== "abstained"
    )
      violations.push(`${variant.caseId}:unsupported_variant_answered`);
    if (variant.kind === "padding") {
      if (variant.baselineRecoveryDecision === null || variant.variantRecoveryDecision === null)
        unresolvedPaddingPairs += 1;
      else if (variant.baselineRecoveryDecision !== variant.variantRecoveryDecision)
        violations.push(`${variant.caseId}:padding_changed_recovery`);
    }
    if (variant.kind !== "unsupported" && baseline.supportedInput) {
      if (variant.prediction.status !== baseline.prediction.status)
        violations.push(`${variant.caseId}:supported_variant_abstention_flip`);
      if (
        robustnessKinds.some((kind) => kind === variant.kind) &&
        variant.prediction.status === "range" &&
        baseline.prediction.status === "range"
      ) {
        measured.push({
          baseline,
          kind: variant.kind,
          delta: Math.abs(
            midpoint(variant.prediction.interval) - midpoint(baseline.prediction.interval),
          ),
        });
      }
    }
  }
  const pooled = perturbationSummary(measured, grouping);
  violations.push(...pooled.proposedViolations);
  const slices = (["test", "external_test"] as const).flatMap((partition) =>
    predicates.flatMap((predicate) =>
      robustnessKinds.map((kind) => {
        const rows = measured.filter(
          (row) =>
            row.baseline.input.split === partition &&
            predicate.select(row.baseline) &&
            row.kind === kind,
        );
        const summary = perturbationSummary(rows, grouping);
        const id = `${predicate.id}/perturbation:${kind}`;
        violations.push(
          ...summary.proposedViolations.map((violation) => `${partition}:${id}:${violation}`),
        );
        return { status: "NOT_EVALUABLE" as const, partition, id, pairs: rows.length, ...summary };
      }),
    ),
  );
  return {
    status: "NOT_EVALUABLE" as const,
    pairs: study.perturbations.length,
    independentUnits: pooled.independentUnits,
    medianAbsoluteMidpointDelta: pooled.medianAbsoluteMidpointDelta,
    p95AbsoluteMidpointDelta: pooled.p95AbsoluteMidpointDelta,
    aggregation: "descriptive_all_partitions_robustness_variants_only" as const,
    slices,
    missingKinds: [
      "identical_bytes",
      "reencode",
      "crop",
      "brightness",
      "fps",
      "padding",
      "unsupported",
    ].filter((kind) => !kinds.has(kind)),
    unauthenticatedPairs: study.perturbations.length,
    missingPipelineEvidenceReferences,
    unresolvedPaddingPairs,
    violations: [...new Set(violations)].sort(compare),
    reason:
      "No approved perturbation protocol, independent sample plan or authenticated S4/S6 report is installed; formula tests and repeated variants cannot certify video performance.",
  };
}

function perturbationSummary(rows: MatchedPerturbation[], grouping: StudyGrouping) {
  const deltas = rows.map((row) => row.delta);
  const median = deltas.length
    ? timingReport(deltas.map((value) => ({ truthMs: 0, predictedMs: value })))
        .medianAbsoluteErrorMs
    : null;
  const p95 = nearestRank(deltas, 0.95);
  const proposedViolations: string[] = [];
  if (
    median !== null &&
    median > PROPOSED_BENCHMARK_RELEASE_TARGETS.perturbations.maximumMedianMidpointDelta
  )
    proposedViolations.push("midpoint_median_exceeds_proposed_target");
  if (
    p95 !== null &&
    p95 > PROPOSED_BENCHMARK_RELEASE_TARGETS.perturbations.maximumP95MidpointDelta
  )
    proposedViolations.push("midpoint_p95_exceeds_proposed_target");
  return {
    independentUnits: subsetGroups(
      rows.map((row) => row.baseline),
      grouping.independent,
    ).length,
    medianAbsoluteMidpointDelta: median,
    p95AbsoluteMidpointDelta: p95,
    proposedViolations,
  };
}

export function evaluateBenchmarkRelease(raw: unknown): BenchmarkReleaseReport {
  const validation = validateBenchmarkReleaseStudy(raw);
  const blockers: BenchmarkReleaseBlocker[] = [];
  const block = (
    code: string,
    action: string,
    caseIds: string[] = [],
    status: BenchmarkReleaseBlocker["status"] = "BLOCKED_EXTERNAL",
  ) => blockers.push({ code, status, action, caseIds: [...new Set(caseIds)].sort(compare) });
  let study: BenchmarkReleaseStudy | null = null;
  let diagnostics: BenchmarkDiagnosticReport | null = null;
  if (!validation.ok) {
    block(validation.failure.code, validation.failure.message, [], "NOT_EVALUABLE");
  } else {
    study = validation.value;
    block(
      study.protocol === null ? "protocol_missing" : "protocol_not_ratified",
      "The authorized scientific reviewers must ratify a versioned rubric, estimand, sidedness, grouped/simultaneous methods and power plan before fresh locked-test use; this evaluator has no approval authority.",
    );
    if (study.subject === null)
      block(
        "candidate_lineage_missing",
        "Supply immutable pipeline, definition, form-model, preprocessing, calibration and supported-domain hashes; a mechanics rescale is not a candidate benchmark.",
      );
    if (study.cases.length === 0) {
      block(
        "qualified_data_missing",
        "Obtain an authorized, rights-cleared, independently coach-reviewed player/recording corpus with verified rating provenance; no acquisition or recruitment is authorized by this report.",
      );
    } else {
      const result = benchmarkSliceDiagnostics(study, "unverified_candidate_diagnostics");
      if (result.ok) diagnostics = result.value;
      else block(result.failure.code, result.failure.message, [], "NOT_EVALUABLE");
      const ids = (predicate: (entry: BenchmarkReleaseCase) => boolean) =>
        study!.cases.filter(predicate).map((entry) => entry.input.caseId);
      const missingRights = ids(
        (entry) => entry.input.techniqueMetadata.eligibilityManifest === null,
      );
      if (missingRights.length)
        block(
          "rights_consent_prerequisites_missing",
          "Bind each capture to active participant/guardian releases and commercial training, evaluation, derived-feature, withdrawal and reviewed rights records under the existing eligibility contract.",
          missingRights,
        );
      const missingTime = ids((entry) => entry.input.techniqueMetadata.recordedAtIso === null);
      if (missingTime.length)
        block(
          "capture_time_missing",
          "Verify original recording time; registration/upload time cannot establish historical rating alignment.",
          missingTime,
        );
      const missingCoaches = ids((entry) => !coachReferencePrerequisites(entry));
      if (missingCoaches.length)
        block(
          "qualified_coach_prerequisites_missing",
          "Require two independently provisioned qualified, blinded original reviews bound to the frozen swing rubric, plus a distinct qualified adjudicator for predefined disagreements; references alone are not qualification.",
          missingCoaches,
        );
      const missingRatings = ids(
        (entry) => !entry.input.techniqueMetadata.playerRatings.some(initialRatingPrerequisites),
      );
      if (missingRatings.length)
        block(
          "verified_rating_prerequisites_missing",
          "Supply actual verified, historically aligned rating observations with recorded reliability; preserve every rating type/variant and never infer a rating from a title or identity.",
          missingRatings,
        );
      const mismatchedProtocol = ids(
        (entry) =>
          study!.protocol === null ||
          !sameRef(entry.input.techniqueMetadata.protocol, study!.protocol.artifact),
      );
      if (mismatchedProtocol.length)
        block(
          "case_protocol_binding_missing",
          "Bind capture/review metadata to the exact prespecified protocol version and digest.",
          mismatchedProtocol,
        );
      block(
        "external_evidence_authentication_unavailable",
        "Resolve rights, qualification/provisioning history, original reviews, rating provenance and signed protocol/method approvals through their existing authorized custodians; structural metadata checks authenticate none of them.",
      );
      if (diagnostics?.missingPartitions.length)
        block(
          "partitions_missing",
          `Supply separate ${diagnostics.missingPartitions.map((partition) => BENCHMARK_PARTITION_ROLES[partition]).join(", ")} cohorts without moving inspected holdouts.`,
          [],
          "NOT_EVALUABLE",
        );
      if (
        diagnostics?.missingSubgroupDimensions.length ||
        study.scope.strokes.length === 0 ||
        study.scope.referenceBands.length === 0
      )
        block(
          "required_scope_missing",
          "Preregister strokes, represented half-level bands and all required lawful subgroup dimensions; an empty or pooled-only scope cannot authorize release.",
          [],
          "NOT_EVALUABLE",
        );
      if (diagnostics?.slices.some((slice) => !slice.proposedEvidenceFloorMet))
        block(
          "independent_slice_support_missing",
          "Plan sufficient independent players and physical-recording/session clusters for every prespecified stroke, reference band and subgroup; the 300/100/50 proposals are not power proofs.",
          [],
          "NOT_EVALUABLE",
        );
    }
    block(
      "approved_statistical_methods_missing",
      "Implement and authenticate ratified grouped agreement/error/coverage inference, simultaneous-slice uncertainty and nonzero-error bounds; null confidence intervals are not passing results.",
    );
    block(
      "frozen_gates_not_authenticated",
      "Retain and independently satisfy all existing frozen mechanics/fault/drill controls including S4/S6; this new report cannot replace or relax them.",
    );
    block(
      "runtime_release_certificate_not_issued",
      "An authorized runtime release-policy issuer must independently consume authenticated study/report/candidate hashes. This offline report issues no certificate or runtime permission.",
    );
  }
  return {
    schemaVersion: BENCHMARK_RELEASE_REPORT_SCHEMA_VERSION,
    status: blockers.some((entry) => entry.status === "BLOCKED_EXTERNAL")
      ? "BLOCKED_EXTERNAL"
      : "NOT_EVALUABLE",
    numericalReleaseAuthorized: false,
    scientificResults: null,
    protocol: study?.protocol ?? null,
    subject: study?.subject ?? null,
    proposedTargets: PROPOSED_BENCHMARK_RELEASE_TARGETS,
    partitionRoles: BENCHMARK_PARTITION_ROLES,
    gates: BENCHMARK_RELEASE_GATE_IDS.map((id) => ({
      id,
      verdict: "NOT_EVALUABLE",
      requiredEvidence: [...gateRequirements[id]],
    })),
    blockers,
    diagnostics,
  };
}

export async function zeroEventErrorBoundDiagnostic(independentUnits: number): Promise<{
  status: "DIAGNOSTIC_ONLY" | "NOT_EVALUABLE";
  method: "exact_binomial_zero_events_one_sided_95";
  independentUnits: number | null;
  upper95: number | null;
  minimumIndependentUnitsForTwoPercent: number | null;
  meetsTwoPercent: boolean | null;
  authorizesRelease: false;
  limitation: string;
}> {
  const base = {
    method: "exact_binomial_zero_events_one_sided_95" as const,
    authorizesRelease: false as const,
    limitation:
      "Arithmetic for zero events in genuinely independent Bernoulli units only, not an approved W06 confidence method. Nonzero events, clustering, other sidedness and multiple-slice inference need an approved design; frames, variants and pairs do not increase independent n.",
  };
  if (!Number.isSafeInteger(independentUnits) || independentUnits <= 0)
    return {
      ...base,
      status: "NOT_EVALUABLE",
      independentUnits: null,
      upper95: null,
      minimumIndependentUnitsForTwoPercent: null,
      meetsTwoPercent: null,
    };
  const upper95 = zeroEventUpperBound95(independentUnits);
  if (!Number.isFinite(upper95) || upper95 <= 0)
    return {
      ...base,
      status: "NOT_EVALUABLE",
      independentUnits,
      upper95: null,
      minimumIndependentUnitsForTwoPercent: null,
      meetsTwoPercent: null,
    };
  return {
    ...base,
    status: "DIAGNOSTIC_ONLY",
    independentUnits,
    upper95,
    minimumIndependentUnitsForTwoPercent: independentTrialsForZeroEventUpperBound95(0.02),
    meetsTwoPercent: upper95 <= 0.02,
  };
}

function coachReferencePrerequisites(entry: BenchmarkReleaseCase): boolean {
  const target = entry.swingTarget;
  if (target === null || target.reviewIds.length < 2) return false;
  const metadata = entry.input.techniqueMetadata;
  const originals = target.reviewIds.map((id) =>
    metadata.coachReviews.find((review) => review.reviewId === id),
  );
  if (
    originals.some(
      (review) =>
        review === undefined ||
        review.blindedToModelOutput !== true ||
        review.blindedToPlayerRatings !== true,
    ) ||
    new Set(originals.map((review) => review?.coachId)).size !== originals.length ||
    new Set(originals.map((review) => review?.reviewSha256)).size !== originals.length
  )
    return false;
  if (!target.disagreement) return target.adjudicationReviewId === null;
  const adjudicator = metadata.coachReviews.find(
    (review) => review.reviewId === target.adjudicationReviewId,
  );
  return (
    adjudicator !== undefined &&
    adjudicator.blindedToModelOutput === true &&
    adjudicator.blindedToPlayerRatings === true &&
    !originals.some(
      (review) =>
        review?.coachId === adjudicator.coachId ||
        review?.reviewSha256 === adjudicator.reviewSha256,
    )
  );
}

function initialRatingPrerequisites(rating: PlayerRatingObservation): boolean {
  return (
    rating.verification.status === "verified" &&
    rating.recordingAlignment.status === "historically_verified" &&
    rating.ratingAsOfIso !== null &&
    rating.reliability.status === "recorded" &&
    rating.reliability.scorePercent >= 60
  );
}

function connectedGroups(
  cases: BenchmarkReleaseCase[],
  variantHashes: Map<string, string[]>,
  physicalOnly = false,
): BenchmarkReleaseCase[][] {
  const parent = cases.map((_, index) => index);
  const root = (index: number): number => {
    let node = index;
    while (parent[node] !== node) node = parent[node]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = node;
      index = next;
    }
    return node;
  };
  const owner = new Map<string, number>();
  for (const [index, entry] of cases.entries()) {
    const group = entry.input.techniqueMetadata.independence;
    const keys = [
      `recording:${group.recordingId}`,
      `bytes:${group.rawSourceSha256}`,
      `bytes:${entry.input.videoSha256}`,
      `bytes:${entry.input.poseSequenceSha256}`,
      ...(variantHashes.get(entry.input.caseId) ?? []).map((digest) => `bytes:${digest}`),
      ...group.duplicateGroupIds.map((id) => `duplicate:${id}`),
      ...(physicalOnly
        ? []
        : [`session:${group.sessionId}`, ...group.participantIds.map((id) => `participant:${id}`)]),
    ];
    for (const key of keys) {
      const previous = owner.get(key);
      if (previous !== undefined) parent[root(index)] = root(previous);
      else owner.set(key, index);
    }
  }
  const groups = new Map<number, BenchmarkReleaseCase[]>();
  for (const [index, entry] of cases.entries()) {
    const key = root(index);
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }
  return [...groups.values()];
}

type StudyGrouping = { independent: Map<string, number>; physical: Map<string, number> };

function studyGrouping(
  cases: BenchmarkReleaseCase[],
  perturbations: BenchmarkPerturbation[],
): StudyGrouping {
  const variantHashes = new Map<string, string[]>();
  for (const variant of perturbations) {
    const hashes = variantHashes.get(variant.caseId) ?? [];
    hashes.push(variant.variantVideoSha256);
    variantHashes.set(variant.caseId, hashes);
  }
  const index = (physicalOnly: boolean) => {
    const result = new Map<string, number>();
    for (const [group, rows] of connectedGroups(cases, variantHashes, physicalOnly).entries()) {
      for (const entry of rows) result.set(entry.input.caseId, group);
    }
    return result;
  };
  return { independent: index(false), physical: index(true) };
}

function subsetGroups(
  cases: BenchmarkReleaseCase[],
  index: Map<string, number>,
): BenchmarkReleaseCase[][] {
  const groups = new Map<number, BenchmarkReleaseCase[]>();
  for (const entry of cases) {
    const key = index.get(entry.input.caseId)!;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }
  return [...groups.values()];
}

function supportFor(cases: BenchmarkReleaseCase[], grouping: StudyGrouping): BenchmarkSupport {
  return {
    cases: cases.length,
    players: new Set(cases.map((entry) => entry.input.playerId)).size,
    sessions: new Set(cases.map((entry) => entry.input.techniqueMetadata.independence.sessionId))
      .size,
    physicalRecordings: subsetGroups(cases, grouping.physical).length,
    independentUnits: subsetGroups(cases, grouping.independent).length,
  };
}

function playerMean(
  cases: BenchmarkReleaseCase[],
  value: (entry: BenchmarkReleaseCase) => number,
): number | null {
  if (cases.length === 0) return null;
  const players = new Map<string, number[]>();
  for (const entry of cases) {
    const bucket = players.get(entry.input.playerId) ?? [];
    bucket.push(value(entry));
    players.set(entry.input.playerId, bucket);
  }
  const means = [...players]
    .sort(([a], [b]) => compare(a, b))
    .map(([, values]) => values.reduce((sum, number) => sum + number, 0) / values.length);
  return means.reduce((sum, number) => sum + number, 0) / means.length;
}

function errorBounds(entry: BenchmarkReleaseCase): [number, number] {
  if (entry.prediction.status !== "range" || entry.swingTarget === null)
    throw new Error("Missing diagnostic pair");
  const predicted = midpoint(entry.prediction.interval);
  const target = entry.swingTarget.interval;
  const nearest = Math.max(target.lower, Math.min(target.upper, predicted));
  return [
    meanAbsoluteError([{ truth: nearest, predicted }]),
    Math.max(Math.abs(predicted - target.lower), Math.abs(predicted - target.upper)),
  ];
}

function targetContained(entry: BenchmarkReleaseCase): boolean {
  return (
    entry.prediction.status === "range" &&
    entry.swingTarget !== null &&
    entry.prediction.interval.lower <= entry.swingTarget.interval.lower &&
    entry.prediction.interval.upper >= entry.swingTarget.interval.upper
  );
}

function midpoint(value: Interval): number {
  return (value.lower + value.upper) / 2;
}
function nearestRank(values: number[], fraction: number): number | null {
  return values.length === 0
    ? null
    : [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Reflect.ownKeys(value);
  return (
    present.length === keys.length &&
    present.every((key) => typeof key === "string" && keys.includes(key))
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}
function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}
function list(value: unknown, maximum: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
  );
}
function textArray(value: unknown, maximum: number): value is string[] {
  return list(value, maximum) && value.every(text) && new Set(value).size === value.length;
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function nullableRef(value: unknown): value is VersionedArtifactReference | null {
  return value === null || isVersionedArtifactReference(value);
}
function referenceBand(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 2 &&
    value <= 7.5 &&
    Number.isInteger(value * 2)
  );
}
function fraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function sameRef(
  a: VersionedArtifactReference | null,
  b: VersionedArtifactReference | null,
): boolean {
  return a !== null && b !== null && a.version === b.version && a.sha256 === b.sha256;
}
function interval(value: unknown, bounded: boolean, allowPoint = false): value is Interval {
  return (
    record(value) &&
    fields(value, ["lower", "upper"]) &&
    typeof value.lower === "number" &&
    Number.isFinite(value.lower) &&
    typeof value.upper === "number" &&
    Number.isFinite(value.upper) &&
    (allowPoint ? value.lower <= value.upper : value.lower < value.upper) &&
    (!bounded || (value.lower >= 2 && value.upper <= 8))
  );
}
function prediction(value: unknown): value is BenchmarkPrediction {
  if (!record(value)) return false;
  if (value.status === "abstained")
    return fields(value, ["status", "reason"]) && text(value.reason);
  if (
    value.status !== "range" ||
    !fields(value, [
      "status",
      "interval",
      "unformattedInterval",
      "nominalCoverage",
      "calibrationEvent",
      "grosslyWrongCoachVerdict",
    ]) ||
    !interval(value.interval, true) ||
    value.interval.upper - value.interval.lower >= 6 ||
    !interval(value.unformattedInterval, false) ||
    value.unformattedInterval.upper <= 2 ||
    value.unformattedInterval.lower >= 8 ||
    !fraction(value.nominalCoverage) ||
    value.nominalCoverage <= 0 ||
    value.nominalCoverage >= 1 ||
    (value.grosslyWrongCoachVerdict !== null && typeof value.grosslyWrongCoachVerdict !== "boolean")
  )
    return false;
  if (
    value.interval.lower > Math.max(2, value.unformattedInterval.lower) ||
    value.interval.upper < Math.min(8, value.unformattedInterval.upper)
  )
    return false;
  const event = value.calibrationEvent;
  return (
    event === null ||
    (record(event) &&
      fields(event, ["definition", "probability", "outcome"]) &&
      isVersionedArtifactReference(event.definition) &&
      fraction(event.probability) &&
      typeof event.outcome === "boolean")
  );
}
function protocolSubmission(value: unknown): value is BenchmarkProtocolSubmission | null {
  if (value === null) return true;
  const refKeys = [
    "rubric",
    "powerPrecision",
    "groupedUncertaintyMethod",
    "simultaneousInferenceMethod",
    "intervalLoss",
    "probabilityEvent",
    "frozenBeforeEvaluationEvidence",
  ];
  return (
    record(value) &&
    fields(value, ["artifact", "status", ...refKeys, "highConfidenceThreshold"]) &&
    isVersionedArtifactReference(value.artifact) &&
    ["proposed", "unapproved"].includes(String(value.status)) &&
    refKeys.every((key) => nullableRef(value[key])) &&
    (value.highConfidenceThreshold === null ||
      (fraction(value.highConfidenceThreshold) && value.highConfidenceThreshold > 0))
  );
}
function candidateSubject(value: unknown): value is BenchmarkCandidateSubject | null {
  return (
    value === null ||
    (record(value) &&
      fields(value, [...subjectKeys, "modelKind", "inputKinds"]) &&
      subjectKeys.every((key) => isVersionedArtifactReference(value[key])) &&
      ["multivariate_form", "ordinal_form", "distributional_form"].includes(
        String(value.modelKind),
      ) &&
      textArray(value.inputKinds, 5) &&
      value.inputKinds.includes("observed_form") &&
      value.inputKinds.every((kind) =>
        [
          "observed_form",
          "temporal_motion",
          "confirmed_stroke",
          "handedness",
          "capture_geometry",
        ].includes(kind),
      ))
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function invalid<T>(code: string, message: string): Result<T> {
  return fail(failure("permanent", code, message));
}
