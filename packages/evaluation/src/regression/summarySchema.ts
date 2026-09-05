import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";

/**
 * Machine-readable summary written by `bench:regression`. One document per
 * invocation, validated before it is written and again before it is compared.
 *
 * The JSON Schema twin lives at `packages/evaluation/regression.summary.schema.json`;
 * `test/regressionSummary.test.ts` pins the two to the same required keys.
 */
export const REGRESSION_SUMMARY_SCHEMA_VERSION = 1 as const;

/** Identity of the bench set + metric semantics. Bump when a bench is added,
 *  removed, or its metric meaning changes; documents with different contract
 *  versions are NOT comparable. */
export const REGRESSION_CONTRACT_ID = "pickle-sensei-linux-regression" as const;
export const REGRESSION_CONTRACT_VERSION = 1 as const;

/** What kind of evidence the summary carries. Linux replays over committed
 *  pose/oracle-ball artifacts are proxies, never the canonical Mac cascade. */
export const REGRESSION_EVIDENCE_CLASSES = ["linux_replay_proxy"] as const;
export type RegressionEvidenceClass = (typeof REGRESSION_EVIDENCE_CLASSES)[number];

export const BENCH_KINDS = ["in_process", "subprocess"] as const;
export type BenchKind = (typeof BENCH_KINDS)[number];

export const BENCH_STATUSES = ["ok", "failed"] as const;
export type BenchStatus = (typeof BENCH_STATUSES)[number];

export interface DatasetReleaseRef {
  /** Directory name under `datasets/releases/`. */
  releaseDir: string;
  /** `releaseId` from the manifest, or `version` for older manifests. */
  releaseId: string;
  datasetId: string | null;
  manifestSha256: string;
}

export interface RegressionProvenance {
  gitSha: string;
  gitBranch: string | null;
  /** Tracked files modified relative to HEAD when the run started. A dirty
   *  tree means `gitSha` alone does not identify the code that was measured. */
  gitDirty: boolean;
  /** sha1 over `git ls-tree -r HEAD:datasets` minus `reports/` — identity of
   *  every committed gold / corpus artifact the benches READ (bench output
   *  such as this runner's own baselines does not change it). */
  datasetsTreeSha: string;
  datasetReleases: DatasetReleaseRef[];
  /** Version constants of the estimators / heuristics exercised. */
  modelVersions: Record<string, string>;
  evidenceClass: RegressionEvidenceClass;
}

export interface RegressionRunner {
  node: string;
  platform: string;
  arch: string;
}

export interface BenchRecord {
  id: string;
  title: string;
  kind: BenchKind;
  /** Exact command (subprocess) or the exported function invoked (in-process). */
  command: string;
  cwd: string;
  status: BenchStatus;
  /** Subprocess exit code; null for in-process benches. */
  exitCode: number | null;
  wallClockMs: number;
  /** Committed inputs read by the bench. */
  inputs: string[];
  caveats: string[];
  /** Error text when `status === "failed"`. */
  error: string | null;
  /** `null` = the bench ran but this quantity was not measurable (e.g. no
   *  estimated events to take a median over). Never a fabricated number. */
  metrics: Record<string, number | null>;
  /** Non-numeric facts worth carrying (bench versions, gate verdicts). */
  labels: Record<string, string>;
}

export interface RegressionSummary {
  schemaVersion: typeof REGRESSION_SUMMARY_SCHEMA_VERSION;
  contract: typeof REGRESSION_CONTRACT_ID;
  contractVersion: number;
  runId: string;
  generatedAtIso: string;
  runner: RegressionRunner;
  provenance: RegressionProvenance;
  benches: BenchRecord[];
  /** Flattened `${bench.id}.${metric}` view of every bench metric — the
   *  surface `bench:compare` and the tolerance config address. */
  metrics: Record<string, number | null>;
  caveats: string[];
  totalWallClockMs: number;
}

export const REQUIRED_SUMMARY_KEYS = [
  "schemaVersion",
  "contract",
  "contractVersion",
  "runId",
  "generatedAtIso",
  "runner",
  "provenance",
  "benches",
  "metrics",
  "caveats",
  "totalWallClockMs",
] as const;

export const REQUIRED_PROVENANCE_KEYS = [
  "gitSha",
  "gitBranch",
  "gitDirty",
  "datasetsTreeSha",
  "datasetReleases",
  "modelVersions",
  "evidenceClass",
] as const;

export const REQUIRED_BENCH_KEYS = [
  "id",
  "title",
  "kind",
  "command",
  "cwd",
  "status",
  "exitCode",
  "wallClockMs",
  "inputs",
  "caveats",
  "error",
  "metrics",
  "labels",
] as const;

