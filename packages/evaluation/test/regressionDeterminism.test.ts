import { describe, expect, it } from "vitest";
import {
  VOLATILE_BENCH_FIELDS,
  VOLATILE_SUMMARY_FIELDS,
  analyzeDeterminism,
  canonicalJson,
  formatDeterminismReport,
  replayCommand,
  stableSha256,
  stableView,
  type DeterminismRunInput,
} from "../src/regression/determinism.js";
import { flattenBenchMetrics, type BenchRecord, type RegressionSummary } from "../src/index.js";
import { GIT_SHA, bench, summary } from "./regressionFixtures.js";

function run(
  label: string,
  overrides: Partial<RegressionSummary> = {},
  benches?: BenchRecord[],
  extra: Partial<Omit<DeterminismRunInput, "label" | "summary">> = {},
): DeterminismRunInput {
  return {
    label,
    summary: summary(overrides, benches),
    outerWallMs: null,
    rusage: null,
    leakedDatasetFiles: [],
    ...extra,
  };
}

function withMetrics(metrics: Record<string, number | null>): BenchRecord[] {
  return [bench({ metrics })];
}

describe("canonicalJson", () => {
  it("sorts keys at every depth so key order never counts as a difference", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
  });

  it("keeps -0, NaN and infinities visible instead of collapsing them", () => {
    expect(
      canonicalJson([0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
    ).toBe('[0,"-0","NaN","Infinity","-Infinity"]');
    expect(canonicalJson(0)).not.toBe(canonicalJson(-0));
  });

  it("maps undefined to null like JSON.stringify would for object values", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"a":null,"b":null}');
  });
});

describe("stableView / stableSha256", () => {
  it("strips exactly the documented volatile fields and nothing else", () => {
    const view = stableView(summary());
    for (const field of VOLATILE_SUMMARY_FIELDS) expect(view).not.toHaveProperty(field);
    const benches = view.benches as Record<string, unknown>[];
    for (const field of VOLATILE_BENCH_FIELDS) expect(benches[0]).not.toHaveProperty(field);
    expect(Object.keys(view).sort()).toEqual(
      Object.keys(summary())
        .filter((key) => !(VOLATILE_SUMMARY_FIELDS as readonly string[]).includes(key))
        .sort(),
    );
    expect(view.provenance).toEqual(summary().provenance);
    expect(view.metrics).toEqual(summary().metrics);
  });

  it("gives equal digests for runs that differ only in volatile fields", () => {
    const a = summary();
    const b = summary(
      { runId: "other", generatedAtIso: "2030-01-01T00:00:00.000Z", totalWallClockMs: 9999 },
      [bench({ wallClockMs: 999 })],
    );
    expect(stableSha256(a)).toBe(stableSha256(b));
  });

  it("changes the digest when a metric, label or provenance field changes", () => {
    const base = stableSha256(summary());
    expect(stableSha256(summary({}, withMetrics({ target_events: 11 })))).not.toBe(base);
    expect(stableSha256(summary({}, [bench({ labels: { estimatorVersion: "x" } })]))).not.toBe(
      base,
    );
    expect(
      stableSha256(summary({ provenance: { ...summary().provenance, gitDirty: true } })),
    ).not.toBe(base);
  });
});

