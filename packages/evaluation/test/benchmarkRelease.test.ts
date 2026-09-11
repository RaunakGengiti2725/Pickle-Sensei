import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_RELEASE_GATE_IDS,
  BENCHMARK_RELEASE_STUDY_SCHEMA_VERSION,
  PROPOSED_BENCHMARK_RELEASE_TARGETS,
  benchmarkSliceDiagnostics,
  evaluateBenchmarkRelease,
  validateBenchmarkReleaseStudy,
  zeroEventErrorBoundDiagnostic,
  type BenchmarkPerturbation,
  type BenchmarkReleaseCase,
  type BenchmarkReleaseStudy,
} from "../src/benchmarkRelease.js";
import {
  REAL_TECHNIQUE_METADATA_SCHEMA_VERSION,
  type PlayerRatingObservation,
} from "../src/realBenchmark.js";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const ref = (n: number) => ({ version: `synthetic-math-${n}`, sha256: hash(n) });

function syntheticCase(n: number): BenchmarkReleaseCase {
  return {
    input: {
      caseId: `synthetic-case-${n}`,
      playerId: `synthetic-player-${n}`,
      videoSha256: hash(n * 3 + 1),
      poseSequenceSha256: hash(n * 3 + 2),
      declaredStroke: "forehand_drive",
      annotationPath: `synthetic-math-only/${n}.json`,
      split: "test",
      techniqueMetadata: {
        schemaVersion: REAL_TECHNIQUE_METADATA_SCHEMA_VERSION,
        purpose: "validation_and_confound_analysis_only",
        protocol: null,
        recordedAtIso: null,
        independence: {
          participantIds: [`synthetic-player-${n}`],
          sessionId: `synthetic-session-${n}`,
          recordingId: `synthetic-recording-${n}`,
          rawSourceSha256: hash(n * 3 + 3),
          duplicateGroupIds: [],
        },
        eligibilityManifest: null,
        playerRatings: [],
        coachReviews: [],
      },
    },
    dataOrigin: "synthetic_test",
    supportedInput: true,
    referenceBand: 3.5,
    subgroups: {
      device_os: "synthetic-device-os",
      camera_view: "synthetic-view",
      capture_conditions: "synthetic-conditions",
      handedness: "synthetic-handedness",
      participant_subgroup: "synthetic-subgroup",
    },
    swingTarget: {
      kind: "independent_coach_swing_interval",
      interval: { lower: 3.5, upper: 4 },
      reviewIds: [],
      disagreement: false,
      adjudicationReviewId: null,
    },
    prediction: {
      status: "range",
      interval: { lower: 3.5, upper: 4 },
      unformattedInterval: { lower: 3.52, upper: 3.98 },
      nominalCoverage: 0.9,
      calibrationEvent: null,
      grosslyWrongCoachVerdict: null,
    },
  };
}

function study(cases: BenchmarkReleaseCase[] = []): BenchmarkReleaseStudy {
  return {
    schemaVersion: BENCHMARK_RELEASE_STUDY_SCHEMA_VERSION,
    protocol: null,
    subject: null,
    scope: {
      strokes: ["forehand_drive"],
      referenceBands: [3.5],
      subgroups: [
        { dimension: "device_os", value: "synthetic-device-os" },
        { dimension: "camera_view", value: "synthetic-view" },
        { dimension: "capture_conditions", value: "synthetic-conditions" },
        { dimension: "handedness", value: "synthetic-handedness" },
        { dimension: "participant_subgroup", value: "synthetic-subgroup" },
      ],
    },
    cases,
    evidence: {
      coachAgreement: null,
      groupedUncertainty: null,
      simultaneousCoverage: null,
      proxyRatingValidity: null,
      ratingTypeConfounding: null,
      frozenMechanicsFaultDrillGates: null,
    },
    perturbations: [],
  };
}

function proposedStudy(cases: BenchmarkReleaseCase[]): BenchmarkReleaseStudy {
  const value = study(cases);
  value.protocol = {
    artifact: ref(1),
    status: "proposed",
    rubric: ref(2),
    powerPrecision: ref(3),
    groupedUncertaintyMethod: ref(4),
    simultaneousInferenceMethod: ref(5),
    intervalLoss: ref(6),
    probabilityEvent: ref(7),
    highConfidenceThreshold: 0.9,
    frozenBeforeEvaluationEvidence: ref(8),
  };
  for (const row of cases) row.input.techniqueMetadata.protocol = value.protocol.artifact;
  return value;
}

function syntheticVariant(
  row: BenchmarkReleaseCase,
  kind: BenchmarkPerturbation["kind"] = "reencode",
  variantVideoSha256 = hash(50000),
): BenchmarkPerturbation {
  return {
    caseId: row.input.caseId,
    kind,
    variantVideoSha256,
    baselineVersionsAndIntentSha256: hash(60000),
    variantVersionsAndIntentSha256: hash(60000),
    measurement: "synthetic_math",
    evidence: null,
    prediction: structuredClone(row.prediction),
    baselineRecoveryDecision: null,
    variantRecoveryDecision: null,
  };
}

function syntheticRating(row: BenchmarkReleaseCase, n = 1): PlayerRatingObservation {
  return {
    observationId: `synthetic-observation-${n}`,
    playerId: row.input.playerId,
    provider: "DUPR",
    ratingType: "doubles",
    ratingVariant: null,
    value: 4,
    ratingAsOfIso: "2026-01-01",
    observedAtIso: "2026-01-02T00:00:00Z",
    evidenceRole: "noisy_player_anchor_not_swing_truth",
    reliability: { status: "recorded", scorePercent: 60 },
    verification: {
      status: "verified",
      evidenceRef: `synthetic-rating-evidence-${n}`,
      evidenceSha256: hash(70000 + n),
      verifierRef: "synthetic-verifier",
      verifiedAtIso: "2026-01-03T00:00:00Z",
    },
    recordingAlignment: {
      status: "historically_verified",
      evidenceRef: `synthetic-alignment-${n}`,
      evidenceSha256: hash(80000 + n),
    },
  };
}

