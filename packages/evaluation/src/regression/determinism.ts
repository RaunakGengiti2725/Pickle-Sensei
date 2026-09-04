import { createHash } from "node:crypto";
import type { BenchRecord, RegressionSummary } from "./summarySchema.js";

/**
 * Run-to-run determinism analysis for `bench:regression` summaries.
 *
 * Given N summaries produced on the same commit, everything except the
 * volatile fields (`runId`, `generatedAtIso`, `totalWallClockMs`,
 * `benches[].wallClockMs`) must be byte-identical. Any other difference —
 * a metric, a label, a bench status, an error text, provenance — is
 * nondeterminism and is reported with the value observed in every run.
 * Wall-clock fields are never compared for equality; they are summarised
 * as a timing matrix (min / median / max / spread) instead.
 */

export const DETERMINISM_REPORT_SCHEMA_VERSION = 1 as const;

/** Fields that legitimately differ between runs of the same commit. */
export const VOLATILE_SUMMARY_FIELDS = ["runId", "generatedAtIso", "totalWallClockMs"] as const;
export const VOLATILE_BENCH_FIELDS = ["wallClockMs"] as const;

export interface RunResourceUsage {
  /** Peak resident set size of the process that ran the benches, in kB. */
  maxRssKb: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  userCpuMs: number;
  systemCpuMs: number;
}

export interface DeterminismRunInput {
  /** Caller-chosen label (e.g. "rep1"); unique per run. */
  label: string;
  summary: RegressionSummary;
  /** Wall time of the whole `bench:regression` invocation as seen by the
   *  caller (process spawn to exit), or null when run in-process. */
  outerWallMs: number | null;
  rusage: RunResourceUsage | null;
  /** Untracked files under `datasets/` that appeared while this run
   *  executed and were still there afterwards — the runner promises to
   *  leave only its summary behind. */
  leakedDatasetFiles: string[];
}

export type DifferenceKind =
  | "contract"
  | "runner"
  | "provenance"
  | "caveats"
  | "bench_set"
  | "bench_field"
  | "bench_metric"
  | "bench_label"
  | "flat_metric"
  | "leaked_files";

export interface Difference {
  kind: DifferenceKind;
  /** JSON-pointer-ish path of the differing value. */
  path: string;
  /** Canonical rendering of the value in each run, in input order. */
  values: string[];
}

export interface MetricMatrixRow {
  metric: string;
  /** One entry per run; `undefined` = the metric was absent in that run. */
  values: (number | null | undefined)[];
  deterministic: boolean;
}

export interface TimingRow {
  name: string;
  unit: "ms" | "kB";
  values: number[];
  min: number;
  max: number;
  median: number;
  mean: number;
  /** max - min, in `unit`. */
  spread: number;
  /** spread / median, or null when the median is 0. */
  spreadRatio: number | null;
}

export interface DeterminismRunDigest {
  label: string;
  runId: string;
  generatedAtIso: string;
  totalWallClockMs: number;
  outerWallMs: number | null;
  rusage: RunResourceUsage | null;
  failedBenches: string[];
  leakedDatasetFiles: string[];
  /** sha256 over the canonical stable view of the summary. */
  stableSha256: string;
}

export interface DeterminismReport {
  schemaVersion: typeof DETERMINISM_REPORT_SCHEMA_VERSION;
  runs: DeterminismRunDigest[];
  /** True iff every stable view is identical and nothing leaked. */
  deterministic: boolean;
  /** True iff every bench in every run has status "ok". */
  allBenchesOk: boolean;
  differences: Difference[];
  nondeterministicMetrics: string[];
  metricMatrix: MetricMatrixRow[];
  timing: {
    benches: TimingRow[];
    totalWallClockMs: TimingRow;
    outerWallMs: TimingRow | null;
    maxRssKb: TimingRow | null;
  };
  replay: {
    gitSha: string;
    gitDirty: boolean;
    datasetsTreeSha: string;
    node: string;
    benchIds: string[];
    command: string;
  } | null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON with object keys sorted at every depth; `-0` and `NaN` are made
 *  visible ("-0", "NaN") instead of collapsing onto 0 / null as
 *  `JSON.stringify` would. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (Object.is(value, -0)) return "-0";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return String(value);
}