export const REQUIRED_RUNNER_KEYS = ["node", "platform", "arch"] as const;
export const REQUIRED_RELEASE_KEYS = [
  "releaseDir",
  "releaseId",
  "datasetId",
  "manifestSha256",
] as const;

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BENCH_ID = /^[a-z][a-z0-9_]*$/;
const METRIC_KEY = /^[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(code: string, message: string): Result<T> {
  return fail(failure("permanent", code, message));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Every closed object in the JSON schema (`additionalProperties: false`) has
 * required == allowed, so the key set must match exactly in both directions.
 */
function checkKeys<T>(
  record: Record<string, unknown>,
  keys: readonly string[],
  where: string,
  codePrefix: string,
): Result<T> | null {
  for (const key of keys) {
    if (!(key in record)) {
      return invalid(`${codePrefix}_missing_key`, `${where}: missing required key "${key}"`);
    }
  }
  const allowed = new Set<string>(keys);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    return invalid(`${codePrefix}_unknown_key`, `${where}: unknown key "${extra[0]}"`);
  }
  return null;
}

function validateMetrics(raw: unknown, where: string): Result<Record<string, number | null>> {
  if (!isRecord(raw)) return invalid("metrics_not_object", `${where}: metrics must be an object`);
  const metrics: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!METRIC_KEY.test(key)) {
      return invalid("metric_key", `${where}: metric key "${key}" is not [A-Za-z0-9_.-]+`);
    }
    if (value !== null && !isFiniteNumber(value)) {
      return invalid(
        "metric_value",
        `${where}: metric "${key}" must be a finite number or null (got ${String(value)})`,
      );
    }
    metrics[key] = value;
  }
  return ok(metrics);
}

function validateStringRecord(raw: unknown, where: string): Result<Record<string, string>> {
  if (!isRecord(raw)) return invalid("labels_not_object", `${where}: must be an object`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      return invalid("label_value", `${where}: "${key}" must be a string`);
    }
    out[key] = value;
  }
  return ok(out);
}

function validateRelease(raw: unknown, where: string): Result<DatasetReleaseRef> {
  if (!isRecord(raw)) return invalid("release_not_object", `${where}: must be an object`);
  const keyError = checkKeys<DatasetReleaseRef>(raw, REQUIRED_RELEASE_KEYS, where, "release");
  if (keyError) return keyError;
  if (typeof raw.releaseDir !== "string" || raw.releaseDir.length === 0) {
    return invalid("release_dir", `${where}: releaseDir must be a non-empty string`);
  }
  if (typeof raw.releaseId !== "string" || raw.releaseId.length === 0) {
    return invalid("release_id", `${where}: releaseId must be a non-empty string`);
  }
  if (raw.datasetId !== null && typeof raw.datasetId !== "string") {
    return invalid("release_dataset_id", `${where}: datasetId must be a string or null`);
  }
  if (typeof raw.manifestSha256 !== "string" || !SHA256.test(raw.manifestSha256)) {
    return invalid("release_sha", `${where}: manifestSha256 must be 64 lowercase hex chars`);
  }
  return ok({
    releaseDir: raw.releaseDir,
    releaseId: raw.releaseId,
    datasetId: raw.datasetId,
    manifestSha256: raw.manifestSha256,
  });
}

function validateProvenance(raw: unknown): Result<RegressionProvenance> {
  const where = "provenance";
  if (!isRecord(raw)) return invalid("provenance_not_object", `${where}: must be an object`);
  const keyError = checkKeys<RegressionProvenance>(
    raw,
    REQUIRED_PROVENANCE_KEYS,
    where,
    "provenance",
  );
  if (keyError) return keyError;
  if (typeof raw.gitSha !== "string" || !GIT_SHA.test(raw.gitSha)) {
    return invalid("provenance_git_sha", `${where}.gitSha must be a 40-char lowercase hex sha`);
  }
  if (raw.gitBranch !== null && typeof raw.gitBranch !== "string") {
    return invalid("provenance_git_branch", `${where}.gitBranch must be a string or null`);
  }
  if (typeof raw.gitDirty !== "boolean") {
    return invalid("provenance_git_dirty", `${where}.gitDirty must be a boolean`);
  }
  if (typeof raw.datasetsTreeSha !== "string" || !GIT_SHA.test(raw.datasetsTreeSha)) {
    return invalid(
      "provenance_datasets_tree",
      `${where}.datasetsTreeSha must be a 40-char lowercase hex sha`,
    );
  }
  if (!Array.isArray(raw.datasetReleases)) {
    return invalid("provenance_releases", `${where}.datasetReleases must be an array`);
  }
  const releases: DatasetReleaseRef[] = [];
  const seenDirs = new Set<string>();
  for (const [index, entry] of raw.datasetReleases.entries()) {
    const release = validateRelease(entry, `${where}.datasetReleases[${index}]`);
    if (!release.ok) return release;
    if (seenDirs.has(release.value.releaseDir)) {
      return invalid(
        "provenance_release_duplicate",
        `${where}.datasetReleases: duplicate releaseDir "${release.value.releaseDir}"`,
      );
    }
    seenDirs.add(release.value.releaseDir);
    releases.push(release.value);
  }
  const modelVersions = validateStringRecord(raw.modelVersions, `${where}.modelVersions`);
  if (!modelVersions.ok) return modelVersions;
  if (
    typeof raw.evidenceClass !== "string" ||
    !(REGRESSION_EVIDENCE_CLASSES as readonly string[]).includes(raw.evidenceClass)
  ) {
    return invalid(
      "provenance_evidence_class",
      `${where}.evidenceClass must be one of ${REGRESSION_EVIDENCE_CLASSES.join(", ")}`,
    );
  }
  return ok({
    gitSha: raw.gitSha,
    gitBranch: raw.gitBranch,
    gitDirty: raw.gitDirty,
    datasetsTreeSha: raw.datasetsTreeSha,
    datasetReleases: releases,
    modelVersions: modelVersions.value,
    evidenceClass: raw.evidenceClass as RegressionEvidenceClass,
  });
}

