import {
  REGRESSION_CONTRACT_ID,
  REGRESSION_CONTRACT_VERSION,
  REGRESSION_SUMMARY_SCHEMA_VERSION,
  flattenBenchMetrics,
  type BenchRecord,
  type RegressionSummary,
} from "../src/index.js";

export const GIT_SHA = "7c034aa00ea3c4ff0e63c3b84b548cec8d62c96f";
export const TREE_SHA = "0afe807595172f683590fa7bfca741a7b398b638";
export const MANIFEST_SHA = "53c108768c4f1ef62e166193d988498138cb02343f9011643d68368018d2e062";

export function bench(overrides: Partial<BenchRecord> = {}): BenchRecord {
  return {
    id: "contact_replay",
    title: "Contact estimation replay",
    kind: "in_process",
    command: "replayAll()",
    cwd: "/repo/packages/vision-geometry",
    status: "ok",
    exitCode: null,
    wallClockMs: 44,
    inputs: ["datasets/corpus/bundles/wavea-*/annotation/*.json"],
    caveats: ["Linux replay proxy"],
    error: null,
    metrics: { target_events: 10, estimated: 7, median_error_ms: 27, p90_error_ms: null },
    labels: { estimatorVersion: "contact-evidence-4.4" },
    ...overrides,
  };
}

export function summary(
  overrides: Partial<RegressionSummary> = {},
  benches: BenchRecord[] = [bench()],
): RegressionSummary {
  return {
    schemaVersion: REGRESSION_SUMMARY_SCHEMA_VERSION,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: REGRESSION_CONTRACT_VERSION,
    runId: "2026-09-04T02-24-36.147Z",
    generatedAtIso: "2026-09-04T02:24:37.313Z",
    runner: { node: "v22.23.2", platform: "linux", arch: "x64" },
    provenance: {
      gitSha: GIT_SHA,
      gitBranch: "main",
      gitDirty: false,
      datasetsTreeSha: TREE_SHA,
      datasetReleases: [
        {
          releaseDir: "pickle-sensei-datasets-v2",
          releaseId: "pickle-sensei-datasets@v2",
          datasetId: "pickle-sensei-datasets",
          manifestSha256: MANIFEST_SHA,
        },
      ],
      modelVersions: { contactEstimator: "contact-evidence-4.4" },
      evidenceClass: "linux_replay_proxy",
    },
    benches,
    metrics: flattenBenchMetrics(benches),
    caveats: ["proxy evidence"],
    totalWallClockMs: 1166,
    ...overrides,
  };
}
