import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  DatasetReleaseIndex,
  auditModelDatasetLineage,
  validateDatasetReleaseManifest,
  type DatasetReleaseManifest,
  type ModelManifest,
} from "../src/index.js";

const HASH = "a".repeat(64);

const validManifest = (): DatasetReleaseManifest => ({
  schemaVersion: 1,
  releaseId: "pickle-sensei-datasets@v1",
  datasetId: "pickle-sensei-datasets",
  version: "v1",
  createdAtIso: "2026-08-29T00:00:00.000Z",
  immutable: true,
  annotationSchemaVersion: 1,
  components: [
    {
      componentId: "corpus",
      path: "datasets/corpus",
      description: "source/recording/split registries + tier-C mined events",
      classification: "mixed_human_and_machine",
      notGold: false,
      notGoldReason: null,
      artifacts: [
        {
          path: "releases/x/artifacts/sources.json",
          livePath: "datasets/corpus/sources.json",
          sha256: HASH,
        },
      ],
    },
    {
      componentId: "cascade",
      path: "datasets/cascade",
      description: "machine-generated cascade run outputs",
      classification: "run_outputs",
      notGold: true,
      notGoldReason: "machine measurements over gold cases; never ground truth",
      artifacts: [],
    },
  ],
  statistics: {
    sources: 20,
    recordings: 26,
    rootRecordings: 17,
    sessions: 12,
    rootFootageMinutes: 60,
    annotatedCases: 5,
    goldTargetEvents: 5,
    tierCCandidateEvents: 199,
    goldLabelCounts: { eventLabels: 34 },
    annotators: 1,
    expertCoaches: 0,
  },
  labels: {
    GOLD: { definition: "human-verified ground truth", count: 34 },
    SILVER: { definition: "verified teacher output", count: 0, verificationNote: "" },
    TIER_C: { definition: "machine-mined candidates; NEVER labels", count: 199 },
  },
  rights: {
    trainingEligibleSources: 18,
    rightsQuarantinedSources: 2,
    policy: "per-modality rights; train must be affirmative or the source is quarantined",
  },
  consent: {
    firstPartyRecordings: 0,
    analysisConsentRecords: 0,
    trainingConsentRecords: 0,
    policy: "consent for analysis is separate from consent for training; default is off",
  },
  splits: {
    policyVersion: "splits-v1",
    unit: "session",
    bySplit: { dev: { sessions: ["a"] }, locked_test: { sessions: ["b"] } },
    leakageFindings: [],
  },
  dedupLineage: {
    algo: "dhash64-9x8-gray@1fps",
    findings: 7,
    declaredLineageConfirmed: 2,
    mergedSessions: 3,
    limitations: "temporal dHash does not catch spatial crops",
    report: { path: "datasets/corpus/dedup-report.json", livePath: null, sha256: HASH },
  },
  knownLimitations: ["single annotator; no expert coach validation"],
  problems: [],
  warnings: [],
});

