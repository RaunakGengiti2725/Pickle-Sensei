import { describe, expect, it } from "vitest";
import {
  AnalysisRunLedger,
  buildProgressLine,
  segmentDelta,
  VersionComparability,
  type AnalysisRun,
  type ProgressLineElement,
  type VersionedScore,
} from "../src/index.js";

function score(overrides: Partial<VersionedScore> & { shotId: string }): VersionedScore {
  return {
    runId: `run-${overrides.shotId}`,
    scoringModelVersion: "sm-v1",
    overallScore: 5,
    capturedAt: "2026-01-01T00:00:00.000Z",
    scoredAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<AnalysisRun> & { runId: string; shotId: string }): AnalysisRun {
  return {
    scoringModelVersion: "sm-v1",
    overallScore: 5,
    capturedAt: "2026-01-01T00:00:00.000Z",
    scoredAt: "2026-01-01T00:05:00.000Z",
    reprocessedFromRunId: null,
    ...overrides,
  };
}

function segments(line: ProgressLineElement[]) {
  return line.filter((el) => el.kind === "segment");
}

function transitions(line: ProgressLineElement[]) {
  return line.filter((el) => el.kind === "version_transition");
}

describe("VersionComparability", () => {
  it("treats identical versions as comparable and everything else as incomparable by default", () => {
    const rules = new VersionComparability();
    expect(rules.isComparable("sm-v1", "sm-v1")).toBe(true);
    expect(rules.isComparable("sm-v1", "sm-v2")).toBe(false);
  });

  it("honors explicit symmetric declarations", () => {
    const rules = new VersionComparability([
      { versionA: "sm-v1", versionB: "sm-v1.1", rationale: "identical targets; sigma bugfix only" },
    ]);
    expect(rules.isComparable("sm-v1", "sm-v1.1")).toBe(true);
    expect(rules.isComparable("sm-v1.1", "sm-v1")).toBe(true);
    expect(rules.isComparable("sm-v1.1", "sm-v2")).toBe(false);
  });

  it("rejects rules without a rationale", () => {
    expect(
      () => new VersionComparability([{ versionA: "sm-v1", versionB: "sm-v2", rationale: "  " }]),
    ).toThrow(/rationale/);
  });
});

describe("buildProgressLine", () => {
  const noRules = new VersionComparability();

  it("rejects any score missing its scoringModelVersion", () => {
    const bad = score({ shotId: "s1", scoringModelVersion: " " });
    expect(() => buildProgressLine([bad], noRules)).toThrow(/scoringModelVersion/);
  });

  it("keeps a single-version series as one continuous segment", () => {
    const line = buildProgressLine(
      [
        score({ shotId: "s1", capturedAt: "2026-01-01T00:00:00.000Z", overallScore: 4 }),
        score({ shotId: "s2", capturedAt: "2026-01-02T00:00:00.000Z", overallScore: 6 }),
      ],
      noRules,
    );
    expect(segments(line)).toHaveLength(1);
    expect(transitions(line)).toHaveLength(0);
  });

  it("never silently spans incomparable versions: an inflated new model cannot fabricate progress", () => {
    // Old model scored the player ~4; a new (incomparable) model scores the
    // exact same technique ~8. A naive combined line would show +4 of fake
    // improvement. The governed line splits at the version boundary, and each
    // in-segment delta is flat.
    const line = buildProgressLine(
      [
        score({
          shotId: "s1",
          capturedAt: "2026-01-01T00:00:00.000Z",
          scoringModelVersion: "sm-v1",
          overallScore: 4,
        }),
        score({
          shotId: "s2",
          capturedAt: "2026-01-02T00:00:00.000Z",
          scoringModelVersion: "sm-v1",
          overallScore: 4,
        }),
        score({
          shotId: "s3",
          capturedAt: "2026-01-03T00:00:00.000Z",
          scoringModelVersion: "sm-v2",
          overallScore: 8,
        }),
        score({
          shotId: "s4",
          capturedAt: "2026-01-04T00:00:00.000Z",
          scoringModelVersion: "sm-v2",
          overallScore: 8,
        }),
      ],
      noRules,
    );
    const segs = segments(line);
    expect(segs).toHaveLength(2);
    expect(transitions(line)).toEqual([
      {
        kind: "version_transition",
        fromVersion: "sm-v1",
        toVersion: "sm-v2",
        at: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(segmentDelta(segs[0]!.segment)).toBe(0);
    expect(segmentDelta(segs[1]!.segment)).toBe(0);
  });

  it("joins versions only under an explicit comparability rule", () => {
    const rules = new VersionComparability([
      { versionA: "sm-v1", versionB: "sm-v1.1", rationale: "identical score scale" },
    ]);
    const line = buildProgressLine(
      [
        score({ shotId: "s1", capturedAt: "2026-01-01T00:00:00.000Z", overallScore: 4 }),
        score({
          shotId: "s2",
          capturedAt: "2026-01-02T00:00:00.000Z",
          scoringModelVersion: "sm-v1.1",
          overallScore: 6,
        }),
      ],
      rules,
    );
    expect(segments(line)).toHaveLength(1);
    expect(transitions(line)).toHaveLength(0);
    expect(segmentDelta(segments(line)[0]!.segment)).toBe(2);
  });

  it("returns no trend from a single scored point", () => {
    const line = buildProgressLine([score({ shotId: "s1" })], noRules);
    expect(segmentDelta(segments(line)[0]!.segment)).toBeNull();
  });

  it("excludes abstained (null-score) points from deltas", () => {
    const line = buildProgressLine(
      [
        score({ shotId: "s1", capturedAt: "2026-01-01T00:00:00.000Z", overallScore: null }),
        score({ shotId: "s2", capturedAt: "2026-01-02T00:00:00.000Z", overallScore: 5 }),
      ],
      noRules,
    );
    expect(segmentDelta(segments(line)[0]!.segment)).toBeNull();
  });
});

describe("AnalysisRunLedger", () => {
  it("rejects runs missing a scoringModelVersion", () => {
    const ledger = new AnalysisRunLedger();
    expect(() =>
      ledger.record(run({ runId: "r1", shotId: "s1", scoringModelVersion: "" })),
    ).toThrow(/scoringModelVersion/);
  });

  it("never overwrites an existing run", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record(run({ runId: "r1", shotId: "s1", overallScore: 4 }));
    expect(() => ledger.record(run({ runId: "r1", shotId: "s1", overallScore: 9 }))).toThrow(
      /immutable/,
    );
    expect(ledger.get("r1")!.overallScore).toBe(4);
  });

  it("reprocessing creates a NEW run preserving the old run, both versions, and both timestamps", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record(
      run({
        runId: "r1",
        shotId: "s1",
        scoringModelVersion: "sm-v1",
        overallScore: 4,
        scoredAt: "2026-01-01T00:05:00.000Z",
      }),
    );
    const reprocessed = ledger.reprocess("r1", {
      runId: "r2",
      scoringModelVersion: "sm-v2",
      overallScore: 7,
      scoredAt: "2026-02-01T00:00:00.000Z",
    });
    expect(reprocessed.reprocessedFromRunId).toBe("r1");
    expect(reprocessed.capturedAt).toBe("2026-01-01T00:00:00.000Z");
    const history = ledger.runsForShot("s1");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      runId: "r1",
      scoringModelVersion: "sm-v1",
      overallScore: 4,
      scoredAt: "2026-01-01T00:05:00.000Z",
    });
    expect(history[1]).toMatchObject({
      runId: "r2",
      scoringModelVersion: "sm-v2",
      overallScore: 7,
      scoredAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("rejects reprocessing lineage pointing at unknown or foreign runs", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record(run({ runId: "r1", shotId: "s1" }));
    expect(() =>
      ledger.reprocess("missing", {
        runId: "r2",
        scoringModelVersion: "sm-v2",
        overallScore: 6,
        scoredAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toThrow(/unknown run/);
    expect(() =>
      ledger.record(run({ runId: "r3", shotId: "other-shot", reprocessedFromRunId: "r1" })),
    ).toThrow(/different shot/);
  });

  it("returns defensive copies so stored history cannot be mutated", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record(run({ runId: "r1", shotId: "s1", overallScore: 4 }));
    const view = ledger.get("r1")!;
    view.overallScore = 10;
    expect(ledger.get("r1")!.overallScore).toBe(4);
    const listed = ledger.runsForShot("s1");
    listed[0]!.scoringModelVersion = "hacked";
    expect(ledger.runsForShot("s1")[0]!.scoringModelVersion).toBe("sm-v1");
  });

  it("latestRunsUnderVersion never substitutes scores from another version", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record(
      run({
        runId: "r1",
        shotId: "s1",
        scoringModelVersion: "sm-v1",
        overallScore: 4,
        capturedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    ledger.record(
      run({
        runId: "r2",
        shotId: "s2",
        scoringModelVersion: "sm-v1",
        overallScore: 5,
        capturedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    // Only s1 is reprocessed under sm-v2.
    ledger.reprocess("r1", {
      runId: "r3",
      scoringModelVersion: "sm-v2",
      overallScore: 7,
      scoredAt: "2026-02-01T00:00:00.000Z",
    });
    const v2 = ledger.latestRunsUnderVersion("sm-v2");
    expect(v2.map((r) => r.shotId)).toEqual(["s1"]);
    const v1 = ledger.latestRunsUnderVersion("sm-v1");
    expect(v1.map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("full reprocessing under a new version yields a coherent single-version progress line", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record(
      run({
        runId: "r1",
        shotId: "s1",
        overallScore: 4,
        capturedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    ledger.record(
      run({
        runId: "r2",
        shotId: "s2",
        overallScore: 5,
        capturedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    ledger.reprocess("r1", {
      runId: "r3",
      scoringModelVersion: "sm-v2",
      overallScore: 6,
      scoredAt: "2026-02-01T00:00:00.000Z",
    });
    ledger.reprocess("r2", {
      runId: "r4",
      scoringModelVersion: "sm-v2",
      overallScore: 6.5,
      scoredAt: "2026-02-01T00:01:00.000Z",
    });
    const line = buildProgressLine(
      ledger.latestRunsUnderVersion("sm-v2").map((r) => ({
        runId: r.runId,
        shotId: r.shotId,
        scoringModelVersion: r.scoringModelVersion,
        overallScore: r.overallScore,
        capturedAt: r.capturedAt,
        scoredAt: r.scoredAt,
      })),
      new VersionComparability(),
    );
    expect(segments(line)).toHaveLength(1);
    expect(transitions(line)).toHaveLength(0);
    expect(segmentDelta(segments(line)[0]!.segment)).toBeCloseTo(0.5, 10);
  });
});
