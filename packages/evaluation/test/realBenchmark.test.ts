import { describe, expect, it } from "vitest";
import {
  assignSplits,
  REAL_BENCHMARK_SCHEMA_VERSION,
  reportBanner,
  splitForPlayer,
  validateRealBenchmarkManifest,
  type RealBenchmarkManifest,
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
