/**
 * Adversarial pass (pkg-evaluation-bench, pass 3) — schema + comparator attacks.
 *
 * Every candidate is a MUTATION of the committed baseline document
 * (datasets/reports/regression/baseline.json), i.e. a real summary the
 * validator once accepted, fed back to `validateRegressionSummary`,
 * `compareSummaries` and the `bench:compare` CLI. Nothing here fabricates a
 * measurement: metric values are only ever moved to prove a check fires.
 *
 * Convention: `it(...)` asserts behaviour that HELD. `it.fails(...)` asserts
 * the behaviour the comparator SHOULD have and is expected to fail today —
 * it documents a reproduced gap and turns red the moment the gap is fixed
 * (then drop the `.fails`).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TSX_BIN } from "../../src/regression/benches.js";
import { DEFAULT_TOLERANCES_PATH, loadTolerances, main } from "../../src/regression/cli.js";
import { compareSummaries, formatCompareReport } from "../../src/regression/compare.js";
import { executeBench } from "../../src/regression/run.js";
import {
  REGRESSION_EVIDENCE_CLASSES,
  validateRegressionSummary,
  type BenchRecord,
  type RegressionSummary,
} from "../../src/regression/summarySchema.js";

const BASELINE_PATH = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const CLI_PATH = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-attack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const tolerances = loadTolerances(join(REPO_ROOT, DEFAULT_TOLERANCES_PATH));

/** Deep copy of the committed baseline as plain JSON (typed loosely on purpose:
 *  attacks write values the schema forbids). */
type Json = Record<string, unknown>;
function baselineJson(): Json {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Json;
}
function baseline(): RegressionSummary {
  const validated = validateRegressionSummary(baselineJson());
  if (!validated.ok) throw new Error(validated.failure.message);
  return validated.value;
}
function benchesOf(doc: Json): Json[] {
  return doc.benches as Json[];
}
function benchOf(doc: Json, id: string): Json {
  const found = benchesOf(doc).find((b) => b.id === id);
  if (!found) throw new Error(`no bench ${id} in baseline`);
  return found;
}
function metricsOf(doc: Json): Record<string, unknown> {
  return doc.metrics as Record<string, unknown>;
}
function provenanceOf(doc: Json): Json {
  return doc.provenance as Json;
}
function rejectionOf(doc: unknown): { code: string; message: string } {
  const validated = validateRegressionSummary(doc);
  if (validated.ok) throw new Error("expected validation failure, document was accepted");
  return validated.failure;
}
function accepted(doc: unknown): RegressionSummary {
  const validated = validateRegressionSummary(doc);
  if (!validated.ok) throw new Error(`expected acceptance: ${validated.failure.message}`);
  return validated.value;
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}
/** Real `bench:compare` process (tsx cli.ts compare ...), timed. */
function cliCompare(candidatePath: string, extra: string[] = []): CliRun {
  const started = process.hrtime.bigint();
  const result = spawnSync(TSX_BIN, [CLI_PATH, "compare", BASELINE_PATH, candidatePath, ...extra], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
  };
}
function writeCandidate(name: string, doc: unknown): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