// Deliberately spoofed input exercises the untrusted-candidate boundary, not real evidence.
// These synthetic identities/references are never provisioned or written to any inventory.
function spoofedCandidate(n: number): BenchmarkReleaseCase {
  const row = syntheticCase(n);
  row.dataOrigin = "licensed_media";
  const metadata = row.input.techniqueMetadata;
  metadata.recordedAtIso = "2026-01-01T00:00:00Z";
  metadata.eligibilityManifest = {
    schemaId: "eligible-temporal-dataset-v2",
    artifact: ref(90000),
    itemId: row.input.caseId,
  };
  metadata.playerRatings = [syntheticRating(row)];
  metadata.coachReviews = [1, 2, 3].map((index) => ({
    reviewId: `synthetic-review-${n}-${index}`,
    coachId: `synthetic-coach-${index}`,
    reviewSha256: hash(100000 + n * 3 + index),
    qualificationPolicyVersion: "synthetic-untrusted-policy",
    qualificationEvidenceRef: `synthetic-qualification-${index}`,
    reviewedAtIso: "2026-01-02T00:00:00Z",
    blindedToModelOutput: true,
    blindedToPlayerRatings: true,
  }));
  row.swingTarget!.reviewIds = metadata.coachReviews.slice(0, 2).map((review) => review.reviewId);
  return row;
}

