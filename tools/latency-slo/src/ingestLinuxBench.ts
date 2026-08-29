/**
 * Ingests tools/latency-bench artifacts (the E17 Linux end-to-end analysis
 * benchmark, bench_e2e.py) into pickle.latency-slo-record.v1 records.
 *
 * PROVENANCE: every record produced here is LINUX_BENCH_NOT_DEVICE —
 * measured on a Linux CPU box, movement-complete -> result being the
 * ANALYSIS stage over pre-extracted pose artifacts (Apple-Vision extraction
 * cannot run on Linux). Valid for regression trend tracking only; never
 * device evidence. The ingester refuses non-Linux hosts outright rather than
 * mislabeling them.
 *
 * Slice mapping:
 *  - device            "linux-<machine>" (e.g. linux-x86_64) — a CI/dev box.
 *  - os                the bench host platform string.
 *  - stroke            frozen per-clip label below; unknown clips are
 *                      "UNLABELED_CLIP", never guessed.
 *  - modelVersion      "<arm>@<commit12>" so pipeline variants and code
 *                      revisions slice apart.
 *  - captureCondition  "UNLABELED_COMMITTED_DEV_CLIP" — the committed dev
 *                      clips carry no capture-condition metadata and none is
 *                      invented.
 *  - phase             warm-up runs are 'cold'; measured reps are 'warm'.
 *
 * Runs with a non-zero exit code are dropped (their wall time measures a
 * crash, not the SLO); runs that completed but abstained still count — an
 * abstention is still a user-visible result.
 */

import {
  LATENCY_SLO_METRIC,
  LATENCY_SLO_RECORD_SCHEMA_VERSION,
  type LatencySloRecord,
} from "./sloRecord.js";

/** Frozen stroke labels for the committed latency-bench dev clips. */
export const LINUX_BENCH_CLIP_STROKES: Readonly<Record<string, string>> = {
  "wm-volley-02": "volley",
  "afn-sasebo-rally1": "rally-mixed",
};

export const UNLABELED_CLIP_STROKE = "UNLABELED_CLIP";
export const UNLABELED_CAPTURE_CONDITION = "UNLABELED_COMMITTED_DEV_CLIP";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface LinuxBenchRun {
  arm: string;
  clip: string;
  warmup: boolean;
  wallMs: number;
  exitCode: number;
}

function parseRun(value: unknown, path: string): LinuxBenchRun {
  if (!isRecord(value)) throw new Error(`${path}: expected object`);
  if (!isNonEmptyString(value.arm)) throw new Error(`${path}.arm: expected non-empty string`);
  if (!isNonEmptyString(value.clip)) throw new Error(`${path}.clip: expected non-empty string`);
  if (typeof value.warmup !== "boolean") throw new Error(`${path}.warmup: expected boolean`);
  if (typeof value.wallMs !== "number" || !Number.isFinite(value.wallMs) || value.wallMs < 0) {
    throw new Error(`${path}.wallMs: expected finite number >= 0`);
  }
  if (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)) {
    throw new Error(`${path}.exitCode: expected integer`);
  }
  return {
    arm: value.arm,
    clip: value.clip,
    warmup: value.warmup,
    wallMs: value.wallMs,
    exitCode: value.exitCode,
  };
}

export interface IngestLinuxBenchResult {
  records: LatencySloRecord[];
  /** Runs skipped because their exit code was non-zero. */
  skippedNonZeroExit: number;
}

/**
 * Converts a parsed bench-results document (bench_e2e.py output) into SLO
 * records. Throws loudly on malformed documents and on non-Linux hosts.
 * `sourceFile` should be the artifact path relative to the repo root.
 */
export function ingestLinuxBenchResults(
  document: unknown,
  sourceFile: string,
): IngestLinuxBenchResult {
  if (!isRecord(document)) throw new Error("ingestLinuxBenchResults: expected object document");
  if (!isRecord(document.host) || !isNonEmptyString(document.host.platform)) {
    throw new Error("ingestLinuxBenchResults: host.platform missing");
  }
  if (!document.host.platform.startsWith("Linux")) {
    throw new Error(
      `ingestLinuxBenchResults: host.platform '${document.host.platform}' is not Linux — ` +
        "refusing to label as LINUX_BENCH_NOT_DEVICE",
    );
  }
  if (!isNonEmptyString(document.host.machine)) {
    throw new Error("ingestLinuxBenchResults: host.machine missing");
  }
  if (!isNonEmptyString(document.createdAtIso) || Number.isNaN(Date.parse(document.createdAtIso))) {
    throw new Error("ingestLinuxBenchResults: createdAtIso missing or unparseable");
  }
  if (!isRecord(document.commits)) {
    throw new Error("ingestLinuxBenchResults: commits missing");
  }
  const integratedCommit = document.commits.integrated;
  const baselineCommit = document.commits.baselinePreIntegration;
  if (!isNonEmptyString(integratedCommit) || !isNonEmptyString(baselineCommit)) {
    throw new Error("ingestLinuxBenchResults: commits.integrated/baselinePreIntegration missing");
  }
  if (!Array.isArray(document.runs) || document.runs.length === 0) {
    throw new Error("ingestLinuxBenchResults: runs missing or empty");
  }

  const device = `linux-${document.host.machine}`;
  const os = document.host.platform;
  const measuredAtIso = document.createdAtIso;

  const records: LatencySloRecord[] = [];
  let skippedNonZeroExit = 0;
  document.runs.forEach((rawRun, index) => {
    const run = parseRun(rawRun, `runs[${index}]`);
    if (run.exitCode !== 0) {
      skippedNonZeroExit += 1;
      return;
    }
    const commit = run.arm === "baseline-pre-integration" ? baselineCommit : integratedCommit;
    records.push({
      schemaVersion: LATENCY_SLO_RECORD_SCHEMA_VERSION,
      metric: LATENCY_SLO_METRIC,
      provenance: "LINUX_BENCH_NOT_DEVICE",
      slice: {
        device,
        os,
        stroke: LINUX_BENCH_CLIP_STROKES[run.clip] ?? UNLABELED_CLIP_STROKE,
        modelVersion: `${run.arm}@${commit.slice(0, 12)}`,
        captureCondition: UNLABELED_CAPTURE_CONDITION,
        phase: run.warmup ? "cold" : "warm",
      },
      wallMs: run.wallMs,
      measuredAtIso,
      source: { file: sourceFile, arm: run.arm, clipId: run.clip, gitCommit: commit },
    });
  });

  return { records, skippedNonZeroExit };
}
