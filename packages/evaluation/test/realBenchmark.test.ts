import { describe, expect, it } from "vitest";
import {
  assignSplits,
  REAL_BENCHMARK_SCHEMA_VERSION,
  REAL_TECHNIQUE_METADATA_SCHEMA_VERSION,
  reportBanner,
  splitForPlayer,
  validateRealBenchmarkManifest,
  validateRealBenchmarkPartitionIsolation,
  validateRealTechniqueBenchmarkMetadata,
  type RealBenchmarkManifest,
  type RealTechniqueBenchmarkMetadata,
} from "../src/index.js";

const hash = (seed: string) =>
  seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");

function manifest(overrides: Partial<RealBenchmarkManifest> = {}): RealBenchmarkManifest {
  return {
    schemaVersion: REAL_BENCHMARK_SCHEMA_VERSION,
    id: "pickle-real-v1",
    version: "1.0.0",
    createdAtIso: "2026-08-27T00:00:00.000Z",
    provenance: "consented_first_party",
    splitRatios: { train: 0.7, val: 0.15, test: 0.15 },
    cases: [
      {
        caseId: "case-1",
        videoSha256: hash("1"),
        poseSequenceSha256: hash("2"),
        playerId: "player-a",
        declaredStroke: "forehand_drive",
        annotationPath: "annotations/case-1.json",
      },
    ],
    ...overrides,
  };
}