describe("S4 — flattened metrics must mirror the nested bench metrics", () => {
  it("rejects a candidate whose nested bench metric disagrees with summary.metrics (HELD)", () => {
    const doc = baselineJson();
    const bench = benchOf(doc, "coach_gates");
    const metrics = bench.metrics as Record<string, number | null>;
    const key = Object.keys(metrics)[0]!;
    metrics[key] = (metrics[key] ?? 0) + 1; // nested moves, flattened view stays
    const failure = rejectionOf(doc);
    expect(failure.code).toBe("summary_metrics_mismatch");
    expect(failure.message).toContain("summary.metrics must equal the flattened");

    const cli = cliCompare(writeCandidate("s4-nested-drift", doc));
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("summary.metrics must equal the flattened");
  });

  it("rejects an equal-cardinality key swap (extra nested key vs extra flattened key)", () => {
    const doc = baselineJson();
    (benchOf(doc, "coach_gates").metrics as Record<string, unknown>).extra_nested = 1;
    metricsOf(doc)["coach_gates.extra_flat"] = 1;
    expect(rejectionOf(doc).code).toBe("summary_metrics_mismatch");
  });

  it("rejects a flattened metric that exists in no bench, and a bench metric missing from the view", () => {
    const orphan = baselineJson();
    metricsOf(orphan)["ghost_bench.metric"] = 0;
    expect(rejectionOf(orphan).code).toBe("summary_metrics_mismatch");

    const missing = baselineJson();
    delete metricsOf(missing)["coach_gates.gates_total"];
    expect(rejectionOf(missing).code).toBe("summary_metrics_mismatch");
  });

  it("rejects null-vs-number disagreement between the two views (null is 'not measured', not 0)", () => {
    const doc = baselineJson();
    const bench = benchOf(doc, "coach_gates");
    const key = Object.keys(bench.metrics as Json)[0]!;
    (bench.metrics as Record<string, unknown>)[key] = null;
    expect(rejectionOf(doc).code).toBe("summary_metrics_mismatch");
  });

  it("rejects prototype-polluting metric keys in the nested view", () => {
    const doc = baselineJson();
    const bench = benchOf(doc, "coach_gates");
    // JSON.parse creates an own "__proto__" data property; a naive
    // flatten/compare that walks with `obj[key]` would read the prototype.
    const polluted = JSON.parse(
      `{"__proto__": 1, ${JSON.stringify(bench.metrics).slice(1)}`,
    ) as Record<string, unknown>;
    bench.metrics = polluted;
    metricsOf(doc)["coach_gates.__proto__"] = 1;
    const validated = validateRegressionSummary(doc);
    if (validated.ok) {
      // Accepted only if the key round-trips as data; then the comparator must see it too.
      const report = compareSummaries(baseline(), validated.value, tolerances);
      expect(report.metrics.some((m) => m.metric === "coach_gates.__proto__")).toBe(true);
    } else {
      expect(validated.failure.code).toMatch(/summary_metrics_mismatch|metric/);
    }
  });
});

