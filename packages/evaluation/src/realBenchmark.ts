import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
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

function invalid<T>(code: string, message: string): Result<T> {
  return fail(failure("permanent", code, message));
}
