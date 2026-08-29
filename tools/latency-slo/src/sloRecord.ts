/**
 * pickle.latency-slo-record.v1 — one raw sample of the SLO metric
 * MOVEMENT_COMPLETION -> RESULT_INTERACTIVE, carrying its full slice
 * (device, OS, stroke, model version, capture condition, cold/warm) and its
 * provenance.
 *
 * DESIGN RULES (mirror the repo's evidence contracts):
 *  - Provenance is mandatory and coarse-grained on purpose:
 *    LINUX_BENCH_NOT_DEVICE numbers must never be readable as iPhone
 *    evidence. Reports built from them carry an explicit disclaimer.
 *  - Slice values must be non-empty strings; unknown dimensions are labeled
 *    honestly (e.g. "UNLABELED_COMMITTED_DEV_CLIP"), never guessed.
 *  - The schema changes only by re-versioning — never edit v1 in place.
 */

export const LATENCY_SLO_RECORD_SCHEMA_VERSION = "pickle.latency-slo-record.v1";

export const LATENCY_SLO_METRIC = "MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE" as const;

export type SloProvenance = "LINUX_BENCH_NOT_DEVICE" | "DEVICE_MEASUREMENT";

export type SloPhase = "cold" | "warm";

export interface LatencySloSlice {
  /** Hardware identity ("linux-x86_64" for the Linux bench box — NOT a phone). */
  device: string;
  /** Operating system / platform string of the measuring host. */
  os: string;
  /** Stroke label of the measured clip, or an honest UNLABELED marker. */
  stroke: string;
  /** Pipeline/model identity, e.g. "integrated-default@8fc388ee1625". */
  modelVersion: string;
  /** Capture condition of the source clip, or an honest UNLABELED marker. */
  captureCondition: string;
  /** 'cold' = first run after process/caches were fresh; 'warm' = subsequent. */
  phase: SloPhase;
}

export interface LatencySloSource {
  /** File the sample was ingested from (relative to repo root when possible). */
  file: string;
  /** Benchmark arm name, when the source is a benchmark run. */
  arm: string | null;
  /** Clip identifier, when the source is a clip benchmark. */
  clipId: string | null;
  /** Git commit of the measured code, when known. */
  gitCommit: string | null;
}

export interface LatencySloRecord {
  schemaVersion: typeof LATENCY_SLO_RECORD_SCHEMA_VERSION;
  metric: typeof LATENCY_SLO_METRIC;
  provenance: SloProvenance;
  slice: LatencySloSlice;
  wallMs: number;
  measuredAtIso: string;
  source: LatencySloSource;
}

export const SLO_SLICE_DIMENSIONS = [
  "device",
  "os",
  "stroke",
  "modelVersion",
  "captureCondition",
] as const;

export type SloSliceDimension = (typeof SLO_SLICE_DIMENSIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Structural validation of a parsed record. Returns a list of human-readable
 * errors — empty means the value conforms to pickle.latency-slo-record.v1.
 * Never throws on malformed input.
 */
export function validateLatencySloRecord(value: unknown, path = "record"): string[] {
  if (!isRecord(value)) return [`${path}: expected object`];
  const errors: string[] = [];

  if (value.schemaVersion !== LATENCY_SLO_RECORD_SCHEMA_VERSION) {
    errors.push(`${path}.schemaVersion: expected '${LATENCY_SLO_RECORD_SCHEMA_VERSION}'`);
  }
  if (value.metric !== LATENCY_SLO_METRIC) {
    errors.push(`${path}.metric: expected '${LATENCY_SLO_METRIC}'`);
  }
  if (value.provenance !== "LINUX_BENCH_NOT_DEVICE" && value.provenance !== "DEVICE_MEASUREMENT") {
    errors.push(`${path}.provenance: expected 'LINUX_BENCH_NOT_DEVICE'|'DEVICE_MEASUREMENT'`);
  }

  if (!isRecord(value.slice)) {
    errors.push(`${path}.slice: expected object`);
  } else {
    for (const dimension of SLO_SLICE_DIMENSIONS) {
      if (!isNonEmptyString(value.slice[dimension])) {
        errors.push(`${path}.slice.${dimension}: expected non-empty string`);
      }
    }
    if (value.slice.phase !== "cold" && value.slice.phase !== "warm") {
      errors.push(`${path}.slice.phase: expected 'cold'|'warm'`);
    }
  }

  if (typeof value.wallMs !== "number" || !Number.isFinite(value.wallMs) || value.wallMs < 0) {
    errors.push(`${path}.wallMs: expected finite number >= 0`);
  }
  if (!isNonEmptyString(value.measuredAtIso) || Number.isNaN(Date.parse(value.measuredAtIso))) {
    errors.push(`${path}.measuredAtIso: expected parseable ISO timestamp`);
  }

  if (!isRecord(value.source)) {
    errors.push(`${path}.source: expected object`);
  } else {
    if (!isNonEmptyString(value.source.file)) {
      errors.push(`${path}.source.file: expected non-empty string`);
    }
    if (value.source.arm !== null && !isNonEmptyString(value.source.arm)) {
      errors.push(`${path}.source.arm: expected non-empty string or null`);
    }
    if (value.source.clipId !== null && !isNonEmptyString(value.source.clipId)) {
      errors.push(`${path}.source.clipId: expected non-empty string or null`);
    }
    if (value.source.gitCommit !== null && !isNonEmptyString(value.source.gitCommit)) {
      errors.push(`${path}.source.gitCommit: expected non-empty string or null`);
    }
  }

  return errors;
}