function diagnostics(value: BenchmarkReleaseStudy) {
  const result = benchmarkSliceDiagnostics(value, "synthetic_math_only");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

const overall = (value: BenchmarkReleaseStudy) =>
  diagnostics(value).slices.find((slice) => slice.partition === "test" && slice.id === "overall")!;

function expectBlocked(value: unknown, code?: string) {
  const result = evaluateBenchmarkRelease(value);
  expect(["BLOCKED_EXTERNAL", "NOT_EVALUABLE"]).toContain(result.status);
  expect(result.numericalReleaseAuthorized).toBe(false);
  expect(result.scientificResults).toBeNull();
  expect(result.gates.map((gate) => gate.id)).toEqual([...BENCHMARK_RELEASE_GATE_IDS]);
  expect(result.gates.every((gate) => gate.verdict === "NOT_EVALUABLE")).toBe(true);
  if (code) expect(result.blockers.map((blocker) => blocker.code)).toContain(code);
  return result;
}

describe("W06 release foundation, never scientific approval from synthetic tests", () => {
  it("keeps the plan's targets explicitly proposed and immutable", () => {
    expect(PROPOSED_BENCHMARK_RELEASE_TARGETS.status).toBe("PROPOSED_NOT_RATIFIED");
    expect(PROPOSED_BENCHMARK_RELEASE_TARGETS.independentPlayers).toEqual({
      overall: 300,
      perStroke: 100,
      perStrokeReferenceBand: 50,
    });
    expect(PROPOSED_BENCHMARK_RELEASE_TARGETS.grossError.maximumUpper95).toBe(0.02);
    expect(Object.isFrozen(PROPOSED_BENCHMARK_RELEASE_TARGETS)).toBe(true);
    expect(Object.isFrozen(PROPOSED_BENCHMARK_RELEASE_TARGETS.independentPlayers)).toBe(true);
  });

  it("returns deterministic blocked output on the actual absent study without fabricated zeros", () => {
    const value = study();
    const first = expectBlocked(value, "protocol_missing");
    expect(first).toEqual(evaluateBenchmarkRelease(structuredClone(value)));
    expect(first.blockers.map((blocker) => blocker.code)).toContain("qualified_data_missing");
    expect(first.diagnostics).toBeNull();
    expect(first.status).toBe("BLOCKED_EXTERNAL");
  });

  it.each([null, {}, [], { ...study(), cases: null }, { ...study(), releaseApproved: true }])(
    "fails closed on malformed or approval-injected input: %j",
    (value) => {
      expectBlocked(value);
    },
  );

  it("rejects synthetic release evidence even with thousands of perfect numerical rows", () => {
    const value = study(Array.from({ length: 400 }, (_, index) => syntheticCase(index)));
    expect(validateBenchmarkReleaseStudy(value).ok).toBe(false);
    const report = expectBlocked(value, "synthetic_evidence");
    expect(report.diagnostics).toBeNull();
  });

  it("does not treat opaque protocol or method references as ratification", () => {
    const value = study();
    value.protocol = {
      artifact: ref(1),
      status: "proposed",
      rubric: ref(2),
      powerPrecision: ref(3),
      groupedUncertaintyMethod: ref(4),
      simultaneousInferenceMethod: ref(5),
      intervalLoss: ref(6),
      probabilityEvent: ref(7),
      highConfidenceThreshold: 0.9,
      frozenBeforeEvaluationEvidence: ref(8),
    };
    expectBlocked(value, "protocol_not_ratified");
    expectBlocked({ ...value, protocol: { ...value.protocol, status: "approved" } });
    expectBlocked({ ...value, protocol: { ...value.protocol, ratified: true } });
  });

  it("leaves release lineage unavailable rather than rescaling a mechanics total", () => {
    const value = study();
    expectBlocked({
      ...value,
      subject: {
        pipeline: ref(1),
        definition: ref(2),
        model: ref(3),
        preprocessing: ref(4),
        calibration: ref(5),
        supportedDomain: ref(6),
        modelKind: "mechanics_total_rescale",
        inputKinds: ["mechanics_total", "known_dupr", "rating_type"],
      },
    });
  });
});

describe("untrusted candidate prerequisites are not qualification or scientific evidence", () => {
  it("reports missing rights, capture time, coaches and verified ratings as external blockers", () => {
    const row = syntheticCase(1);
    row.dataOrigin = "licensed_media";
    const report = expectBlocked(study([row]));
    for (const code of [
      "rights_consent_prerequisites_missing",
      "capture_time_missing",
      "qualified_coach_prerequisites_missing",
      "verified_rating_prerequisites_missing",
      "case_protocol_binding_missing",
    ]) {
      expect(report.blockers.find((blocker) => blocker.code === code)).toMatchObject({
        status: "BLOCKED_EXTERNAL",
        caseIds: [row.input.caseId],
      });
    }
  });

  it("cannot authenticate spoofed rights, qualifications, protocol, model or method references", () => {
    const value = proposedStudy([spoofedCandidate(1)]);
    value.subject = {
      pipeline: ref(11),
      definition: ref(12),
      model: ref(13),
      preprocessing: ref(14),
      calibration: ref(15),
      supportedDomain: ref(16),
      modelKind: "ordinal_form",
      inputKinds: ["observed_form", "temporal_motion"],
    };
    for (const key of Object.keys(value.evidence) as Array<keyof typeof value.evidence>)
      value.evidence[key] = ref(20);
    const report = expectBlocked(value, "external_evidence_authentication_unavailable");
    expect(report.blockers.map((blocker) => blocker.code)).toContain("protocol_not_ratified");
    expect(report.blockers.map((blocker) => blocker.code)).toContain(
      "approved_statistical_methods_missing",
    );
    expect(report.blockers.map((blocker) => blocker.code)).toContain(
      "frozen_gates_not_authenticated",
    );
    expect(report.diagnostics!.proxyRatings[0]).toMatchObject({
      initialMetadataPrerequisitesPresent: true,
      evidenceAuthenticated: false,
      representativeSwingSelection: "NOT_EVALUABLE",
    });
    expect(report.diagnostics!.proxyValidity.status).toBe("NOT_EVALUABLE");
  });

  it.each([
    "one_original",
    "same_coach",
    "same_review_bytes",
    "model_unblinded",
    "rating_unblinded",
    "blinding_unknown",
    "missing_adjudicator",
    "original_adjudicates",
    "adjudication_reuses_original_bytes",
  ])("keeps %s from satisfying even the structural independent-review prerequisites", (fault) => {
    const row = spoofedCandidate(1);
    const reviews = row.input.techniqueMetadata.coachReviews;
    if (fault === "one_original") row.swingTarget!.reviewIds.pop();
    if (fault === "same_coach") reviews[1]!.coachId = reviews[0]!.coachId;
    if (fault === "same_review_bytes") reviews[1]!.reviewSha256 = reviews[0]!.reviewSha256;
    if (fault === "model_unblinded") reviews[0]!.blindedToModelOutput = false;
    if (fault === "rating_unblinded") reviews[0]!.blindedToPlayerRatings = false;
    if (fault === "blinding_unknown") reviews[0]!.blindedToPlayerRatings = null;
    if (
      [
        "missing_adjudicator",
        "original_adjudicates",
        "adjudication_reuses_original_bytes",
      ].includes(fault)
    ) {
      row.swingTarget!.disagreement = true;
      if (fault === "original_adjudicates")
        row.swingTarget!.adjudicationReviewId = reviews[0]!.reviewId;
      if (fault === "adjudication_reuses_original_bytes") {
        row.swingTarget!.adjudicationReviewId = reviews[2]!.reviewId;
        reviews[2]!.reviewSha256 = reviews[0]!.reviewSha256;
      }
    }
    expectBlocked(proposedStudy([row]), "qualified_coach_prerequisites_missing");
  });

  it("preserves original judgments when a distinct adjudicator is referenced, still without approval", () => {
    const row = spoofedCandidate(1);
    row.swingTarget!.disagreement = true;
    row.swingTarget!.adjudicationReviewId = row.input.techniqueMetadata.coachReviews[2]!.reviewId;
    const value = proposedStudy([row]);
    const before = structuredClone(value);
    const report = expectBlocked(value, "external_evidence_authentication_unavailable");
    expect(report.blockers.map((blocker) => blocker.code)).not.toContain(
      "qualified_coach_prerequisites_missing",
    );
    expect(value).toEqual(before);
  });

  it.each(["unverified", "unaligned", "reliability_unknown", "below_reliability_floor"])(
    "does not mistake %s rating metadata for a verified swing anchor",
    (fault) => {
      const row = spoofedCandidate(1);
      const rating = row.input.techniqueMetadata.playerRatings[0]!;
      if (fault === "unverified") {
        rating.verification = { status: "unverified", reasonCode: "self_reported" };
        rating.recordingAlignment = { status: "unverified" };
      }
      if (fault === "unaligned") rating.recordingAlignment = { status: "unverified" };
      if (fault === "reliability_unknown") rating.reliability = { status: "unavailable" };
      if (fault === "below_reliability_floor")
        rating.reliability = { status: "recorded", scorePercent: 59.99 };
      const report = expectBlocked(proposedStudy([row]), "verified_rating_prerequisites_missing");
      expect(report.diagnostics!.proxyRatings[0]!.initialMetadataPrerequisitesPresent).toBe(false);
    },
  );

  it("preserves unlike rating types and variants rather than choosing the highest or averaging them", () => {
    const row = spoofedCandidate(1);
    const singles = syntheticRating(row, 2);
    singles.ratingType = "singles";
    singles.ratingVariant = "synthetic-variant";
    singles.value = 3;
    row.input.techniqueMetadata.playerRatings.push(singles);
    const report = expectBlocked(proposedStudy([row]));
    expect(report.diagnostics!.proxyRatings.map((entry) => entry.observation)).toEqual(
      row.input.techniqueMetadata.playerRatings,
    );
    expect(report.diagnostics!.proxyValidity.status).toBe("NOT_EVALUABLE");
    expect(report.gates.find((gate) => gate.id === "rating_type_confounding")!.verdict).toBe(
      "NOT_EVALUABLE",
    );
  });

  it("uses collision-free player/observation keys for all allowed opaque identifiers", () => {
    const rows = [syntheticCase(1), syntheticCase(2)];
    rows[0]!.input.playerId = "synthetic:a";
    rows[1]!.input.playerId = "synthetic";
    for (const row of rows) {
      row.input.techniqueMetadata.independence.participantIds = [row.input.playerId];
      row.input.techniqueMetadata.recordedAtIso = "2026-01-01T00:00:00Z";
      row.input.techniqueMetadata.playerRatings = [syntheticRating(row)];
    }
    rows[0]!.input.techniqueMetadata.playerRatings[0]!.observationId = "b";
    rows[1]!.input.techniqueMetadata.playerRatings[0]!.observationId = "a:b";
    expect(diagnostics(study(rows)).proxyRatings).toHaveLength(2);
  });
});

describe("explicitly synthetic grouping and rejection math", () => {
  it.each(["video", "pose", "raw_source", "other_variant"])(
    "rejects a perturbation sharing %s bytes with another partition",
    (source) => {
      const rows = [syntheticCase(1), syntheticCase(2)];
      rows[0]!.input.split = "calibration";
      const value = study(rows);
      const digest =
        source === "video"
          ? rows[1]!.input.videoSha256
          : source === "pose"
            ? rows[1]!.input.poseSequenceSha256
            : source === "raw_source"
              ? rows[1]!.input.techniqueMetadata.independence.rawSourceSha256
              : hash(50000);
      value.perturbations = [syntheticVariant(rows[0]!, "crop", digest)];
      if (source === "other_variant")
        value.perturbations.push(syntheticVariant(rows[1]!, "reencode", digest));
      const result = benchmarkSliceDiagnostics(value, "synthetic_math_only");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("real_benchmark.partition_leakage");
    },
  );

  it("uses shared variant bytes to connect physical and independent groups, without counting variants as cases", () => {
    const rows = [syntheticCase(1), syntheticCase(2), syntheticCase(3)];
    rows[1]!.supportedInput = false;
    const value = study(rows);
    value.perturbations = [
      syntheticVariant(rows[0]!, "crop", hash(50000)),
      syntheticVariant(rows[1]!, "reencode", hash(50000)),
      syntheticVariant(rows[1]!, "fps", rows[2]!.input.videoSha256),
    ];
    const result = overall(value);
    expect(result.support).toEqual({
      cases: 2,
      players: 2,
      sessions: 2,
      physicalRecordings: 1,
      independentUnits: 1,
    });
  });

  it.each([
    "participantIds",
    "sessionId",
    "recordingId",
    "rawSourceSha256",
    "duplicateGroupIds",
  ] as const)(
    "rejects partition leakage through %s, reusing the real partition validator",
    (field) => {
      const a = syntheticCase(1);
      const b = syntheticCase(2);
      a.input.split = "train";
      a.input.techniqueMetadata.independence.duplicateGroupIds = ["synthetic-duplicate"];
      if (field === "participantIds") {
        b.input.techniqueMetadata.independence.participantIds.push(a.input.playerId);
      } else {
        Object.assign(b.input.techniqueMetadata.independence, {
          [field]: a.input.techniqueMetadata.independence[field],
        });
      }
      const result = benchmarkSliceDiagnostics(study([a, b]), "synthetic_math_only");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("real_benchmark.partition_leakage");
    },
  );

  it.each(["videoSha256", "poseSequenceSha256"] as const)(
    "isolates identical %s bytes",
    (field) => {
      const a = syntheticCase(1);
      const b = syntheticCase(2);
      a.input.split = "calibration";
      b.input[field] = a.input[field];
      expect(benchmarkSliceDiagnostics(study([a, b]), "synthetic_math_only").ok).toBe(false);
    },
  );

  it("preserves all five partitions and reports missing external/calibration partitions", () => {
    const value = study([syntheticCase(1)]);
    const report = diagnostics(value);
    expect(report.missingPartitions).toEqual(["train", "val", "calibration", "external_test"]);
    const all = ["train", "val", "calibration", "test", "external_test"] as const;
    value.cases = all.map((split, index) => {
      const entry = syntheticCase(index);
      entry.input.split = split;
      return entry;
    });
    expect(diagnostics(value).missingPartitions).toEqual([]);
  });

  it("counts people, recordings and connected components, not 1,000 frames or pair combinations", () => {
    const rows = Array.from({ length: 1000 }, (_, n) => {
      const row = syntheticCase(n);
      row.input.playerId = "synthetic-single-player";
      row.input.techniqueMetadata.independence = {
        participantIds: ["synthetic-single-player"],
        sessionId: "synthetic-single-session",
        recordingId: "synthetic-single-recording",
        rawSourceSha256: hash(9000),
        duplicateGroupIds: [],
      };
      return row;
    });
    const result = overall(study(rows));
    expect(result.support).toMatchObject({
      cases: 1000,
      players: 1,
      physicalRecordings: 1,
      sessions: 1,
      independentUnits: 1,
    });
    expect(result.proposedEvidenceFloorMet).toBe(false);
    expect(result.coverageConfidenceInterval).toBeNull();
  });

  it("keeps transitive player/session components together even inside a single partition", () => {
    const rows = [syntheticCase(1), syntheticCase(2), syntheticCase(3)];
    rows[1]!.input.techniqueMetadata.independence.participantIds.push(rows[0]!.input.playerId);
    rows[2]!.input.techniqueMetadata.independence.sessionId =
      rows[1]!.input.techniqueMetadata.independence.sessionId;
    expect(overall(study(rows)).support.independentUnits).toBe(1);
    expect(overall(study(rows)).support.players).toBe(3);
  });

  it("does not lose transitive connections when a bridging case is outside a reported slice", () => {
    const rows = [syntheticCase(1), syntheticCase(2), syntheticCase(3)];
    rows[1]!.input.techniqueMetadata.independence.participantIds.push(rows[0]!.input.playerId);
    rows[2]!.input.techniqueMetadata.independence.sessionId =
      rows[1]!.input.techniqueMetadata.independence.sessionId;
    rows[1]!.subgroups.camera_view = "synthetic-other-view";
    rows[1]!.supportedInput = false;
    const slice = diagnostics(study(rows)).slices.find(
      (entry) => entry.partition === "test" && entry.id === "camera_view:synthetic-view",
    )!;
    expect(slice.support.players).toBe(2);
    expect(slice.support.independentUnits).toBe(1);
  });

  it("rejects sparse arrays and duplicate or malformed cases before calculating denominators", () => {
    const row = syntheticCase(1);
    for (const cases of [
      [row, row],
      new Array(2),
      [null],
      [{ ...row, input: { ...row.input, split: "frames" } }],
    ]) {
      expect(benchmarkSliceDiagnostics({ ...study(), cases }, "synthetic_math_only").ok).toBe(
        false,
      );
    }
  });

  it.each(["wm-dink-01", "afn-vic-rally1"])(
    "rejects protected %s without reading its content",
    (id) => {
      const row = syntheticCase(1);
      row.input.caseId = id;
      expect(benchmarkSliceDiagnostics(study([row]), "synthetic_math_only").ok).toBe(false);
    },
  );

  it.each(["wm-tournament-2014", "afn-vic-2025"])(
    "rejects a renamed case from protected source group %s",
    (session) => {
      const row = syntheticCase(1);
      row.input.techniqueMetadata.independence.sessionId = session;
      expect(benchmarkSliceDiagnostics(study([row]), "synthetic_math_only").ok).toBe(false);
    },
  );
});

describe("explicitly synthetic diagnostic metrics do not establish validity", () => {
  it.each([0.5, 0.95])(
    "flags nominal coverage %s rather than presenting it as the proposed 90%% range",
    (nominal) => {
      const row = syntheticCase(1);
      if (row.prediction.status !== "range") throw new Error("Synthetic range required");
      row.prediction.nominalCoverage = nominal;
      const result = overall(study([row]));
      expect(result.displayedIntervalCoverage).toBe(1);
      expect(result.proposedViolations).toContain("range_coverage");
    },
  );

  it("uses disjoint gross-error unit counts; a known failure cannot also be an unresolved unit", () => {
    const rows = Array.from({ length: 5 }, (_, index) => syntheticCase(index));
    for (const row of rows) {
      if (row.prediction.status !== "range") throw new Error("Synthetic range required");
      row.prediction.calibrationEvent = { definition: ref(7), probability: 0.95, outcome: true };
      row.prediction.grosslyWrongCoachVerdict = false;
    }
    rows[1]!.input.techniqueMetadata.independence.sessionId =
      rows[0]!.input.techniqueMetadata.independence.sessionId;
    rows[0]!.swingTarget = null;
    Object.assign(rows[0]!.prediction, { grosslyWrongCoachVerdict: true });
    Object.assign(rows[1]!.prediction, { grosslyWrongCoachVerdict: null });
    Object.assign(rows[2]!.prediction, { grosslyWrongCoachVerdict: null });
    rows[3]!.swingTarget!.interval = { lower: 5, upper: 5.5 };
    const result = overall(proposedStudy(rows));
    expect(result.grossError).toEqual({
      independentUnits: 4,
      observedErrorUnits: 2,
      unresolvedUnits: 1,
      upper95: null,
    });
  });

  it("requires the declared high-confidence event and threshold and never supplies a zero bootstrap bound", () => {
    const row = syntheticCase(1);
    if (row.prediction.status !== "range") throw new Error("Synthetic range required");
    row.prediction.calibrationEvent = { definition: ref(7), probability: 0.99, outcome: true };
    row.prediction.grosslyWrongCoachVerdict = false;
    expect(overall(study([row])).grossError).toEqual({
      independentUnits: 0,
      observedErrorUnits: 0,
      unresolvedUnits: 0,
      upper95: null,
    });
    expect(overall(proposedStudy([row])).grossError).toEqual({
      independentUnits: 1,
      observedErrorUnits: 0,
      unresolvedUnits: 0,
      upper95: null,
    });
    row.prediction.calibrationEvent.definition = ref(8);
    const result = overall(proposedStudy([row]));
    expect(result.grossError.independentUnits).toBe(0);
    expect(result.missingEvidence).toContain("probability_event_not_protocol_bound");
  });

  it("retains separate event calibration diagnostics, Brier scores and reliability bins instead of pooling unlike events", () => {
    const rows = [syntheticCase(1), syntheticCase(2)];
    for (const [index, row] of rows.entries()) {
      if (row.prediction.status !== "range") throw new Error("Synthetic range required");
      row.prediction.calibrationEvent = {
        definition: ref(index + 7),
        probability: 0.5,
        outcome: true,
      };
    }
    const result = overall(proposedStudy(rows));
    expect(result.probabilityCalibration).toBeNull();
    expect(result.probabilityCalibrationByEvent).toHaveLength(2);
    for (const event of result.probabilityCalibrationByEvent) {
      expect(event.expectedCalibrationError).toBe(0.5);
      expect(event.brierScore).toBe(0.25);
      expect(event.reliabilityBins.some((bin) => bin.count === 1)).toBe(true);
      expect(event.confidenceInterval).toBeNull();
    }
    expect(result.proposedViolations).toContain("probability_calibration");
    expect(result.missingEvidence).toContain("missing_or_unlike_probability_event_definitions");
  });

  it("reports a failing nearest-rank width tail even with a narrow median", () => {
    const rows = Array.from({ length: 10 }, (_, n) => syntheticCase(n));
    for (const row of rows.slice(-2)) {
      if (row.prediction.status !== "range") throw new Error("Synthetic range required");
      row.prediction.interval = { lower: 3, upper: 5 };
    }
    const result = overall(study(rows));
    expect(result.width).toEqual({ median: 0.5, p90: 2, p90Method: "nearest_rank" });
    expect(result.proposedViolations).toContain("useful_width");
  });

  it("rechecks coverage of outward-rounded ranges after clamping at the 2–8 scale boundary", () => {
    const row = syntheticCase(1);
    if (row.prediction.status !== "range") throw new Error("Synthetic range required");
    row.prediction.unformattedInterval = { lower: 1.8, upper: 2.4 };
    row.prediction.interval = { lower: 2, upper: 2.5 };
    row.swingTarget!.interval = { lower: 2, upper: 2.5 };
    expect(overall(study([row])).displayedIntervalCoverage).toBe(1);
    row.swingTarget!.interval.upper = 2.6;
    expect(overall(study([row])).displayedIntervalCoverage).toBe(0);
  });

  it("retains every abstention and unsupported attempt without returning vacuous error metrics", () => {
    const rows = [syntheticCase(1), syntheticCase(2), syntheticCase(3)];
    for (const row of rows)
      row.prediction = { status: "abstained", reason: "synthetic-abstention" };
    rows[2]!.supportedInput = false;
    const result = overall(study(rows));
    expect(result.supportedAttempts).toBe(2);
    expect(result.unsupportedAttempts).toBe(1);
    expect(result.abstentions).toBe(3);
    expect(result.numericalCoverage).toBe(0);
    expect(result.displayedIntervalCoverage).toBeNull();
    expect(result.intervalLossBounds).toBeNull();
    expect(result.width).toBeNull();
    expect(result.proposedViolations).toContain("selective_coverage");
    expect(diagnostics(study(rows)).evidenceStatus).toBe("NOT_RELEASE_EVIDENCE");
    expectBlocked(study(rows));
  });

  it("weights players equally and preserves coach interval ambiguity rather than inventing point truth", () => {
    const one = syntheticCase(1);
    const many = Array.from({ length: 9 }, (_, n) => {
      const row = syntheticCase(n + 2);
      row.input.playerId = "synthetic-player-many";
      row.input.techniqueMetadata.independence.participantIds = [row.input.playerId];
      row.swingTarget!.interval = { lower: 4.5, upper: 5 };
      return row;
    });
    const result = overall(study([one, ...many]));
    expect(result.intervalLossBounds!.minimumPossiblePlayerWeightedMae).toBeCloseTo(0.375);
    expect(result.intervalLossBounds!.maximumPossiblePlayerWeightedMae).toBeCloseTo(0.75);
    expect(result.intervalLossBounds!.interpretation).toBe(
      "target_ambiguity_not_confidence_interval",
    );
    expect(result.maeConfidenceInterval).toBeNull();
    expect(result.proposedViolations).toContain("primary_error");
  });

  it("reports a failing slice even when a pooled value looks good, plus absent prespecified slices", () => {
    const rows = Array.from({ length: 20 }, (_, n) => syntheticCase(n));
    rows[0]!.subgroups.camera_view = "synthetic-hard-view";
    rows[0]!.prediction = { status: "abstained", reason: "synthetic-abstention" };
    const value = study(rows);
    value.scope.subgroups.push({ dimension: "camera_view", value: "synthetic-hard-view" });
    value.scope.subgroups.push({ dimension: "device_os", value: "synthetic-absent-device" });
    value.scope.referenceBands.push(4);
    const report = diagnostics(value);
    expect(overall(value).numericalCoverage).toBe(0.95);
    const hard = report.slices.find(
      (slice) => slice.id === "camera_view:synthetic-hard-view" && slice.partition === "test",
    )!;
    expect(hard.proposedViolations).toContain("selective_coverage");
    const absent = report.slices.find(
      (slice) => slice.id === "device_os:synthetic-absent-device" && slice.partition === "test",
    )!;
    expect(absent.numericalCoverage).toBeNull();
    expect(absent.proposedEvidenceFloorMet).toBe(false);
    expect(
      report.slices.some(
        (slice) =>
          slice.id === "stroke:forehand_drive/reference_band:4" && slice.support.players === 0,
      ),
    ).toBe(true);
  });

  it("evaluates the displayed range and its half-level subset after outward rounding", () => {
    const row = syntheticCase(1);
    row.swingTarget!.interval = { lower: 3.5, upper: 4 };
    const result = overall(study([row]));
    expect(result.displayedIntervalCoverage).toBe(1);
    expect(result.halfLevelRanges).toEqual({ count: 1, coverage: 1, lower95: null });
    row.swingTarget!.interval = { lower: 3.4, upper: 4.1 };
    expect(overall(study([row])).displayedIntervalCoverage).toBe(0);
    expect(overall(study([row])).proposedViolations).toContain("range_coverage");
  });

  it.each([
    { interval: { lower: 2, upper: 8 } },
    { interval: { lower: 4, upper: 4 } },
    { interval: { lower: NaN, upper: 4 } },
    { interval: { lower: 3.6, upper: 4 } },
    { confidenceSource: "vision_visibility" },
    { pointEstimate: 3.75 },
  ])("rejects vacuous, nonfinite, inward-rounded or shortcut predictions: %j", (override) => {
    const row = syntheticCase(1);
    Object.assign(row.prediction, override);
    expect(benchmarkSliceDiagnostics(study([row]), "synthetic_math_only").ok).toBe(false);
  });

  it("does not replace swing targets with a player's rating", () => {
    const row = syntheticCase(1);
    Object.assign(row.swingTarget!, {
      kind: "player_dupr_rating",
      interval: { lower: 4, upper: 4 },
    });
    expect(benchmarkSliceDiagnostics(study([row]), "synthetic_math_only").ok).toBe(false);
  });

  it("does not count repeated calibration events as independent probability evidence", () => {
    const rows = Array.from({ length: 15 }, (_, n) => {
      const row = syntheticCase(n);
      row.input.techniqueMetadata.independence.sessionId = "synthetic-shared-session";
      if (row.prediction.status === "range") {
        row.prediction.calibrationEvent = { definition: ref(100), probability: 0.9, outcome: true };
      }
      return row;
    });
    const result = overall(study(rows));
    expect(result.probabilityCalibration!.independentUnits).toBe(1);
    expect(result.probabilityCalibration!.warnings.length).toBeGreaterThan(0);
    expect(result.probabilityCalibration!.brierScore).toBeCloseTo(0.01);
    expect(result.probabilityCalibration!.confidenceInterval).toBeNull();
  });
});

describe("explicitly synthetic perturbation rejection math", () => {
  it("cannot dilute supported-transformation errors with identical-byte or padding controls", () => {
    const rows = Array.from({ length: 30 }, (_, index) => syntheticCase(index));
    const value = study(rows);
    value.perturbations = rows.flatMap((row, index) => [
      syntheticVariant(row, "identical_bytes", row.input.videoSha256),
      syntheticVariant(row, "padding", hash(51000 + index)),
    ]);
    const changed = syntheticVariant(rows[0]!);
    if (changed.prediction.status !== "range") throw new Error("Synthetic range required");
    changed.prediction.interval = { lower: 4.5, upper: 5 };
    changed.prediction.unformattedInterval = { lower: 4.5, upper: 5 };
    value.perturbations.push(changed);
    const result = diagnostics(value).perturbations;
    expect(result.medianAbsoluteMidpointDelta).toBe(1);
    expect(result.p95AbsoluteMidpointDelta).toBe(1);
    expect(result.violations).toContain("midpoint_median_exceeds_proposed_target");
  });

  it("keeps a failing external capture/kind slice visible even when pooled perturbation deltas are zero", () => {
    const rows = Array.from({ length: 21 }, (_, index) => syntheticCase(index));
    const hard = rows.at(-1)!;
    hard.input.split = "external_test";
    hard.subgroups.camera_view = "synthetic-hard-view";
    const value = study(rows);
    value.perturbations = rows.map((row, index) =>
      syntheticVariant(row, "crop", hash(52000 + index)),
    );
    const changed = value.perturbations.at(-1)!;
    if (changed.prediction.status !== "range") throw new Error("Synthetic range required");
    changed.prediction.interval = { lower: 4.5, upper: 5 };
    changed.prediction.unformattedInterval = { lower: 4.5, upper: 5 };
    const result = diagnostics(value).perturbations;
    expect(result.medianAbsoluteMidpointDelta).toBe(0);
    expect(result.p95AbsoluteMidpointDelta).toBe(0);
    expect(result).toMatchObject({
      slices: expect.arrayContaining([
        expect.objectContaining({
          partition: "external_test",
          id: "camera_view:synthetic-hard-view/perturbation:crop",
          status: "NOT_EVALUABLE",
          pairs: 1,
          independentUnits: 1,
          medianAbsoluteMidpointDelta: 1,
          p95AbsoluteMidpointDelta: 1,
          proposedViolations: [
            "midpoint_median_exceeds_proposed_target",
            "midpoint_p95_exceeds_proposed_target",
          ],
        }),
      ]),
    });
    expect(result.violations).toContain(
      "external_test:camera_view:synthetic-hard-view/perturbation:crop:midpoint_p95_exceeds_proposed_target",
    );
  });

  it("does not allow any unsupported baseline to gain a numerical variant by changing the variant kind", () => {
    const row = syntheticCase(1);
    const variant = syntheticVariant(row, "brightness");
    row.supportedInput = false;
    row.prediction = { status: "abstained", reason: "synthetic-unsupported" };
    const value = study([row]);
    value.perturbations = [variant];
    expect(diagnostics(value).perturbations.violations).toContain(
      `${row.input.caseId}:unsupported_variant_answered`,
    );
  });

  it("never calls a pair authenticated merely because it carries an opaque full-pipeline reference", () => {
    const row = syntheticCase(1);
    const variant = syntheticVariant(row);
    variant.measurement = "full_video_pipeline";
    variant.evidence = ref(50);
    const value = study([row]);
    value.perturbations = [variant];
    const result = diagnostics(value).perturbations;
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.unauthenticatedPairs).toBe(1);
  });

  it("keeps empty perturbations unevaluable instead of claiming deterministic or stable output", () => {
    const result = diagnostics(study([syntheticCase(1)])).perturbations;
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.pairs).toBe(0);
    expect(result.medianAbsoluteMidpointDelta).toBeNull();
    expect(result.missingKinds).toContain("identical_bytes");
  });

  it("catches changed identical-byte outputs, unstable variants, unsupported answers and padding recovery", () => {
    const row = syntheticCase(1);
    const shifted = structuredClone(row.prediction);
    if (shifted.status !== "range") throw new Error("Synthetic range required");
    shifted.interval = { lower: 4.5, upper: 5 };
    shifted.unformattedInterval = { lower: 4.52, upper: 4.98 };
    const value = study([row]);
    value.perturbations = [
      "identical_bytes",
      "reencode",
      "crop",
      "brightness",
      "fps",
      "padding",
      "unsupported",
    ].map((kind, index) => ({
      caseId: row.input.caseId,
      kind: kind as BenchmarkReleaseStudy["perturbations"][number]["kind"],
      variantVideoSha256: kind === "identical_bytes" ? row.input.videoSha256 : hash(50 + index),
      baselineVersionsAndIntentSha256: hash(100),
      variantVersionsAndIntentSha256: hash(100),
      measurement: "synthetic_math",
      evidence: null,
      prediction: structuredClone(shifted),
      baselineRecoveryDecision: "not_recovered",
      variantRecoveryDecision: "recovered",
    }));
    const result = diagnostics(value).perturbations;
    expect(result.status).toBe("NOT_EVALUABLE");
    expect(result.independentUnits).toBe(1);
    expect(result.violations).toContain(`${row.input.caseId}:identical_input_changed`);
    expect(result.violations).toContain(`${row.input.caseId}:unsupported_variant_answered`);
    expect(result.violations).toContain(`${row.input.caseId}:padding_changed_recovery`);
    expect(result.violations).toContain("midpoint_p95_exceeds_proposed_target");
    expect(result.unauthenticatedPairs).toBe(7);
    expectBlocked(value);
  });

  it("is insensitive to row ordering in deterministic diagnostic aggregation", () => {
    const value = study(Array.from({ length: 10 }, (_, n) => syntheticCase(n)));
    const first = diagnostics(value);
    value.cases.reverse();
    value.scope.subgroups.reverse();
    expect(diagnostics(value)).toEqual(first);
  });
});