function validateRunner(raw: unknown): Result<RegressionRunner> {
  if (!isRecord(raw)) return invalid("runner_not_object", "runner: must be an object");
  const keyError = checkKeys<RegressionRunner>(raw, REQUIRED_RUNNER_KEYS, "runner", "runner");
  if (keyError) return keyError;
  for (const key of REQUIRED_RUNNER_KEYS) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      return invalid("runner_value", `runner.${key} must be a non-empty string`);
    }
  }
  return ok({
    node: raw.node as string,
    platform: raw.platform as string,
    arch: raw.arch as string,
  });
}

function validateBench(raw: unknown, index: number): Result<BenchRecord> {
  const where = `benches[${index}]`;
  if (!isRecord(raw)) return invalid("bench_not_object", `${where}: must be an object`);
  const keyError = checkKeys<BenchRecord>(raw, REQUIRED_BENCH_KEYS, where, "bench");
  if (keyError) return keyError;
  if (typeof raw.id !== "string" || !BENCH_ID.test(raw.id)) {
    return invalid("bench_id", `${where}.id must match ${BENCH_ID.source}`);
  }
  const at = `benches[${raw.id}]`;
  for (const key of ["title", "command", "cwd"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      return invalid("bench_string", `${at}.${key} must be a non-empty string`);
    }
  }
  if (typeof raw.kind !== "string" || !(BENCH_KINDS as readonly string[]).includes(raw.kind)) {
    return invalid("bench_kind", `${at}.kind must be one of ${BENCH_KINDS.join(", ")}`);
  }
  if (
    typeof raw.status !== "string" ||
    !(BENCH_STATUSES as readonly string[]).includes(raw.status)
  ) {
    return invalid("bench_status", `${at}.status must be one of ${BENCH_STATUSES.join(", ")}`);
  }
  if (raw.exitCode !== null && !Number.isInteger(raw.exitCode)) {
    return invalid("bench_exit_code", `${at}.exitCode must be an integer or null`);
  }
  if (raw.kind === "in_process" && raw.exitCode !== null) {
    return invalid("bench_exit_code", `${at}.exitCode must be null for in_process benches`);
  }
  if (raw.kind === "subprocess" && raw.exitCode === null) {
    return invalid("bench_exit_code", `${at}.exitCode is required for subprocess benches`);
  }
  if (!isNonNegativeInt(raw.wallClockMs)) {
    return invalid("bench_wall_clock", `${at}.wallClockMs must be a non-negative integer`);
  }
  if (!isStringArray(raw.inputs) || raw.inputs.length === 0) {
    return invalid("bench_inputs", `${at}.inputs must be a non-empty string array`);
  }
  if (!isStringArray(raw.caveats)) {
    return invalid("bench_caveats", `${at}.caveats must be a string array`);
  }
  if (raw.error !== null && typeof raw.error !== "string") {
    return invalid("bench_error", `${at}.error must be a string or null`);
  }
  if (raw.status === "failed" && typeof raw.error !== "string") {
    return invalid("bench_error", `${at}: failed benches must carry an error string`);
  }
  if (raw.status === "ok" && raw.error !== null) {
    return invalid("bench_error", `${at}: ok benches must have error === null`);
  }
  const metrics = validateMetrics(raw.metrics, at);
  if (!metrics.ok) return metrics;
  if (raw.status === "failed" && Object.keys(metrics.value).length > 0) {
    return invalid("bench_failed_metrics", `${at}: failed benches must not report metrics`);
  }
  const labels = validateStringRecord(raw.labels, `${at}.labels`);
  if (!labels.ok) return labels;
  return ok({
    id: raw.id,
    title: raw.title as string,
    kind: raw.kind as BenchKind,
    command: raw.command as string,
    cwd: raw.cwd as string,
    status: raw.status as BenchStatus,
    exitCode: raw.exitCode as number | null,
    wallClockMs: raw.wallClockMs,
    inputs: raw.inputs,
    caveats: raw.caveats,
    error: raw.error as string | null,
    metrics: metrics.value,
    labels: labels.value,
  });
}

