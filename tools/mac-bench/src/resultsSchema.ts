import type { StageLatencySummary, StageSample } from "./latencyStats.js";

/**
 * mac-bench-results-v1 — the single versioned results document one Mac
 * benchmark run exports. Comparable across runs via compareResults.ts.
 *
 * DESIGN RULES (mirror the repo's evidence contracts):
 *  - Every number carries provenance (git commit, host, case list, sample
 *    counts). A consumer can always answer "measured where, on what?".
 *  - Absence is honest: cascade is `null` with `cascadeUnmeasuredReason` set
 *    when the run could not produce cascade numbers — never zeros.
 *  - The schema changes only by re-versioning (mac-bench-results-v2, …).
 */
export const MAC_BENCH_RESULTS_SCHEMA_VERSION = "mac-bench-results-v1";

export interface MacBenchHost {
  /** process.platform of the box that ran the bench (expected 'darwin'). */
  platform: string;
  osVersion: string;
  /** e.g. 'Mac15,6' / sysctl hw.model; null when not queryable. */
  hardwareModel: string | null;
  nodeVersion: string;
  /** `python3 --version` of the paddle-lab venv; null when absent. */
  pythonVersion: string | null;
}

export interface MacBenchProvenance {
  gitCommit: string;
  gitBranch: string;
  /** True when the working tree had uncommitted changes — the run is then
   * NOT reproducible from the commit alone and comparisons must say so. */
  dirtyWorkingTree: boolean;
}

export interface MacBenchRunPlan {
  caseIds: string[];
  coldIterations: number;
  warmIterations: number;
}

/** Counters copied verbatim from the freshest datasets/cascade/cascade-*.json
 * produced by `pnpm lab:cascade` during this bench run. Never recomputed. */
export interface MacBenchCascadeSummary {
  sourceFile: string;
  goldEvents: number;
  unconditionalPass: Record<string, number>;
  conditionalSurvival: Record<string, number>;
  strictSurvival: { survived: number; total: number };
  usableResult: { usable: number; total: number; contractVersion: string };
  silentFailure: {
    silentFailures: number;
    answeredTrials: number;
    allTrials: number;
    contractVersion: string;
  };
}

export interface MacBenchExtractorBuild {
  built: boolean;
  buildWallMs: number | null;
  binaryPath: string | null;
}

export interface MacBenchResultsV1 {
  schemaVersion: typeof MAC_BENCH_RESULTS_SCHEMA_VERSION;
  generatedAtIso: string;
  host: MacBenchHost;
  provenance: MacBenchProvenance;
  plan: MacBenchRunPlan;
  extractor: MacBenchExtractorBuild;
  /** Per-stage cold/warm latency summaries (see run-mac-bench.sh for the
   * stage vocabulary: e2e, poseExtract, playerTrack, eventPrePass,
   * paddleDetect, ballDetect, eventIsolation, fusionAnalysis, cascade). */
  stages: StageLatencySummary[];
  cascade: MacBenchCascadeSummary | null;
  /** Required (non-empty) when cascade is null. */
  cascadeUnmeasuredReason: string | null;
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCountRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (count) => typeof count === "number" && Number.isInteger(count) && count >= 0,
    )
  );
}

function percentileErrors(value: unknown, path: string): string[] {
  if (value === null) return [];
  if (!isRecord(value)) return [`${path}: expected object or null`];
  const errors: string[] = [];
  for (const key of ["sampleCount", "minMs", "maxMs", "meanMs", "p50Ms", "p90Ms", "p95Ms"]) {
    if (!isFiniteNonNegative(value[key]))
      errors.push(`${path}.${key}: expected finite number >= 0`);
  }
  return errors;
}

function sampleErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path}: expected object`];
  const errors: string[] = [];
  if (!isNonEmptyString(value.stage)) errors.push(`${path}.stage: expected non-empty string`);
  if (!isNonEmptyString(value.caseId)) errors.push(`${path}.caseId: expected non-empty string`);
  if (value.phase !== "cold" && value.phase !== "warm")
    errors.push(`${path}.phase: expected 'cold'|'warm'`);
  if (
    typeof value.iteration !== "number" ||
    !Number.isInteger(value.iteration) ||
    value.iteration < 1
  ) {
    errors.push(`${path}.iteration: expected integer >= 1`);
  }
  if (!isFiniteNonNegative(value.wallMs))
    errors.push(`${path}.wallMs: expected finite number >= 0`);
  return errors;
}

/**
 * Structural validation of a parsed results document. Returns a list of
 * human-readable errors — empty means the document conforms to
 * mac-bench-results-v1. Never throws on malformed input.
 */
export function validateMacBenchResults(value: unknown): string[] {
  if (!isRecord(value)) return ["root: expected object"];
  const errors: string[] = [];

  if (value.schemaVersion !== MAC_BENCH_RESULTS_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected '${MAC_BENCH_RESULTS_SCHEMA_VERSION}'`);
  }
  if (!isNonEmptyString(value.generatedAtIso) || Number.isNaN(Date.parse(value.generatedAtIso))) {
    errors.push("generatedAtIso: expected parseable ISO timestamp");
  }

  if (!isRecord(value.host)) {
    errors.push("host: expected object");
  } else {
    if (!isNonEmptyString(value.host.platform))
      errors.push("host.platform: expected non-empty string");
    if (!isNonEmptyString(value.host.osVersion))
      errors.push("host.osVersion: expected non-empty string");
    if (value.host.hardwareModel !== null && !isNonEmptyString(value.host.hardwareModel)) {
      errors.push("host.hardwareModel: expected non-empty string or null");
    }
    if (!isNonEmptyString(value.host.nodeVersion))
      errors.push("host.nodeVersion: expected non-empty string");
    if (value.host.pythonVersion !== null && !isNonEmptyString(value.host.pythonVersion)) {
      errors.push("host.pythonVersion: expected non-empty string or null");
    }
  }

  if (!isRecord(value.provenance)) {
    errors.push("provenance: expected object");
  } else {
    if (!isNonEmptyString(value.provenance.gitCommit))
      errors.push("provenance.gitCommit: expected non-empty string");
    if (!isNonEmptyString(value.provenance.gitBranch))
      errors.push("provenance.gitBranch: expected non-empty string");
    if (typeof value.provenance.dirtyWorkingTree !== "boolean") {
      errors.push("provenance.dirtyWorkingTree: expected boolean");
    }
  }

  if (!isRecord(value.plan)) {
    errors.push("plan: expected object");
  } else {
    if (
      !Array.isArray(value.plan.caseIds) ||
      value.plan.caseIds.length === 0 ||
      !value.plan.caseIds.every(isNonEmptyString)
    ) {
      errors.push("plan.caseIds: expected non-empty string array");
    }
    if (
      typeof value.plan.coldIterations !== "number" ||
      !Number.isInteger(value.plan.coldIterations) ||
      value.plan.coldIterations < 0
    ) {
      errors.push("plan.coldIterations: expected integer >= 0");
    }
    if (
      typeof value.plan.warmIterations !== "number" ||
      !Number.isInteger(value.plan.warmIterations) ||
      value.plan.warmIterations < 0
    ) {
      errors.push("plan.warmIterations: expected integer >= 0");
    }
  }

  if (!isRecord(value.extractor)) {
    errors.push("extractor: expected object");
  } else {
    if (typeof value.extractor.built !== "boolean")
      errors.push("extractor.built: expected boolean");
    if (value.extractor.buildWallMs !== null && !isFiniteNonNegative(value.extractor.buildWallMs)) {
      errors.push("extractor.buildWallMs: expected finite number >= 0 or null");
    }
    if (value.extractor.binaryPath !== null && !isNonEmptyString(value.extractor.binaryPath)) {
      errors.push("extractor.binaryPath: expected non-empty string or null");
    }
  }

  if (!Array.isArray(value.stages)) {
    errors.push("stages: expected array");
  } else {
    value.stages.forEach((stage, index) => {
      const path = `stages[${index}]`;
      if (!isRecord(stage)) {
        errors.push(`${path}: expected object`);
        return;
      }
      if (!isNonEmptyString(stage.stage)) errors.push(`${path}.stage: expected non-empty string`);
      if (stage.unit !== "ms") errors.push(`${path}.unit: expected 'ms'`);
      errors.push(...percentileErrors(stage.cold ?? null, `${path}.cold`));
      errors.push(...percentileErrors(stage.warm ?? null, `${path}.warm`));
      if (stage.cold === null && stage.warm === null) {
        errors.push(`${path}: at least one of cold/warm must be summarized`);
      }
      if (!Array.isArray(stage.samples) || stage.samples.length === 0) {
        errors.push(`${path}.samples: expected non-empty array`);
      } else {
        stage.samples.forEach((sample, sampleIndex) => {
          errors.push(...sampleErrors(sample, `${path}.samples[${sampleIndex}]`));
        });
      }
    });
  }

  if (value.cascade === null) {
    if (!isNonEmptyString(value.cascadeUnmeasuredReason)) {
      errors.push("cascadeUnmeasuredReason: required non-empty string when cascade is null");
    }
  } else if (!isRecord(value.cascade)) {
    errors.push("cascade: expected object or null");
  } else {
    const cascade = value.cascade;
    if (!isNonEmptyString(cascade.sourceFile))
      errors.push("cascade.sourceFile: expected non-empty string");
    if (
      typeof cascade.goldEvents !== "number" ||
      !Number.isInteger(cascade.goldEvents) ||
      cascade.goldEvents < 1
    ) {
      errors.push("cascade.goldEvents: expected integer >= 1");
    }
    if (!isCountRecord(cascade.unconditionalPass))
      errors.push("cascade.unconditionalPass: expected stage→count record");
    if (!isCountRecord(cascade.conditionalSurvival)) {
      errors.push("cascade.conditionalSurvival: expected stage→count record");
    }
    if (
      !isRecord(cascade.strictSurvival) ||
      !isFiniteNonNegative(cascade.strictSurvival.survived) ||
      !isFiniteNonNegative(cascade.strictSurvival.total)
    ) {
      errors.push("cascade.strictSurvival: expected {survived, total}");
    }
    if (
      !isRecord(cascade.usableResult) ||
      !isFiniteNonNegative(cascade.usableResult.usable) ||
      !isFiniteNonNegative(cascade.usableResult.total) ||
      !isNonEmptyString(cascade.usableResult.contractVersion)
    ) {
      errors.push("cascade.usableResult: expected {usable, total, contractVersion}");
    }
    if (
      !isRecord(cascade.silentFailure) ||
      !isFiniteNonNegative(cascade.silentFailure.silentFailures) ||
      !isFiniteNonNegative(cascade.silentFailure.answeredTrials) ||
      !isFiniteNonNegative(cascade.silentFailure.allTrials) ||
      !isNonEmptyString(cascade.silentFailure.contractVersion)
    ) {
      errors.push(
        "cascade.silentFailure: expected {silentFailures, answeredTrials, allTrials, contractVersion}",
      );
    }
  }

  if (!Array.isArray(value.notes) || !value.notes.every((note) => typeof note === "string")) {
    errors.push("notes: expected string array");
  }

  return errors;
}

export type { StageLatencySummary, StageSample };