describe("read-only repository evidence boundary", () => {
  it("does not promote the actual empty coach registry, historical lock checks or NOT-GOLD examples", () => {
    const sources: Array<{ path: string; bytes: number; sha256: string }> = [];
    const readJson = <T>(path: string): T => {
      const bytes = readFileSync(resolve(import.meta.dirname, "../../..", path));
      sources.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      return JSON.parse(bytes.toString("utf8")) as T;
    };
    const coaches = readJson<{ coaches: unknown[] }>("datasets/coach-review/coaches.json");
    const agreement = readJson<{
      realReviewCount: number;
      coachCount: number;
      generatedAtIso: string;
    }>("datasets/coach-review/agreement/agreement-report.json");
    const registry = readJson<{
      verifiedAt: string;
      reviewScope: { commercialTrainingReadyTemporalSourceCount: number };
      sources: unknown[];
      evaluatedButExcluded: unknown[];
      freshCandidates: { items: unknown[] };
      devPool: { items: unknown[] };
    }>("datasets/pickleball/registry.json");
    const gates = readJson<{
      specSha256: string;
      generatedAtIso: string;
      gates: Array<{ kind: string; verdict: string }>;
    }>("datasets/coach-review/gates/coach-gates-latest-report.json");
    readJson<unknown>("datasets/coach-review/gates/coach-gates.v1.json");
    expect(sources.at(-1)!.sha256).toBe(gates.specSha256);
    const examples = readJson<{ marker: string; reviews: unknown[] }>(
      "datasets/coach-review/examples/EXAMPLE-synthetic-reviews.NOT-GOLD.json",
    );
    expect(coaches.coaches).toEqual([]);
    expect(agreement.realReviewCount).toBe(0);
    expect(agreement.coachCount).toBe(0);
    expect(registry.reviewScope.commercialTrainingReadyTemporalSourceCount).toBe(0);
    expect(
      gates.gates
        .filter((gate) => gate.kind !== "lock")
        .every((gate) => gate.verdict === "NOT_EVALUABLE"),
    ).toBe(true);
    expect(examples.marker).toBe("NOT_GOLD_SYNTHETIC_EXAMPLE");
    expectBlocked(examples);
    expectBlocked(study(), "qualified_data_missing");
    if (process.env.W06_INVENTORY_DIAGNOSTIC === "1")
      console.info(
        "W06_INVENTORY",
        JSON.stringify({
          sources,
          qualifiedCoaches: coaches.coaches.length,
          historicalCountedCoachReviews: agreement.realReviewCount,
          historicalAgreementReportAt: agreement.generatedAtIso,
          historicalGateReportAt: gates.generatedAtIso,
          historicalScientificGateVerdicts: gates.gates
            .filter((gate) => gate.kind !== "lock")
            .map((gate) => gate.verdict),
          registryReviewAt: registry.verifiedAt,
          commercialTrainingReadyTemporalSourceCount:
            registry.reviewScope.commercialTrainingReadyTemporalSourceCount,
          registeredStaticSources: registry.sources.length,
          evaluatedButExcludedSources: registry.evaluatedButExcluded.length,
          registeredFreshCandidateEntriesNotW06Eligible: registry.freshCandidates.items.length,
          registeredDevPoolEntriesNotW06Eligible: registry.devPool.items.length,
          syntheticExampleReviewsNotGold: examples.reviews.length,
          mediaBytesReadOrLabelsCreated: false,
        }),
      );
  });
});