/** Everything in a summary that must not change between runs of one commit. */
export function stableView(summary: RegressionSummary): Record<string, unknown> {
  const volatileSummary = new Set<string>(VOLATILE_SUMMARY_FIELDS);
  const volatileBench = new Set<string>(VOLATILE_BENCH_FIELDS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (volatileSummary.has(key)) continue;
    if (key === "benches") {
      out.benches = summary.benches.map((bench) => {
        const stable: Record<string, unknown> = {};
        for (const [field, fieldValue] of Object.entries(bench)) {
          if (!volatileBench.has(field)) stable[field] = fieldValue;
        }
        return stable;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function stableSha256(summary: RegressionSummary): string {
  return createHash("sha256")
    .update(canonicalJson(stableView(summary)))
    .digest("hex");
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function timingRow(name: string, values: number[], unit: TimingRow["unit"] = "ms"): TimingRow {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const mean = values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
  const spread = max - min;
  return {
    name,
    unit,
    values,
    min,
    max,
    median,
    mean: Math.round(mean * 100) / 100,
    spread,
    spreadRatio: median === 0 ? null : Math.round((spread / median) * 10000) / 10000,
  };
}

const BENCH_STABLE_FIELDS: (keyof BenchRecord)[] = [
  "title",
  "kind",
  "command",
  "cwd",
  "status",
  "exitCode",
  "inputs",
  "caveats",
  "error",
];

/**
 * Compare N (>= 2) runs of the same commit. Differences are reported against
 * every run (values in input order) so a single flaky run is visible as such.
 */
export function analyzeDeterminism(runs: DeterminismRunInput[]): DeterminismReport {
  if (runs.length < 2) throw new Error(`determinism analysis needs >= 2 runs, got ${runs.length}`);
  const labels = new Set(runs.map((run) => run.label));
  if (labels.size !== runs.length) throw new Error("run labels must be unique");

  const differences: Difference[] = [];
  const push = (kind: DifferenceKind, path: string, values: unknown[]) => {
    const first = values[0];
    if (values.every((value) => sameValue(value, first))) return;
    differences.push({ kind, path, values: values.map((value) => canonicalJson(value)) });
  };

  const summaries = runs.map((run) => run.summary);
  for (const field of ["schemaVersion", "contract", "contractVersion"] as const) {
    push(
      "contract",
      field,
      summaries.map((summary) => summary[field]),
    );
  }
  for (const field of ["node", "platform", "arch"] as const) {
    push(
      "runner",
      `runner.${field}`,
      summaries.map((summary) => summary.runner[field]),
    );
  }
  for (const field of [
    "gitSha",
    "gitBranch",
    "gitDirty",
    "datasetsTreeSha",
    "datasetReleases",
    "modelVersions",
    "evidenceClass",
  ] as const) {
    push(
      "provenance",
      `provenance.${field}`,
      summaries.map((summary) => summary.provenance[field]),
    );
  }
  push(
    "caveats",
    "caveats",
    summaries.map((summary) => summary.caveats),
  );

  // Bench set + order must agree before per-bench fields are compared.
  const benchIdLists = summaries.map((summary) => summary.benches.map((bench) => bench.id));
  push("bench_set", "benches[].id", benchIdLists);
  const commonIds = benchIdLists[0]!.filter((id) => benchIdLists.every((ids) => ids.includes(id)));
  for (const id of commonIds) {
    const records = summaries.map((summary) => summary.benches.find((bench) => bench.id === id)!);
    for (const field of BENCH_STABLE_FIELDS) {
      push(
        "bench_field",
        `benches[${id}].${field}`,
        records.map((record) => record[field]),
      );
    }
    const metricKeys = new Set(records.flatMap((record) => Object.keys(record.metrics)));
    for (const key of [...metricKeys].sort()) {
      push(
        "bench_metric",
        `benches[${id}].metrics.${key}`,
        records.map((record) => record.metrics[key]),
      );
    }
    const labelKeys = new Set(records.flatMap((record) => Object.keys(record.labels)));
    for (const key of [...labelKeys].sort()) {
      push(
        "bench_label",
        `benches[${id}].labels.${key}`,
        records.map((record) => record.labels[key]),
      );
    }
  }

  const flatKeys = [
    ...new Set(summaries.flatMap((summary) => Object.keys(summary.metrics))),
  ].sort();
  const metricMatrix: MetricMatrixRow[] = flatKeys.map((metric) => {
    const values = summaries.map((summary) => summary.metrics[metric]);
    const deterministic = values.every((value) => sameValue(value, values[0]));
    if (!deterministic) {
      differences.push({
        kind: "flat_metric",
        path: `metrics.${metric}`,
        values: values.map((value) => canonicalJson(value)),
      });
    }
    return { metric, values, deterministic };
  });
  const nondeterministicMetrics = metricMatrix
    .filter((row) => !row.deterministic)
    .map((row) => row.metric);

  if (runs.some((run) => run.leakedDatasetFiles.length > 0)) {
    differences.push({
      kind: "leaked_files",
      path: "leakedDatasetFiles",
      values: runs.map((run) => canonicalJson(run.leakedDatasetFiles)),
    });
  }

  const benchTiming = commonIds.map((id) =>
    timingRow(
      id,
      summaries.map((summary) => summary.benches.find((bench) => bench.id === id)!.wallClockMs),
    ),
  );
  const outer = runs.map((run) => run.outerWallMs);
  const rss = runs.map((run) => run.rusage?.maxRssKb ?? null);
  const allNumbers = (values: (number | null)[]): values is number[] =>
    values.every((value) => typeof value === "number");

  const digests: DeterminismRunDigest[] = runs.map((run) => ({
    label: run.label,
    runId: run.summary.runId,
    generatedAtIso: run.summary.generatedAtIso,
    totalWallClockMs: run.summary.totalWallClockMs,
    outerWallMs: run.outerWallMs,
    rusage: run.rusage,
    failedBenches: run.summary.benches
      .filter((bench) => bench.status === "failed")
      .map((bench) => bench.id),
    leakedDatasetFiles: run.leakedDatasetFiles,
    stableSha256: stableSha256(run.summary),
  }));

  const first = summaries[0]!;
  return {
    schemaVersion: DETERMINISM_REPORT_SCHEMA_VERSION,
    runs: digests,
    deterministic: differences.length === 0,
    allBenchesOk: digests.every((digest) => digest.failedBenches.length === 0),
    differences,
    nondeterministicMetrics,
    metricMatrix,
    timing: {
      benches: benchTiming,
      totalWallClockMs: timingRow(
        "totalWallClockMs",
        summaries.map((summary) => summary.totalWallClockMs),
      ),
      outerWallMs: allNumbers(outer) ? timingRow("outerWallMs", outer) : null,
      maxRssKb: allNumbers(rss) ? timingRow("maxRssKb", rss, "kB") : null,
    },
    replay: {
      gitSha: first.provenance.gitSha,
      gitDirty: first.provenance.gitDirty,
      datasetsTreeSha: first.provenance.datasetsTreeSha,
      node: first.runner.node,
      benchIds: benchIdLists[0]!,
      command: replayCommand(first),
    },
  };
}

/** The exact command that reproduces one of the analysed runs. */
export function replayCommand(summary: RegressionSummary): string {
  const ids = summary.benches.map((bench) => bench.id);
  const only = summary.caveats.some((caveat) => caveat.startsWith("Partial run:"))
    ? ` --only ${ids.join(",")}`
    : "";
  return `git checkout ${summary.provenance.gitSha} && pnpm --filter @pickle/evaluation bench:regression --out-dir <dir> --run-id <id>${only}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function formatTimingRow(row: TimingRow): string {
  const ratio = row.spreadRatio === null ? "n/a" : `${(row.spreadRatio * 100).toFixed(1)}%`;
  return `  ${pad(row.name, 22)} ${row.values.map((v) => String(v).padStart(7)).join("")}   min ${String(row.min).padStart(6)}  med ${String(row.median).padStart(8)}  max ${String(row.max).padStart(6)}  spread ${String(row.spread).padStart(5)}${row.unit} (${ratio})`;
}

export function formatDeterminismReport(report: DeterminismReport): string {
  const lines: string[] = [];
  lines.push(
    `determinism: ${report.deterministic ? "IDENTICAL" : "DIFFERENT"} across ${report.runs.length} runs; benches ${
      report.allBenchesOk
        ? "all ok"
        : "FAILED in " +
          report.runs
            .filter((r) => r.failedBenches.length > 0)
            .map((r) => `${r.label}(${r.failedBenches.join(",")})`)
            .join(" ")
    }`,
  );
  if (report.replay) {
    lines.push(
      `commit ${report.replay.gitSha}${report.replay.gitDirty ? " (dirty)" : ""}  datasets ${report.replay.datasetsTreeSha.slice(0, 12)}  node ${report.replay.node}`,
    );
    lines.push(`replay: ${report.replay.command}`);
  }
  lines.push("runs:");
  for (const run of report.runs) {
    lines.push(
      `  ${pad(run.label, 10)} ${run.runId}  stable sha256 ${run.stableSha256.slice(0, 16)}  total ${run.totalWallClockMs}ms${run.outerWallMs === null ? "" : `  outer ${run.outerWallMs}ms`}${run.rusage ? `  maxRSS ${run.rusage.maxRssKb}kB` : ""}${run.leakedDatasetFiles.length > 0 ? `  LEAKED ${run.leakedDatasetFiles.length} file(s)` : ""}`,
    );
  }
  lines.push(
    `metrics: ${report.metricMatrix.length} flattened, ${report.nondeterministicMetrics.length} nondeterministic`,
  );
  if (report.differences.length > 0) {
    lines.push(`differences (${report.differences.length}):`);
    for (const difference of report.differences) {
      lines.push(`  [${difference.kind}] ${difference.path}`);
      difference.values.forEach((value, index) => {
        lines.push(`      ${pad(report.runs[index]?.label ?? String(index), 10)} ${value}`);
      });
    }
  }
  lines.push(`timing (ms per run, then min/median/max/spread):`);
  for (const row of report.timing.benches) lines.push(formatTimingRow(row));
  lines.push(formatTimingRow(report.timing.totalWallClockMs));
  if (report.timing.outerWallMs) lines.push(formatTimingRow(report.timing.outerWallMs));
  if (report.timing.maxRssKb) lines.push(formatTimingRow(report.timing.maxRssKb));
  return lines.join("\n");
}