describe("validateRealBenchmarkManifest", () => {
  it("accepts a well-formed consented manifest", () => {
    const result = validateRealBenchmarkManifest(manifest());
    expect(result.ok).toBe(true);
  });

  it("rejects synthetic provenance — synthetic data cannot masquerade as real", () => {
    const result = validateRealBenchmarkManifest(manifest({ provenance: "synthetic" as never }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("real_benchmark.invalid_provenance");
  });

  it("rejects malformed hashes, duplicate ids, and bad split ratios", () => {
    const badHash = validateRealBenchmarkManifest(
      manifest({
        cases: [{ ...manifest().cases[0]!, videoSha256: "not-a-hash" }],
      }),
    );
    expect(badHash.ok).toBe(false);

    const duplicate = validateRealBenchmarkManifest(
      manifest({ cases: [manifest().cases[0]!, manifest().cases[0]!] }),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.failure.code).toBe("real_benchmark.duplicate_case");

    const badSplit = validateRealBenchmarkManifest(
      manifest({ splitRatios: { train: 0.9, val: 0.3, test: 0.1 } }),
    );
    expect(badSplit.ok).toBe(false);
  });
});

describe("splitForPlayer", () => {
  const ratios = { train: 0.7, val: 0.15, test: 0.15 };

  it("is deterministic and stable across case growth", () => {
    const first = splitForPlayer("pickle-real-v1", "player-a", ratios);
    expect(splitForPlayer("pickle-real-v1", "player-a", ratios)).toBe(first);
  });

  it("keeps every clip of one player in one split (no identity leakage)", () => {
    const base = manifest({
      cases: ["c1", "c2", "c3"].map((caseId) => ({
        caseId,
        videoSha256: hash("3"),
        poseSequenceSha256: hash("4"),
        playerId: "player-shared",
        declaredStroke: "dink",
        annotationPath: `annotations/${caseId}.json`,
      })),
    });
    const splits = new Set(assignSplits(base).map((entry) => entry.split));
    expect(splits.size).toBe(1);
  });

  it("distributes many players roughly by the requested ratios", () => {
    const counts = { train: 0, val: 0, test: 0 };
    for (let index = 0; index < 2000; index += 1) {
      counts[splitForPlayer("dataset-x", `player-${index}`, ratios)] += 1;
    }
    expect(counts.train / 2000).toBeGreaterThan(0.65);
    expect(counts.train / 2000).toBeLessThan(0.75);
    expect(counts.test / 2000).toBeGreaterThan(0.1);
    expect(counts.test / 2000).toBeLessThan(0.2);
  });
});

describe("reportBanner", () => {
  it("labels synthetic and real reports unmistakably", () => {
    const synthetic = reportBanner({
      benchmark: {
        id: "synthetic-swings",
        version: "1",
        task: "phase_segmentation",
        provenance: "synthetic",
        caseCount: 10,
        notes: "",
      },
      evaluatedAtIso: "2026-08-27T00:00:00.000Z",
      subject: "phase.geometry@geom-seg-2",
      metrics: {},
      abstainedCaseIds: [],
    });
    expect(synthetic.startsWith("[SYNTHETIC]")).toBe(true);
    const real = reportBanner({
      benchmark: {
        id: "pickle-real-v1",
        version: "1",
        task: "technique_scoring",
        provenance: "consented_first_party",
        caseCount: 3,
        notes: "",
      },
      evaluatedAtIso: "2026-08-27T00:00:00.000Z",
      subject: "scorer.sm-v1@sm-v1",
      metrics: {},
      abstainedCaseIds: [],
    });
    expect(real.startsWith("[REAL]")).toBe(true);
  });
});

function techniqueMetadata(): RealTechniqueBenchmarkMetadata {
  return {
    schemaVersion: REAL_TECHNIQUE_METADATA_SCHEMA_VERSION,
    purpose: "validation_and_confound_analysis_only",
    protocol: { version: "contract-test-protocol", sha256: hash("3") },
    recordedAtIso: "2026-08-20T12:00:00.000Z",
    independence: {
      participantIds: ["player-a"],
      sessionId: "contract-test-session",
      recordingId: "contract-test-recording",
      rawSourceSha256: hash("4"),
      duplicateGroupIds: [],
    },
    eligibilityManifest: {
      schemaId: "eligible-temporal-dataset-v2",
      artifact: { version: "contract-test-eligibility-manifest", sha256: hash("5") },
      itemId: "contract-test-item",
    },
    playerRatings: [
      {
        observationId: "contract-test-rating-singles",
        playerId: "player-a",
        provider: "DUPR",
        ratingType: "singles",
        ratingVariant: "standard",
        value: 3.7,
        ratingAsOfIso: "2026-08-19T12:00:00.000Z",
        observedAtIso: "2026-08-21T12:00:00.000Z",
        evidenceRole: "noisy_player_anchor_not_swing_truth",
        reliability: { status: "recorded", scorePercent: 80 },
        verification: {
          status: "verified",
          evidenceRef: "contract-test-rating-evidence",
          evidenceSha256: hash("6"),
          verifierRef: "contract-test-verifier",
          verifiedAtIso: "2026-08-22T12:00:00.000Z",
        },
        recordingAlignment: {
          status: "historically_verified",
          evidenceRef: "contract-test-history-evidence",
          evidenceSha256: hash("7"),
        },
      },
      {
        observationId: "contract-test-rating-doubles",
        playerId: "player-a",
        provider: "DUPR",
        ratingType: "doubles",
        ratingVariant: null,
        value: 4.2,
        ratingAsOfIso: null,
        observedAtIso: "2026-08-21T12:00:00.000Z",
        evidenceRole: "noisy_player_anchor_not_swing_truth",
        reliability: { status: "unavailable" },
        verification: { status: "unverified", reasonCode: "self_reported" },
        recordingAlignment: { status: "unverified" },
      },
    ],
    coachReviews: [
      {
        reviewId: "contract-test-review",
        coachId: "contract-test-coach-reference",
        reviewSha256: hash("8"),
        qualificationPolicyVersion: "coach-qualification-policy-v1",
        qualificationEvidenceRef: "contract-test-qualification-reference",
        reviewedAtIso: "2026-08-23T12:00:00.000Z",
        blindedToModelOutput: true,
        blindedToPlayerRatings: null,
      },
    ],
  };
}

describe("optional real technique metadata (contract fixtures, not verified real evidence)", () => {
  it("leaves the legacy manifest unchanged and does not manufacture new eligibility", () => {
    const legacy = manifest();
    const result = validateRealBenchmarkManifest(JSON.parse(JSON.stringify(legacy)));
    expect(result).toEqual({ ok: true, value: legacy });
    if (!result.ok) return;
    expect(result.value.cases[0]).not.toHaveProperty("techniqueMetadata");
    expect(assignSplits(result.value)).toEqual(assignSplits(legacy));
    expect(validateRealBenchmarkPartitionIsolation(assignSplits(legacy)).ok).toBe(false);
  });

  it("preserves all rating types, variants, values, dates and reliability without choosing a target", () => {
    const metadata = techniqueMetadata();
    const value = manifest({ cases: [{ ...manifest().cases[0]!, techniqueMetadata: metadata }] });
    expect(validateRealTechniqueBenchmarkMetadata(metadata)).toEqual({ ok: true, value: metadata });
    expect(validateRealBenchmarkManifest(value)).toEqual({ ok: true, value });
    expect(metadata.playerRatings.map((rating) => rating.value)).toEqual([3.7, 4.2]);
    expect(metadata.playerRatings.map((rating) => rating.ratingType)).toEqual([
      "singles",
      "doubles",
    ]);
    expect(metadata).not.toHaveProperty("swingLabel");
    expect(metadata).not.toHaveProperty("runtimeRating");
  });

  it("records missing external evidence explicitly without calling it an eligible benchmark", () => {
    const value = {
      ...techniqueMetadata(),
      protocol: null,
      recordedAtIso: null,
      eligibilityManifest: null,
      playerRatings: [],
      coachReviews: [],
    };
    expect(validateRealTechniqueBenchmarkMetadata(value)).toEqual({ ok: true, value });
  });

  it("preserves a supplied calendar-only rating date without inventing a timestamp", () => {
    const value = techniqueMetadata();
    value.playerRatings[0]!.ratingAsOfIso = "2026-08-19";
    expect(validateRealTechniqueBenchmarkMetadata(value)).toEqual({ ok: true, value });
  });

  it.each([0, 59, 60, 100])(
    "stores reliability %s as metadata, not a gate pass",
    (scorePercent) => {
      const value = techniqueMetadata();
      value.playerRatings[0]!.reliability = { status: "recorded", scorePercent };
      expect(validateRealTechniqueBenchmarkMetadata(value).ok).toBe(true);
    },
  );

  it.each([
    { value: NaN },
    { value: Infinity },
    { value: 1.99 },
    { value: 8.01 },
    { value: "3.7" },
    { ratingType: "" },
    { ratingVariant: 5 },
    { evidenceRole: "exact_swing_truth" },
    { provider: "inferred_from_identity" },
    { playerId: "unrelated-player" },
    { observedAtIso: "2026-02-30T12:00:00.000Z" },
    { ratingAsOfIso: "2026-08-25T12:00:00.000Z" },
    { ratingAsOfIso: "2026-02-30" },
    { ratingAsOfIso: "2026-08-25" },
    { reliability: { status: "recorded", scorePercent: NaN } },
    { reliability: { status: "recorded", scorePercent: Infinity } },
    { reliability: { status: "recorded", scorePercent: 101 } },
    { reliability: { status: "recorded", scorePercent: -1 } },
    { reliability: { status: "unavailable", scorePercent: 90 } },
    { reliability: { status: "unavailable", scorePercent: null } },
    { verification: { status: "verified" } },
    { verification: { status: "unverified", reasonCode: "self_reported", verified: true } },
    { recordingAlignment: { status: "historically_verified" } },
    { recordingAlignment: { status: "unverified", value: 4.2 } },
    { ratingAsOfIso: null },
    { runtimeInput: true },
  ])("rejects malformed or repurposed player-rating metadata: %j", (override) => {
    const value = techniqueMetadata();
    Object.assign(value.playerRatings[0]!, override);
    expect(validateRealTechniqueBenchmarkMetadata(value).ok).toBe(false);
    expect(
      validateRealBenchmarkManifest(
        manifest({ cases: [{ ...manifest().cases[0]!, techniqueMetadata: value }] }),
      ).ok,
    ).toBe(false);
  });

  it.each([
    { schemaVersion: "unknown" },
    { purpose: "runtime_input" },
    { purpose: "swing_ground_truth" },
    { protocol: { version: "test", sha256: "bad" } },
    { recordedAtIso: null },
    { eligibilityManifest: { schemaId: "eligible-temporal-dataset-v2", itemId: "item" } },
    { independence: { ...techniqueMetadata().independence, rawSourceSha256: "bad" } },
    { independence: { ...techniqueMetadata().independence, participantIds: [] } },
    {
      independence: {
        ...techniqueMetadata().independence,
        participantIds: ["player-a", "player-a"],
      },
    },
    { independence: { ...techniqueMetadata().independence, sessionId: "" } },
    {
      independence: { ...techniqueMetadata().independence, duplicateGroupIds: ["group", "group"] },
    },
    { coachReviews: [{ ...techniqueMetadata().coachReviews[0], reviewSha256: "bad" }] },
    { coachReviews: [{ ...techniqueMetadata().coachReviews[0], qualificationEvidenceRef: "" }] },
    { coachReviews: [{ ...techniqueMetadata().coachReviews[0], blindedToPlayerRatings: "yes" }] },
    { playerRatings: [techniqueMetadata().playerRatings[0], techniqueMetadata().playerRatings[0]] },
    { coachReviews: [techniqueMetadata().coachReviews[0], techniqueMetadata().coachReviews[0]] },
    { numericalReleaseApproved: true },
    { swingLevel: 3.7 },
  ])("rejects missing lineage, false alignment and invented gate flags: %j", (override) => {
    expect(validateRealTechniqueBenchmarkMetadata({ ...techniqueMetadata(), ...override }).ok).toBe(
      false,
    );
  });

  it("rejects metadata that does not bind to the manifest's target player", () => {
    const value = manifest({
      cases: [
        {
          ...manifest().cases[0]!,
          playerId: "other-player",
          techniqueMetadata: techniqueMetadata(),
        },
      ],
    });
    expect(validateRealBenchmarkManifest(value).ok).toBe(false);
  });
});

function partitionCase(
  id: "a" | "b" | "c",
  split: "train" | "val" | "calibration" | "test" | "external_test",
) {
  const metadata = techniqueMetadata();
  metadata.independence = {
    participantIds: [`player-${id}`],
    sessionId: `session-${id}`,
    recordingId: `recording-${id}`,
    rawSourceSha256: hash(id),
    duplicateGroupIds: [`duplicate-${id}`],
  };
  metadata.playerRatings = [];
  return {
    ...manifest().cases[0]!,
    caseId: `case-${id}`,
    playerId: `player-${id}`,
    videoSha256: hash(id),
    poseSequenceSha256: hash(id),
    techniqueMetadata: metadata,
    split,
  };
}

describe("real benchmark partition isolation validator", () => {
  it("accepts explicit independent partitions, including separate calibration and external test", () => {
    for (const split of ["val", "calibration", "test", "external_test"] as const) {
      const cases = [partitionCase("a", "train"), partitionCase("b", split)];
      expect(validateRealBenchmarkPartitionIsolation(cases)).toEqual({ ok: true, value: cases });
    }
  });

  it("rejects leakage through any connected participant, session, raw source or duplicate group", () => {
    for (const key of [
      "participantIds",
      "sessionId",
      "recordingId",
      "rawSourceSha256",
      "duplicateGroupIds",
    ] as const) {
      const cases = [partitionCase("a", "train"), partitionCase("b", "test")];
      const first = cases[0]!.techniqueMetadata.independence;
      const second = cases[1]!.techniqueMetadata.independence;
      if (key === "participantIds") second.participantIds.push("player-a");
      else Object.assign(second, { [key]: first[key] });
      const result = validateRealBenchmarkPartitionIsolation(cases);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("real_benchmark.partition_leakage");
    }
  });

  it("also isolates exact bytes even when metadata lies about source grouping", () => {
    for (const key of ["videoSha256", "poseSequenceSha256"] as const) {
      const cases = [partitionCase("a", "train"), partitionCase("b", "calibration")];
      cases[1]![key] = cases[0]![key];
      expect(validateRealBenchmarkPartitionIsolation(cases).ok, key).toBe(false);
    }
  });

  it("does not count derived variants as independent and catches transitive group connections", () => {
    const cases = [
      partitionCase("a", "train"),
      partitionCase("b", "train"),
      partitionCase("c", "test"),
    ];
    cases[1]!.techniqueMetadata.independence.participantIds.push("player-a");
    cases[2]!.techniqueMetadata.independence.sessionId = "session-b";
    expect(validateRealBenchmarkPartitionIsolation(cases).ok).toBe(false);
    cases[2]!.split = "train";
    expect(validateRealBenchmarkPartitionIsolation(cases).ok).toBe(true);
  });

  it("rejects missing metadata, duplicate cases and unsupported partitions without splitting for callers", () => {
    const value = partitionCase("a", "train");
    expect(validateRealBenchmarkPartitionIsolation([value, value]).ok).toBe(false);
    expect(
      validateRealBenchmarkPartitionIsolation([{ ...value, techniqueMetadata: undefined }]).ok,
    ).toBe(false);
    expect(validateRealBenchmarkPartitionIsolation([{ ...value, split: "unknown" }]).ok).toBe(
      false,
    );
    expect(validateRealBenchmarkPartitionIsolation([]).ok).toBe(false);
    expect(validateRealBenchmarkPartitionIsolation(null).ok).toBe(false);
  });
});
