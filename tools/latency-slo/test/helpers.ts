import {
  LATENCY_SLO_METRIC,
  LATENCY_SLO_RECORD_SCHEMA_VERSION,
  type LatencySloRecord,
} from "../src/sloRecord.js";

export function makeRecord(overrides: Partial<LatencySloRecord> = {}): LatencySloRecord {
  return {
    schemaVersion: LATENCY_SLO_RECORD_SCHEMA_VERSION,
    metric: LATENCY_SLO_METRIC,
    provenance: "LINUX_BENCH_NOT_DEVICE",
    slice: {
      device: "linux-x86_64",
      os: "Linux-5.15.200-x86_64-with-glibc2.35",
      stroke: "volley",
      modelVersion: "integrated-default@8fc388ee1625",
      captureCondition: "UNLABELED_COMMITTED_DEV_CLIP",
      phase: "warm",
    },
    wallMs: 4200,
    measuredAtIso: "2026-08-29T10:26:20Z",
    source: {
      file: "tools/latency-bench/artifacts/bench-results.json",
      arm: "integrated-default",
      clipId: "wm-volley-02",
      gitCommit: "8fc388ee1625b0aaa7e16cb7da93cd3feb1c9c84",
    },
    ...overrides,
  };
}