/** Flattened `${benchId}.${metric}` view — the only derivation of `summary.metrics`. */
export function flattenBenchMetrics(
  benches: readonly BenchRecord[],
): Record<string, number | null> {
  const flat: Record<string, number | null> = {};
  for (const bench of benches) {
    for (const [key, value] of Object.entries(bench.metrics)) {
      flat[`${bench.id}.${key}`] = value;
    }
  }
  return flat;
}

export function validateRegressionSummary(raw: unknown): Result<RegressionSummary> {
  if (!isRecord(raw)) return invalid("summary_not_object", "summary must be a JSON object");
  const keyError = checkKeys<RegressionSummary>(raw, REQUIRED_SUMMARY_KEYS, "summary", "summary");
  if (keyError) return keyError;
  if (raw.schemaVersion !== REGRESSION_SUMMARY_SCHEMA_VERSION) {
    return invalid(
      "summary_schema_version",
      `summary.schemaVersion must be ${REGRESSION_SUMMARY_SCHEMA_VERSION} (got ${String(raw.schemaVersion)})`,
    );
  }
  if (raw.contract !== REGRESSION_CONTRACT_ID) {
    return invalid(
      "summary_contract",
      `summary.contract must be "${REGRESSION_CONTRACT_ID}" (got ${String(raw.contract)})`,
    );
  }
  if (!Number.isInteger(raw.contractVersion) || (raw.contractVersion as number) < 1) {
    return invalid(
      "summary_contract_version",
      "summary.contractVersion must be a positive integer",
    );
  }
  if (typeof raw.runId !== "string" || raw.runId.length === 0) {
    return invalid("summary_run_id", "summary.runId must be a non-empty string");
  }
  if (typeof raw.generatedAtIso !== "string" || Number.isNaN(Date.parse(raw.generatedAtIso))) {
    return invalid("summary_generated_at", "summary.generatedAtIso must be an ISO-8601 timestamp");
  }
  const runner = validateRunner(raw.runner);
  if (!runner.ok) return runner;
  const provenance = validateProvenance(raw.provenance);
  if (!provenance.ok) return provenance;
  if (!Array.isArray(raw.benches)) {
    return invalid("summary_benches", "summary.benches must be an array");
  }
  if (raw.benches.length === 0) {
    return invalid("summary_benches_empty", "summary.benches must contain at least one bench");
  }
  const benches: BenchRecord[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.benches.entries()) {
    const bench = validateBench(entry, index);
    if (!bench.ok) return bench;
    if (ids.has(bench.value.id)) {
      return invalid(
        "summary_bench_duplicate",
        `summary.benches: duplicate id "${bench.value.id}"`,
      );
    }
    ids.add(bench.value.id);
    benches.push(bench.value);
  }
  const metrics = validateMetrics(raw.metrics, "summary");
  if (!metrics.ok) return metrics;
  const expected = flattenBenchMetrics(benches);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(metrics.value).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some(
      (key, index) => key !== actualKeys[index] || metrics.value[key] !== expected[key],
    )
  ) {
    return invalid(
      "summary_metrics_mismatch",
      "summary.metrics must equal the flattened `${bench.id}.${metric}` view of summary.benches",
    );
  }
  if (!isStringArray(raw.caveats)) {
    return invalid("summary_caveats", "summary.caveats must be a string array");
  }
  if (!isNonNegativeInt(raw.totalWallClockMs)) {
    return invalid("summary_wall_clock", "summary.totalWallClockMs must be a non-negative integer");
  }
  return ok({
    schemaVersion: REGRESSION_SUMMARY_SCHEMA_VERSION,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: raw.contractVersion as number,
    runId: raw.runId,
    generatedAtIso: raw.generatedAtIso,
    runner: runner.value,
    provenance: provenance.value,
    benches,
    metrics: metrics.value,
    caveats: raw.caveats,
    totalWallClockMs: raw.totalWallClockMs,
  });
}
