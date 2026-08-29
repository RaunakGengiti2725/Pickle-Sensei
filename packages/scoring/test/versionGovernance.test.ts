import { describe, expect, it } from "vitest";
import {
  AnalysisRunLedger,
  ScoreVersioningError,
  ScoreVersionRegistry,
  buildProgressLine,
  computeProgressDelta,
  type VersionedProgressPoint,
} from "../src/versionGovernance.js";

function point(day: string, version: string, score: number): VersionedProgressPoint {
  return { day, scoringModelVersion: version, score };
}

describe("ScoreVersionRegistry", () => {
  it("treats the same version as comparable and different versions as incomparable by default", () => {
    const registry = new ScoreVersionRegistry();
    expect(registry.areComparable("sm-v1", "sm-v1")).toBe(true);
    expect(registry.areComparable("sm-v1", "sm-v2")).toBe(false);
  });

  it("requires calibration evidence to declare comparability", () => {
    const registry = new ScoreVersionRegistry();
    expect(() =>
      registry.declareComparable({
        fromVersion: "sm-v1",
        toVersion: "sm-v2",
        calibrationEvidenceRef: "   ",
        declaredAtIso: "2026-08-29T00:00:00Z",
      }),
    ).toThrow(ScoreVersioningError);
  });

  it("accepts an evidence-backed declaration symmetrically, immutably, and non-transitively", () => {
    const registry = new ScoreVersionRegistry();
    registry.declareComparable({
      fromVersion: "sm-v1",
      toVersion: "sm-v2",
      calibrationEvidenceRef: "calibration-report:v1-v2",
      declaredAtIso: "2026-08-29T00:00:00Z",
    });
    expect(registry.areComparable("sm-v1", "sm-v2")).toBe(true);
    expect(registry.areComparable("sm-v2", "sm-v1")).toBe(true);
    // Declarations are immutable — no silent re-declaration.
    expect(() =>
      registry.declareComparable({
        fromVersion: "sm-v2",
        toVersion: "sm-v1",
        calibrationEvidenceRef: "other",
        declaredAtIso: "2026-08-30T00:00:00Z",
      }),
    ).toThrow(/already declared/);
    // Not transitive: v1~v2 plus v2~v3 does not imply v1~v3.
    registry.declareComparable({
      fromVersion: "sm-v2",
      toVersion: "sm-v3",
      calibrationEvidenceRef: "calibration-report:v2-v3",
      declaredAtIso: "2026-08-30T00:00:00Z",
    });
    expect(registry.areComparable("sm-v1", "sm-v3")).toBe(false);
  });

  it("rejects empty versions everywhere a version is stored or compared", () => {
    const registry = new ScoreVersionRegistry();
    expect(() => registry.areComparable("", "sm-v1")).toThrow(/non-empty/);
    expect(() => registry.areComparable("sm-v1", "  ")).toThrow(/non-empty/);
    expect(() => buildProgressLine([point("2026-01-01", "", 5)], registry)).toThrow(/non-empty/);
    expect(() =>
      new AnalysisRunLedger().recordRun({
        captureId: "c1",
        scoringModelVersion: " ",
        overallScore: 7,
        producedAtIso: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/non-empty/);
  });
});

describe("buildProgressLine", () => {
  it("never lets a segment span incomparable versions and renders the transition", () => {
    const registry = new ScoreVersionRegistry();
    const line = buildProgressLine(
      [
        point("2026-01-01", "sm-v1", 5.0),
        point("2026-01-02", "sm-v1", 5.5),
        point("2026-01-03", "sm-v2", 8.0),
        point("2026-01-04", "sm-v2", 8.2),
      ],
      registry,
    );
    expect(line.segments).toHaveLength(2);
    expect(line.segments[0]!.versions).toEqual(["sm-v1"]);
    expect(line.segments[1]!.versions).toEqual(["sm-v2"]);
    expect(line.transitions).toEqual([
      { day: "2026-01-03", fromVersion: "sm-v1", toVersion: "sm-v2", comparable: false },
    ]);
    // No segment mixes incomparable versions — fabricated "improvement" from a
    // recalibrated model is structurally impossible.
    for (const segment of line.segments) {
      for (const a of segment.versions)
        for (const b of segment.versions) expect(registry.areComparable(a, b)).toBe(true);
    }
  });

  it("joins declared-comparable versions into one continuous segment without a transition", () => {
    const registry = new ScoreVersionRegistry();
    registry.declareComparable({
      fromVersion: "sm-v1",
      toVersion: "sm-v2",
      calibrationEvidenceRef: "calibration-report:v1-v2",
      declaredAtIso: "2026-08-29T00:00:00Z",
    });
    const line = buildProgressLine(
      [point("2026-01-01", "sm-v1", 5.0), point("2026-01-02", "sm-v2", 5.4)],
      registry,
    );
    expect(line.segments).toHaveLength(1);
    expect(line.segments[0]!.versions).toEqual(["sm-v1", "sm-v2"]);
    expect(line.transitions).toEqual([]);
  });

  it("splits when a new version is incomparable with ANY version already in the segment", () => {
    const registry = new ScoreVersionRegistry();
    registry.declareComparable({
      fromVersion: "sm-v1",
      toVersion: "sm-v2",
      calibrationEvidenceRef: "calibration-report:v1-v2",
      declaredAtIso: "2026-08-29T00:00:00Z",
    });
    registry.declareComparable({
      fromVersion: "sm-v2",
      toVersion: "sm-v3",
      calibrationEvidenceRef: "calibration-report:v2-v3",
      declaredAtIso: "2026-08-29T00:00:00Z",
    });
    // sm-v3 is comparable with sm-v2 but NOT with sm-v1 already in the segment.
    const line = buildProgressLine(
      [
        point("2026-01-01", "sm-v1", 5.0),
        point("2026-01-02", "sm-v2", 5.4),
        point("2026-01-03", "sm-v3", 9.9),
      ],
      registry,
    );
    expect(line.segments).toHaveLength(2);
    expect(line.transitions).toEqual([
      { day: "2026-01-03", fromVersion: "sm-v2", toVersion: "sm-v3", comparable: false },
    ]);
  });
});

describe("computeProgressDelta", () => {
  it("refuses to fabricate improvement across incomparable versions", () => {
    const registry = new ScoreVersionRegistry();
    expect(() =>
      computeProgressDelta(
        point("2026-01-01", "sm-v1", 5.0),
        point("2026-01-02", "sm-v2", 9.0),
        registry,
      ),
    ).toThrow(/no calibration declares these versions comparable/);
  });

  it("computes deltas within a version or across declared-comparable versions", () => {
    const registry = new ScoreVersionRegistry();
    expect(
      computeProgressDelta(
        point("2026-01-01", "sm-v1", 5.0),
        point("2026-01-02", "sm-v1", 6.5),
        registry,
      ),
    ).toBeCloseTo(1.5);
    registry.declareComparable({
      fromVersion: "sm-v1",
      toVersion: "sm-v2",
      calibrationEvidenceRef: "calibration-report:v1-v2",
      declaredAtIso: "2026-08-29T00:00:00Z",
    });
    expect(
      computeProgressDelta(
        point("2026-01-01", "sm-v1", 5.0),
        point("2026-01-02", "sm-v2", 6.0),
        registry,
      ),
    ).toBeCloseTo(1.0);
  });
});

describe("AnalysisRunLedger", () => {
  it("reprocessing creates a NEW run and preserves the old run verbatim", () => {
    const ledger = new AnalysisRunLedger();
    const original = ledger.recordRun({
      captureId: "capture-1",
      scoringModelVersion: "sm-v1",
      overallScore: 6.2,
      producedAtIso: "2026-01-01T10:00:00Z",
    });
    const reprocessed = ledger.reprocess(original.runId, {
      scoringModelVersion: "sm-v2",
      overallScore: 5.1,
      producedAtIso: "2026-02-01T10:00:00Z",
    });
    expect(reprocessed.runId).not.toBe(original.runId);
    expect(reprocessed.supersedesRunId).toBe(original.runId);
    expect(reprocessed.captureId).toBe("capture-1");
    // The superseded run is untouched: same score, version, and timestamp.
    const stillThere = ledger.getRun(original.runId);
    expect(stillThere).toEqual({
      runId: original.runId,
      captureId: "capture-1",
      scoringModelVersion: "sm-v1",
      overallScore: 6.2,
      producedAtIso: "2026-01-01T10:00:00Z",
      supersedesRunId: null,
    });
    expect(ledger.runsForCapture("capture-1")).toHaveLength(2);
  });

  it("run records are frozen — direct mutation throws", () => {
    const ledger = new AnalysisRunLedger();
    const run = ledger.recordRun({
      captureId: "capture-1",
      scoringModelVersion: "sm-v1",
      overallScore: 6.2,
      producedAtIso: "2026-01-01T10:00:00Z",
    });
    expect(() => {
      (run as { overallScore: number | null }).overallScore = 9.9;
    }).toThrow(TypeError);
    expect(run.overallScore).toBe(6.2);
  });

  it("rejects reprocessing under the same version and reprocessing unknown runs", () => {
    const ledger = new AnalysisRunLedger();
    const run = ledger.recordRun({
      captureId: "capture-1",
      scoringModelVersion: "sm-v1",
      overallScore: 6.2,
      producedAtIso: "2026-01-01T10:00:00Z",
    });
    expect(() =>
      ledger.reprocess(run.runId, {
        scoringModelVersion: "sm-v1",
        overallScore: 7.0,
        producedAtIso: "2026-02-01T10:00:00Z",
      }),
    ).toThrow(/duplicate, not supersede/);
    expect(() =>
      ledger.reprocess("run-999", {
        scoringModelVersion: "sm-v2",
        overallScore: 7.0,
        producedAtIso: "2026-02-01T10:00:00Z",
      }),
    ).toThrow(/unknown run/);
  });
});