describe("analyzeDeterminism", () => {
  it("rejects fewer than two runs and duplicate labels", () => {
    expect(() => analyzeDeterminism([run("a")])).toThrow(/>= 2 runs/);
    expect(() => analyzeDeterminism([run("a"), run("a")])).toThrow(/unique/);
  });

  it("reports identical runs as deterministic with a full metric matrix and timing rows", () => {
    const report = analyzeDeterminism([
      run("r1", { totalWallClockMs: 1000 }, [bench({ wallClockMs: 40 })], { outerWallMs: 1200 }),
      run("r2", { totalWallClockMs: 1100 }, [bench({ wallClockMs: 50 })], { outerWallMs: 1300 }),
      run("r3", { totalWallClockMs: 1050 }, [bench({ wallClockMs: 45 })], { outerWallMs: 1250 }),
    ]);
    expect(report.deterministic).toBe(true);
    expect(report.allBenchesOk).toBe(true);
    expect(report.differences).toEqual([]);
    expect(report.nondeterministicMetrics).toEqual([]);
    expect(report.metricMatrix.map((row) => row.metric)).toEqual(
      Object.keys(flattenBenchMetrics([bench()])).sort(),
    );
    expect(report.metricMatrix.every((row) => row.deterministic)).toBe(true);
    // null metrics are compared as values, not skipped
    const p90 = report.metricMatrix.find((row) => row.metric === "contact_replay.p90_error_ms");
    expect(p90?.values).toEqual([null, null, null]);
    expect(report.timing.totalWallClockMs).toMatchObject({
      values: [1000, 1100, 1050],
      min: 1000,
      max: 1100,
      median: 1050,
      spread: 100,
    });
    expect(report.timing.benches[0]).toMatchObject({
      name: "contact_replay",
      values: [40, 50, 45],
    });
    expect(report.timing.outerWallMs?.values).toEqual([1200, 1300, 1250]);
    expect(report.timing.maxRssKb).toBeNull();
    expect(report.runs.map((digest) => digest.stableSha256)).toEqual([
      stableSha256(summary()),
      stableSha256(summary()),
      stableSha256(summary()),
    ]);
    expect(report.replay).toMatchObject({
      gitSha: GIT_SHA,
      gitDirty: false,
      benchIds: ["contact_replay"],
    });
    expect(report.replay?.command).toBe(replayCommand(summary()));
  });

  it("flags a metric that differs in one of three runs, with the differing run identified", () => {
    const report = analyzeDeterminism([
      run("r1"),
      run(
        "r2",
        {},
        withMetrics({ target_events: 10, estimated: 8, median_error_ms: 27, p90_error_ms: null }),
      ),
      run("r3"),
    ]);
    expect(report.deterministic).toBe(false);
    expect(report.nondeterministicMetrics).toEqual(["contact_replay.estimated"]);
    const row = report.metricMatrix.find((r) => r.metric === "contact_replay.estimated");
    expect(row).toMatchObject({ values: [7, 8, 7], deterministic: false });
    const kinds = report.differences.map((d) => `${d.kind}:${d.path}`);
    expect(kinds).toContain("bench_metric:benches[contact_replay].metrics.estimated");
    expect(kinds).toContain("flat_metric:metrics.contact_replay.estimated");
  });

  it("treats null vs number and -0 vs 0 as differences", () => {
    const nullVsNumber = analyzeDeterminism([
      run("r1"),
      run(
        "r2",
        {},
        withMetrics({ target_events: 10, estimated: 7, median_error_ms: 27, p90_error_ms: 0 }),
      ),
    ]);
    expect(nullVsNumber.nondeterministicMetrics).toEqual(["contact_replay.p90_error_ms"]);

    const signedZero = analyzeDeterminism([
      run(
        "r1",
        {},
        withMetrics({ target_events: 10, estimated: 7, median_error_ms: 0, p90_error_ms: null }),
      ),
      run(
        "r2",
        {},
        withMetrics({ target_events: 10, estimated: 7, median_error_ms: -0, p90_error_ms: null }),
      ),
    ]);
    expect(signedZero.nondeterministicMetrics).toEqual(["contact_replay.median_error_ms"]);
  });

  it("flags label, provenance, runner and caveat drift even when metrics agree", () => {
    const report = analyzeDeterminism([
      run("r1"),
      run("r2", { runner: { node: "v20.20.2", platform: "linux", arch: "x64" } }),
      run("r3", {}, [bench({ labels: { estimatorVersion: "contact-evidence-4.5" } })]),
      run("r4", { provenance: { ...summary().provenance, gitDirty: true } }),
      run("r5", { caveats: ["proxy evidence", "extra"] }),
    ]);
    expect(report.deterministic).toBe(false);
    expect(report.nondeterministicMetrics).toEqual([]);
    const paths = report.differences.map((d) => `${d.kind}:${d.path}`).sort();
    expect(paths).toEqual(
      [
        "bench_label:benches[contact_replay].labels.estimatorVersion",
        "caveats:caveats",
        "provenance:provenance.gitDirty",
        "runner:runner.node",
      ].sort(),
    );
    const node = report.differences.find((d) => d.path === "runner.node");
    expect(node?.values).toEqual([
      '"v22.23.2"',
      '"v20.20.2"',
      '"v22.23.2"',
      '"v22.23.2"',
      '"v22.23.2"',
    ]);
  });

  it("flags a differing bench set and a bench that failed in one run", () => {
    const failed = bench({
      status: "failed",
      exitCode: 1,
      error: "boom",
      metrics: {},
    });
    const report = analyzeDeterminism([run("r1"), run("r2", {}, [failed])]);
    expect(report.deterministic).toBe(false);
    expect(report.allBenchesOk).toBe(false);
    expect(report.runs[1]?.failedBenches).toEqual(["contact_replay"]);
    // metrics present in r1 but absent in r2 show as undefined, not silently dropped
    const row = report.metricMatrix.find((r) => r.metric === "contact_replay.estimated");
    expect(row).toMatchObject({ values: [7, undefined], deterministic: false });

    const extraBench = bench({ id: "other_bench", title: "Other" });
    const setReport = analyzeDeterminism([run("r1"), run("r2", {}, [bench(), extraBench])]);
    expect(setReport.differences.map((d) => d.kind)).toContain("bench_set");
    expect(setReport.timing.benches.map((row) => row.name)).toEqual(["contact_replay"]);
  });

  it("treats leaked dataset files as nondeterminism even when summaries match", () => {
    const report = analyzeDeterminism([
      run("r1", {}, undefined, {
        leakedDatasetFiles: ["datasets/completion-bench/completion-1.json"],
      }),
      run("r2"),
    ]);
    expect(report.deterministic).toBe(false);
    expect(report.differences).toEqual([
      {
        kind: "leaked_files",
        path: "leakedDatasetFiles",
        values: ['["datasets/completion-bench/completion-1.json"]', "[]"],
      },
    ]);
  });

  it("carries resource usage into the report and timing matrix", () => {
    const rusage = {
      maxRssKb: 140000,
      heapUsedBytes: 1,
      heapTotalBytes: 2,
      rssBytes: 3,
      userCpuMs: 4,
      systemCpuMs: 5,
    };
    const report = analyzeDeterminism([
      run("r1", {}, undefined, { rusage }),
      run("r2", {}, undefined, { rusage: { ...rusage, maxRssKb: 150000 } }),
    ]);
    expect(report.timing.maxRssKb).toMatchObject({
      unit: "kB",
      values: [140000, 150000],
      spread: 10000,
    });
    expect(report.runs[0]?.rusage).toEqual(rusage);
  });
});

describe("formatDeterminismReport", () => {
  it("prints the verdict, digests, metric count and every difference", () => {
    const report = analyzeDeterminism([
      run("r1"),
      run(
        "r2",
        {},
        withMetrics({ target_events: 10, estimated: 8, median_error_ms: 27, p90_error_ms: null }),
      ),
    ]);
    const text = formatDeterminismReport(report);
    expect(text).toContain("DIFFERENT across 2 runs");
    expect(text).toContain("metrics: 4 flattened, 1 nondeterministic");
    expect(text).toContain("contact_replay.estimated");
    expect(text).toContain(GIT_SHA);
    expect(text).toContain("bench:regression");

    const ok = formatDeterminismReport(analyzeDeterminism([run("r1"), run("r2")]));
    expect(ok).toContain("IDENTICAL across 2 runs; benches all ok");
    expect(ok).not.toContain("differences (");
  });
});