describe("S5 — evidence class other than linux_replay_proxy cannot be compared", () => {
  it("only one evidence class exists, so the comparator's non-comparable path is unreachable through validated input", () => {
    expect([...REGRESSION_EVIDENCE_CLASSES]).toEqual(["linux_replay_proxy"]);
  });

  it.each([
    ["mac_device_truth"],
    ["linux_replay_proxy "],
    ["LINUX_REPLAY_PROXY"],
    [""],
    [null],
    [42],
    ["linux_replay_proxy\u0000"],
  ])("rejects evidenceClass %j at schema level and the CLI exits 2 (HELD)", (evidenceClass) => {
    const doc = baselineJson();
    provenanceOf(doc).evidenceClass = evidenceClass;
    const failure = rejectionOf(doc);
    expect(failure.message).toContain("provenance.evidenceClass must be one of linux_replay_proxy");

    const cli = cliCompare(writeCandidate(`s5-${String(evidenceClass).length}`, doc));
    expect(cli.status).toBe(2);
    expect(cli.stdout).toBe("");
  });

  it("rejects a Mac-derived document on the BASELINE side as well", () => {
    const doc = baselineJson();
    provenanceOf(doc).evidenceClass = "mac_device_truth";
    const macPath = writeCandidate("s5-mac-baseline", doc);
    const result = spawnSync(TSX_BIN, [CLI_PATH, "compare", macPath, BASELINE_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("provenance.evidenceClass");
  });

  it("would exit 3 (non-comparable) if two validated documents ever carried different classes", () => {
    // Bypass validation to exercise compareSummaries' own guard.
    const candidate = baseline();
    (candidate.provenance as { evidenceClass: string }).evidenceClass = "mac_device_truth";
    const report = compareSummaries(baseline(), candidate, tolerances);
    expect(report.comparable).toBe(false);
    expect(report.exitCode).toBe(3);
    expect(report.warnings[0]).toMatch(/^NON-COMPARABLE provenance\.evidenceClass/);
  });
});

describe("S6 — label strings are unbounded", () => {
  const MB = 1024 * 1024;

  it("accepts a 10 MB label and reports in well under a second (reproduced acceptance)", () => {
    const doc = baselineJson();
    (benchOf(doc, "coach_gates").labels as Record<string, string>).huge = "x".repeat(10 * MB);
    accepted(doc);
    const text = cliCompare(writeCandidate("s6-10mb", doc));
    const json = cliCompare(writeCandidate("s6-10mb-json", doc), ["--json"]);
    expect(text.status).toBe(0);
    expect(json.status).toBe(0);
    expect(text.ms).toBeLessThan(5_000);
    expect(json.ms).toBeLessThan(5_000);
    // The label is not echoed into either report, so the cost is parse/validate only.
    expect(text.stdout).not.toContain("xxxxxxxxxx");
    expect(json.stdout).not.toContain("xxxxxxxxxx");
    process.stdout.write(
      `S6 10MB label: text ${text.ms.toFixed(0)}ms (${text.stdout.length}B), json ${json.ms.toFixed(0)}ms (${json.stdout.length}B)\n`,
    );
  });

  it("accepts a 10 MB label KEY and control/ANSI characters in label values without echoing them", () => {
    const doc = baselineJson();
    const labels = benchOf(doc, "coach_gates").labels as Record<string, string>;
    labels["k".repeat(10 * MB)] = "v";
    labels.uni = "\u0000\u202e\ud83e\udd52\n\r\x1b[31mRED\x1b[0m";
    accepted(doc);
    const cli = cliCompare(writeCandidate("s6-key", doc));
    expect(cli.status).toBe(0);
    expect(cli.stdout).not.toContain("\x1b[31m");
  });

  it.fails("bounds label size — a 100 MB label is accepted today (gap, decision: bound it)", () => {
    const doc = baselineJson();
    (benchOf(doc, "coach_gates").labels as Record<string, string>).huge = "x".repeat(100 * MB);
    const validated = validateRegressionSummary(doc);
    expect(validated.ok).toBe(false);
  });
});

describe("S7 — an `ok` subprocess bench with a non-zero exit code", () => {
  it.each([137, 1, -1, 255, 2 ** 31])(
    "validator accepts status ok + exitCode %d (reproduced)",
    (exitCode) => {
      const doc = baselineJson();
      const sub = benchesOf(doc).find((b) => b.kind === "subprocess")!;
      sub.exitCode = exitCode;
      const value = accepted(doc);
      const report = compareSummaries(baseline(), value, tolerances);
      expect(report.exitCode).toBe(0);
      expect(report.warnings).toEqual([]);
      // The report has no bench exit-code column at all, so the anomaly is invisible.
      expect(formatCompareReport(baseline(), value, report)).not.toMatch(/exit ?code/i);
    },
  );

  it("executeBench itself emits ok + exitCode 137 when a bench swallows a killed subprocess", () => {
    const record = executeBench(
      {
        id: "fake_sub",
        title: "fake",
        kind: "subprocess",
        command: "tsx fake.ts",
        cwd: REPO_ROOT,
        inputs: ["none"],
        caveats: [],
        run: () => ({ metrics: { n: 1 }, labels: {} }),
      },
      () => 137,
    );
    expect(record.status).toBe("ok");
    expect(record.exitCode).toBe(137);
    const doc = baselineJson();
    doc.benches = [record as unknown as Json];
    doc.metrics = { "fake_sub.n": 1 };
    accepted(doc);
  });

  it("accepts a failed subprocess bench that reports exitCode 0 (same inconsistency, other direction)", () => {
    const doc = baselineJson();
    const sub = benchesOf(doc).find((b) => b.kind === "subprocess")!;
    sub.status = "failed";
    sub.error = "boom";
    sub.metrics = {};
    sub.labels = {};
    sub.exitCode = 0;
    for (const key of Object.keys(metricsOf(doc))) {
      if (key.startsWith(`${String(sub.id)}.`)) delete metricsOf(doc)[key];
    }
    accepted(doc);
  });

  it.fails("rejects ok + non-zero exitCode (decision: it should — 137 means SIGKILL)", () => {
    const doc = baselineJson();
    benchesOf(doc).find((b) => b.kind === "subprocess")!.exitCode = 137;
    expect(validateRegressionSummary(doc).ok).toBe(false);
  });
});

describe("extra — non-numeric drift the comparator never reports", () => {
  it.fails(
    "bench labels (gate verdict, frozen spec sha, classifier version) drift silently",
    () => {
      const candidate = baseline();
      const coach = candidate.benches.find((b) => b.id === "coach_gates") as BenchRecord;
      expect(coach.labels.overallVerdict).toBeDefined();
      coach.labels.overallVerdict = "RELEASE_OK";
      coach.labels.specSha256 = "0".repeat(64);
      const stroke = candidate.benches.find((b) => b.id === "stroke_heuristic") as BenchRecord;
      stroke.labels.classifierVersion = "totally-different-classifier";
      const report = compareSummaries(baseline(), candidate, tolerances);
      const text = formatCompareReport(baseline(), candidate, report);
      // Should surface as an identity difference / warning; today: nothing.
      expect(
        report.warnings.length + report.identityDifferences.length > 0 ||
          /RELEASE_OK|totally-different/.test(text),
      ).toBe(true);
    },
  );

  it.fails(
    "bench command/cwd/inputs drift (a different function measured under the same id) is invisible",
    () => {
      const candidate = baseline();
      const coach = candidate.benches.find((b) => b.id === "coach_gates") as BenchRecord;
      coach.command = "runSomethingElse() from nowhere.ts";
      coach.cwd = "apps/mobile";
      coach.inputs = ["/dev/null"];
      const report = compareSummaries(baseline(), candidate, tolerances);
      expect(report.warnings.length + report.identityDifferences.length).toBeGreaterThan(0);
    },
  );

  it("modelVersions drift IS surfaced as an `expected` identity difference (HELD)", () => {
    const candidate = baseline();
    candidate.provenance.modelVersions = {
      ...candidate.provenance.modelVersions,
      ballTracker: "ball-track-999",
    };
    const report = compareSummaries(baseline(), candidate, tolerances);
    expect(report.identityDifferences).toEqual([
      expect.objectContaining({
        field: "provenance.modelVersions.ballTracker",
        severity: "expected",
      }),
    ]);
    expect(formatCompareReport(baseline(), candidate, report)).toContain("ball-track-999");
  });
});

describe("extra — schema hardening that HELD", () => {
  it.each<[string, (doc: Json) => void, RegExp]>([
    ["contractVersion drift → exit 3 non-comparable", (d) => void (d.contractVersion = 999), /./],
    [
      "generatedAtIso garbage",
      (d) => void (d.generatedAtIso = "not-a-date"),
      /generatedAtIso must be an ISO-8601/,
    ],
    ["short gitSha", (d) => void (provenanceOf(d).gitSha = "deadbeef"), /gitSha must be a 40-char/],
    [
      "duplicate bench id",
      (d) => void benchesOf(d).push({ ...benchesOf(d)[benchesOf(d).length - 1]! }),
      /duplicate id/,
    ],
    [
      "string metric",
      (d) => {
        (benchOf(d, "coach_gates").metrics as Json).foo = "Infinity";
        metricsOf(d)["coach_gates.foo"] = "Infinity";
      },
      /must be a finite number or null/,
    ],
    [
      "negative wallClockMs",
      (d) => void (benchesOf(d)[0]!.wallClockMs = -5),
      /wallClockMs must be a non-negative integer/,
    ],
    [
      "duplicate dataset release",
      (d) => {
        const rel = provenanceOf(d).datasetReleases as Json[];
        rel.push({ ...rel[0]! });
      },
      /duplicate releaseDir/,
    ],
    [
      "numeric label",
      (d) => void ((benchOf(d, "coach_gates").labels as Json).n = 1),
      /labels: "n" must be a string/,
    ],
    ["unknown top-level key", (d) => void (d.extra = 1), /./],
    ["missing caveats", (d) => void delete d.caveats, /./],
  ])("%s", (_name, mutate, message) => {
    const doc = baselineJson();
    mutate(doc);
    const validated = validateRegressionSummary(doc);
    if (validated.ok) {
      // contractVersion is schema-legal but must abort the comparison.
      const report = compareSummaries(baseline(), validated.value, tolerances);
      expect(report.exitCode).toBe(3);
      expect(report.comparable).toBe(false);
    } else {
      expect(validated.failure.message).toMatch(message);
    }
  });

  it("rejects a UTF-8 BOM (JSON.parse) and compares the baseline against itself as clean", () => {
    const bom = join(scratch, "bom.json");
    writeFileSync(bom, `\ufeff${readFileSync(BASELINE_PATH, "utf8")}`);
    expect(cliCompare(bom).status).toBe(2);

    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(main(["compare", BASELINE_PATH, BASELINE_PATH])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
  });

  it("baseline has 200 metrics across nine benches, all ok, subprocess exits 0", () => {
    const value = baseline();
    expect(Object.keys(value.metrics)).toHaveLength(200);
    expect(value.benches).toHaveLength(9);
    for (const bench of value.benches) {
      expect(bench.status).toBe("ok");
      expect(bench.exitCode).toBe(bench.kind === "subprocess" ? 0 : null);
    }
  });
});