describe("validateDatasetReleaseManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateDatasetReleaseManifest(validManifest())).toEqual([]);
  });

  it("rejects releaseId that is not datasetId@version", () => {
    const manifest = { ...validManifest(), releaseId: "wrong" };
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("releaseId must be datasetId@version"),
    );
  });

  it("rejects duplicate component ids and malformed hashes", () => {
    const manifest = validManifest();
    manifest.components.push({ ...manifest.components[0]! });
    manifest.components[0]!.artifacts[0]!.sha256 = "nothex";
    const problems = validateDatasetReleaseManifest(manifest);
    expect(problems).toContainEqual(expect.stringContaining("duplicate component corpus"));
    expect(problems).toContainEqual(expect.stringContaining("malformed sha256"));
  });

  it("forces machine-generated / run-output components to be marked notGold", () => {
    const manifest = validManifest();
    manifest.components[1]!.notGold = false;
    manifest.components[1]!.notGoldReason = null;
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("must be marked notGold"),
    );
  });

  it("rejects gold components dishonestly flagged notGold and notGold without reason", () => {
    const manifest = validManifest();
    manifest.components[0]!.classification = "gold_human_labels";
    manifest.components[0]!.notGold = true;
    manifest.components[0]!.notGoldReason = "x";
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("cannot also be notGold"),
    );
    const manifest2 = validManifest();
    manifest2.components[1]!.notGoldReason = null;
    expect(validateDatasetReleaseManifest(manifest2)).toContainEqual(
      expect.stringContaining("requires a notGoldReason"),
    );
  });

  it("rejects silver-washing: SILVER count without a verification note", () => {
    const manifest = validManifest();
    manifest.labels.SILVER.count = 3;
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("silver-washing forbidden"),
    );
  });

  it("rejects consent policies that conflate analysis and training consent", () => {
    const manifest = validManifest();
    manifest.consent.policy = "users agreed to everything";
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("analysis vs training"),
    );
    const manifest2 = validManifest();
    manifest2.consent.trainingConsentRecords = 5;
    expect(validateDatasetReleaseManifest(manifest2)).toContainEqual(
      expect.stringContaining("cannot exceed analysisConsentRecords"),
    );
  });

  it("rejects sessions spanning splits unless the leakage is a recorded finding", () => {
    const manifest = validManifest();
    manifest.splits.bySplit["locked_test"]!.sessions.push("a");
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("session a spans splits"),
    );
    manifest.splits.leakageFindings.push("session a spans splits — documented limitation");
    expect(validateDatasetReleaseManifest(manifest)).toEqual([]);
  });

  it("requires honest knownLimitations", () => {
    const manifest = validManifest();
    manifest.knownLimitations = [];
    expect(validateDatasetReleaseManifest(manifest)).toContainEqual(
      expect.stringContaining("knownLimitations is empty"),
    );
  });
});

describe("DatasetReleaseIndex + auditModelDatasetLineage", () => {
  it("resolves releases by version and releaseId; rejects duplicates", () => {
    const index = new DatasetReleaseIndex([validManifest()]);
    expect(index.has("v1")).toBe(true);
    expect(index.byVersion("pickle-sensei-datasets@v1")?.version).toBe("v1");
    expect(index.byVersion("v2")).toBeNull();
    expect(() => index.register(validManifest())).toThrow(/duplicate dataset release/);
  });

  it("registers legacy pre-v1 releases by version string only", () => {
    const index = new DatasetReleaseIndex();
    index.registerLegacy("pickle-real-v0.3");
    expect(index.has("pickle-real-v0.3")).toBe(true);
    expect(index.byVersion("pickle-real-v0.3")).toBeNull();
  });

  it("refuses to register an invalid manifest", () => {
    const bad = { ...validManifest(), knownLimitations: [] };
    expect(() => new DatasetReleaseIndex([bad])).toThrow(/invalid dataset release/);
  });

  it("flags model entries whose dataset pointers do not resolve; null pointers pass", () => {
    const index = new DatasetReleaseIndex([validManifest()]);
    const entry = DEFAULT_MODEL_MANIFEST.entries[0]!;
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        { ...entry, id: "m.ok", trainingDatasetVersion: "v1", evaluationDatasetVersion: null },
        {
          ...entry,
          id: "m.dangling",
          trainingDatasetVersion: "pickle-real-v9.9",
          evaluationDatasetVersion: "v1",
        },
      ],
    };
    const problems = auditModelDatasetLineage(manifest, index);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("m.dangling@");
    expect(problems[0]).toContain("pickle-real-v9.9");
  });

  it("the default manifest's lineage pointers all resolve (they are honestly null today)", () => {
    const index = new DatasetReleaseIndex([validManifest()]);
    expect(auditModelDatasetLineage(DEFAULT_MODEL_MANIFEST, index)).toEqual([]);
  });
});