describe("exact zero-event sample-size implications, arithmetic only", () => {
  it.each([
    [1, 0.95],
    [50, 0.058155079116972264],
    [148, 0.02003795168910416],
    [149, 0.019904816220685073],
    [300, 0.00993608194445772],
  ])(
    "retains a strictly positive exact bound at %s independent zero-event units",
    async (n, upper95) => {
      const result = await zeroEventErrorBoundDiagnostic(n!);
      expect(result.upper95).toBeCloseTo(upper95!, 14);
      expect(result.upper95).toBeGreaterThan(0);
      expect(Math.pow(1 - result.upper95!, n!)).toBeCloseTo(0.05, 12);
      expect(result.meetsTwoPercent).toBe(n! >= 149);
      expect(result.authorizesRelease).toBe(false);
    },
  );

  it("reuses the tested exact one-sided utility: 50 independent zero-error units cannot prove 2%", async () => {
    const result = await zeroEventErrorBoundDiagnostic(50);
    expect(result.status).toBe("DIAGNOSTIC_ONLY");
    expect(result.method).toBe("exact_binomial_zero_events_one_sided_95");
    expect(result.upper95).toBeCloseTo(0.0581550791, 8);
    expect(result.minimumIndependentUnitsForTwoPercent).toBe(149);
    expect(result.meetsTwoPercent).toBe(false);
    expect(result.authorizesRelease).toBe(false);
    expect((await zeroEventErrorBoundDiagnostic(149)).meetsTwoPercent).toBe(true);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses unevaluable sample count %s",
    async (n) => {
      const result = await zeroEventErrorBoundDiagnostic(n);
      expect(result.status).toBe("NOT_EVALUABLE");
      expect(result.upper95).toBeNull();
      expect(result.meetsTwoPercent).toBeNull();
    },
  );

  it("does not turn one group into independent trials or bootstrap zero into confidence", async () => {
    expect((await zeroEventErrorBoundDiagnostic(1)).upper95).toBeCloseTo(0.95);
    const source = readFileSync(resolve(import.meta.dirname, "../src/benchmarkRelease.ts"), "utf8");
    expect(source).toContain("zeroEventUpperBound95");
    expect(source).toContain("independentTrialsForZeroEventUpperBound95");
    expect(source).not.toMatch(/node:fs|capture-envelope\/src\/f18Analysis/);
    expect(source).toContain("validateRealBenchmarkPartitionIsolation");
  });
});
