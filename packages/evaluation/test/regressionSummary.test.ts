import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GIT_SHA, bench, summary } from "./regressionFixtures.js";
import {
  BENCH_KINDS,
  BENCH_STATUSES,
  REGRESSION_CONTRACT_ID,
  REGRESSION_EVIDENCE_CLASSES,
  REGRESSION_SUMMARY_SCHEMA_VERSION,
  REQUIRED_BENCH_KEYS,
  REQUIRED_PROVENANCE_KEYS,
  REQUIRED_RELEASE_KEYS,
  REQUIRED_RUNNER_KEYS,
  REQUIRED_SUMMARY_KEYS,
  flattenBenchMetrics,
  validateRegressionSummary,
} from "../src/index.js";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Deep-clone then mutate one dotted path so each test states exactly what breaks. */
function withPath(doc: unknown, path: string, value: unknown): unknown {
  const clone: unknown = JSON.parse(JSON.stringify(doc));
  const parts = path.split(".");
  let cursor = clone as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  return clone;
}

function expectInvalid(doc: unknown, code: string): void {
  const result = validateRegressionSummary(doc);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe(code);
}

describe("validateRegressionSummary", () => {
  it("accepts a well-formed summary and returns a normalized copy", () => {
    const doc = summary();
    const result = validateRegressionSummary(JSON.parse(JSON.stringify(doc)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(doc);
  });

  it("rejects non-objects and missing top-level keys", () => {
    expectInvalid(null, "summary_not_object");
    expectInvalid([], "summary_not_object");
    for (const key of REQUIRED_SUMMARY_KEYS) {
      expectInvalid(withPath(summary(), key, undefined), "summary_missing_key");
    }
  });

  it("rejects unknown keys at every closed object level, like the JSON schema does", () => {
    expectInvalid(withPath(summary(), "extra", 1), "summary_unknown_key");
    expectInvalid(withPath(summary(), "runner.extra", "x"), "runner_unknown_key");
    expectInvalid(withPath(summary(), "provenance.extra", "x"), "provenance_unknown_key");
    expectInvalid(
      withPath(summary(), "provenance.datasetReleases.0.extra", "x"),
      "release_unknown_key",
    );
    expectInvalid(withPath(summary(), "benches.0.extra", "x"), "bench_unknown_key");
  });

  it("rejects wrong schema version and contract identity", () => {
    expectInvalid(withPath(summary(), "schemaVersion", 2), "summary_schema_version");
    expectInvalid(withPath(summary(), "contract", "mac-bench"), "summary_contract");
    expectInvalid(withPath(summary(), "contractVersion", 0), "summary_contract_version");
    expectInvalid(withPath(summary(), "contractVersion", 1.5), "summary_contract_version");
    expectInvalid(withPath(summary(), "generatedAtIso", "yesterday"), "summary_generated_at");
    expectInvalid(withPath(summary(), "runId", ""), "summary_run_id");
  });

  it("rejects missing or malformed provenance", () => {
    expectInvalid(withPath(summary(), "provenance", undefined), "summary_missing_key");
    expectInvalid(withPath(summary(), "provenance", "7c034aa"), "provenance_not_object");
    for (const key of REQUIRED_PROVENANCE_KEYS) {
      expectInvalid(withPath(summary(), `provenance.${key}`, undefined), "provenance_missing_key");
    }
    expectInvalid(withPath(summary(), "provenance.gitSha", "7c034aa"), "provenance_git_sha");
    expectInvalid(
      withPath(summary(), "provenance.gitSha", GIT_SHA.toUpperCase()),
      "provenance_git_sha",
    );
    expectInvalid(withPath(summary(), "provenance.gitBranch", 7), "provenance_git_branch");
    expectInvalid(withPath(summary(), "provenance.gitDirty", "no"), "provenance_git_dirty");
    expectInvalid(
      withPath(summary(), "provenance.datasetsTreeSha", "abc"),
      "provenance_datasets_tree",
    );
    expectInvalid(withPath(summary(), "provenance.datasetReleases", {}), "provenance_releases");
    expectInvalid(withPath(summary(), "provenance.modelVersions", { x: 1 }), "label_value");
    expectInvalid(
      withPath(summary(), "provenance.evidenceClass", "mac_device"),
      "provenance_evidence_class",
    );
  });

  it("rejects malformed dataset release references", () => {
    const base = summary();
    for (const key of REQUIRED_RELEASE_KEYS) {
      expectInvalid(
        withPath(base, `provenance.datasetReleases.0.${key}`, undefined),
        "release_missing_key",
      );
    }
    expectInvalid(withPath(base, "provenance.datasetReleases.0.releaseId", ""), "release_id");
    expectInvalid(
      withPath(base, "provenance.datasetReleases.0.datasetId", 3),
      "release_dataset_id",
    );
    expectInvalid(
      withPath(base, "provenance.datasetReleases.0.manifestSha256", GIT_SHA),
      "release_sha",
    );
    const dup = summary();
    dup.provenance.datasetReleases.push({ ...dup.provenance.datasetReleases[0]! });
    expectInvalid(dup, "provenance_release_duplicate");
  });

  it("rejects malformed runner", () => {
    for (const key of REQUIRED_RUNNER_KEYS) {
      expectInvalid(withPath(summary(), `runner.${key}`, undefined), "runner_missing_key");
      expectInvalid(withPath(summary(), `runner.${key}`, ""), "runner_value");
    }
  });

  it("rejects malformed bench records", () => {
    expectInvalid(withPath(summary(), "benches", []), "summary_benches_empty");
    expectInvalid(withPath(summary(), "benches", {}), "summary_benches");
    for (const key of REQUIRED_BENCH_KEYS) {
      expectInvalid(withPath(summary(), `benches.0.${key}`, undefined), "bench_missing_key");
    }
    expectInvalid(withPath(summary(), "benches.0.id", "Contact Replay"), "bench_id");
    expectInvalid(withPath(summary(), "benches.0.kind", "mac"), "bench_kind");
    expectInvalid(withPath(summary(), "benches.0.status", "skipped"), "bench_status");
    expectInvalid(withPath(summary(), "benches.0.wallClockMs", -1), "bench_wall_clock");
    expectInvalid(withPath(summary(), "benches.0.wallClockMs", 1.5), "bench_wall_clock");
    expectInvalid(withPath(summary(), "benches.0.inputs", []), "bench_inputs");
    expectInvalid(withPath(summary(), "benches.0.metrics.estimated", "7"), "metric_value");
    expectInvalid(withPath(summary(), "benches.0.metrics.estimated", Number.NaN), "metric_value");
    expectInvalid(withPath(summary(), "benches.0.metrics.bad key", 1), "metric_key");
    expectInvalid(withPath(summary(), "benches.0.labels.estimatorVersion", 4), "label_value");
    expect(BENCH_KINDS).toEqual(["in_process", "subprocess"]);
    expect(BENCH_STATUSES).toEqual(["ok", "failed"]);
    expect(REGRESSION_EVIDENCE_CLASSES).toEqual(["linux_replay_proxy"]);
  });

  it("ties exitCode to bench kind and error to bench status", () => {
    expectInvalid(withPath(summary(), "benches.0.exitCode", 0), "bench_exit_code");
    const sub = summary({}, [bench({ kind: "subprocess", exitCode: 0, command: "tsx x.ts" })]);
    expect(validateRegressionSummary(sub).ok).toBe(true);
    expectInvalid(withPath(sub, "benches.0.exitCode", null), "bench_exit_code");
    expectInvalid(withPath(summary(), "benches.0.error", "boom"), "bench_error");
    const failed = bench({ status: "failed", error: "gold file missing", metrics: {} });
    expect(validateRegressionSummary(summary({}, [failed])).ok).toBe(true);
    expectInvalid(
      summary({}, [bench({ status: "failed", error: null, metrics: {} })]),
      "bench_error",
    );
    expectInvalid(
      summary({}, [bench({ status: "failed", error: "x", metrics: { estimated: 1 } })]),
      "bench_failed_metrics",
    );
  });

  it("rejects duplicate bench ids and a flattened metric view that disagrees", () => {
    expectInvalid(summary({}, [bench(), bench()]), "summary_bench_duplicate");
    const withFlat = (metrics: Record<string, number | null>) => ({ ...summary(), metrics });
    const flat = summary().metrics;
    expectInvalid(withFlat({ ...flat, "contact_replay.estimated": 8 }), "summary_metrics_mismatch");
    expectInvalid(withFlat({ ...flat, "contact_replay.extra": 1 }), "summary_metrics_mismatch");
    const { "contact_replay.estimated": _dropped, ...withoutEstimated } = flat;
    expectInvalid(withFlat(withoutEstimated), "summary_metrics_mismatch");
    // null must stay null — a zero in the flattened view is a mismatch, not a rounding.
    expectInvalid(
      withFlat({ ...flat, "contact_replay.p90_error_ms": 0 }),
      "summary_metrics_mismatch",
    );
  });

  it("flattens metrics as <benchId>.<metric> and preserves nulls", () => {
    const flat = flattenBenchMetrics([
      bench(),
      bench({ id: "coach_gates", metrics: { gates_pass: 3, gates_fail: 0 } }),
    ]);
    expect(flat).toEqual({
      "contact_replay.target_events": 10,
      "contact_replay.estimated": 7,
      "contact_replay.median_error_ms": 27,
      "contact_replay.p90_error_ms": null,
      "coach_gates.gates_pass": 3,
      "coach_gates.gates_fail": 0,
    });
  });
});

describe("committed JSON schema stays in lock-step with the validator", () => {
  const schema = JSON.parse(
    readFileSync(join(PACKAGE_DIR, "regression.summary.schema.json"), "utf8"),
  ) as {
    required: string[];
    properties: Record<
      string,
      {
        const?: unknown;
        enum?: unknown[];
        required?: string[];
        properties?: Record<string, unknown>;
        items?: { required?: string[]; properties?: Record<string, { enum?: unknown[] }> };
      }
    >;
  };

  it("declares the same required keys and enumerations", () => {
    expect([...schema.required].sort()).toEqual([...REQUIRED_SUMMARY_KEYS].sort());
    expect(schema.properties.schemaVersion!.const).toBe(REGRESSION_SUMMARY_SCHEMA_VERSION);
    expect(schema.properties.contract!.const).toBe(REGRESSION_CONTRACT_ID);
    expect([...schema.properties.runner!.required!].sort()).toEqual(
      [...REQUIRED_RUNNER_KEYS].sort(),
    );
    expect([...schema.properties.provenance!.required!].sort()).toEqual(
      [...REQUIRED_PROVENANCE_KEYS].sort(),
    );
    const provenanceProps = schema.properties.provenance!.properties as Record<
      string,
      { enum?: unknown[]; items?: { required?: string[] } }
    >;
    expect(provenanceProps.evidenceClass!.enum).toEqual([...REGRESSION_EVIDENCE_CLASSES]);
    expect([...provenanceProps.datasetReleases!.items!.required!].sort()).toEqual(
      [...REQUIRED_RELEASE_KEYS].sort(),
    );
    const benchItem = schema.properties.benches!.items!;
    expect([...benchItem.required!].sort()).toEqual([...REQUIRED_BENCH_KEYS].sort());
    expect(benchItem.properties!.kind!.enum).toEqual([...BENCH_KINDS]);
    expect(benchItem.properties!.status!.enum).toEqual([...BENCH_STATUSES]);
  });
});
