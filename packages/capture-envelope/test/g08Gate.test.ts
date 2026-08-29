import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeG08Metrics,
  computeG08MetricsByFamily,
  evaluateG08Promotion,
  evidenceSufficient,
  G08_FROZEN_GATE_DOC_SHA256,
  sha256OfFile,
  type G08EvalRow,
} from "../src/g08Gate.js";
import {
  G08_BYPASS_FAMILIES,
  G08_LABEL_SCHEMA_VERSION,
  validateG08LabelFile,
} from "../src/g08LabelSchema.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const waveGDir = join(repoRoot, "datasets", "experiments", "wave-g");

function row(partial: Partial<G08EvalRow>): G08EvalRow {
  return {
    labelId: "g08-label-0001",
    family: "camera_shake",
    sessionKey: "s1",
    capture: "SAFE",
    downstream: "NOT_RUN",
    envelopeOverall: "SUPPORTED",
    ...partial,
  };
}

describe("g08 frozen gate document", () => {
  it("committed gate doc hash matches the freeze-time pin", () => {
    expect(sha256OfFile(join(waveGDir, "g08-frozen-gate.md"))).toBe(G08_FROZEN_GATE_DOC_SHA256);
  });
});

describe("g08 label schema validation", () => {
  const validLabel = {
    labelId: "g08-label-0001",
    candidateId: "g08-camera_shake-01",
    clip: "datasets/paddle-bench/bundles/x/clip.mp4",
    windowMs: { startMs: 0, durationMs: 4000 },
    sessionKey: "s1",
    family: "camera_shake",
    capture: "UNSAFE",
    downstream: "NOT_RUN",
    annotatorKind: "human",
    annotator: "reviewer-1",
    labeledAtIso: "2026-08-29T00:00:00Z",
    notes: "violent shake throughout",
  };

  it("accepts the committed (empty) label file", () => {
    const data: unknown = JSON.parse(readFileSync(join(waveGDir, "g08-labels.json"), "utf8"));
    const result = validateG08LabelFile(data);
    expect(result.valid).toBe(true);
    expect(result.effective).toHaveLength(0);
  });

  it("accepts a well-formed human label", () => {
    const result = validateG08LabelFile({
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "test",
      labels: [validLabel],
    });
    expect(result.valid).toBe(true);
    expect(result.effective).toHaveLength(1);
  });

  it("rejects machine-authored labels — Tier-C is never truth", () => {
    const result = validateG08LabelFile({
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "test",
      labels: [{ ...validLabel, annotatorKind: "machine" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('annotatorKind must be "human"'))).toBe(true);
  });

  it("requires notes for UNSAFE and AMBIGUOUS labels", () => {
    const result = validateG08LabelFile({
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "test",
      labels: [{ ...validLabel, capture: "AMBIGUOUS", notes: "  " }],
    });
    expect(result.valid).toBe(false);
  });

  it("applies append-only supersession: latest record wins, superseded excluded", () => {
    const correction = {
      ...validLabel,
      labelId: "g08-label-0002",
      capture: "DEGRADED",
      supersedesLabelId: "g08-label-0001",
    };
    const result = validateG08LabelFile({
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "test",
      labels: [validLabel, correction],
    });
    expect(result.valid).toBe(true);
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.labelId).toBe("g08-label-0002");
  });

  it("rejects supersedes references to unknown labelIds", () => {
    const result = validateG08LabelFile({
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "test",
      labels: [{ ...validLabel, supersedesLabelId: "missing" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects wrong schema version and duplicate labelIds", () => {
    const result = validateG08LabelFile({
      schemaVersion: "wrong",
      provenance: "test",
      labels: [validLabel, { ...validLabel }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    expect(result.errors.some((e) => e.includes("duplicate labelId"))).toBe(true);
  });
});

describe("g08 metrics", () => {
  it("reports null rates with zero denominators on empty input — never fabricates", () => {
    const m = computeG08Metrics([]);
    expect(m.n).toBe(0);
    expect(m.falseSafeRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(m.falseRejectRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(m.usableRateGivenSupported.rate).toBeNull();
    expect(m.silentFailureRateGivenSupported.rate).toBeNull();
  });

  it("computes false-safe and false-reject with counts", () => {
    const m = computeG08Metrics([
      row({ labelId: "a", capture: "UNSAFE", envelopeOverall: "SUPPORTED" }),
      row({ labelId: "b", capture: "UNSAFE", envelopeOverall: "UNSUPPORTED" }),
      row({ labelId: "c", capture: "SAFE", envelopeOverall: "DEGRADED" }),
      row({ labelId: "d", capture: "SAFE", envelopeOverall: "SUPPORTED" }),
    ]);
    expect(m.falseSafeRate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.falseRejectRate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("counts AMBIGUOUS separately and excludes it from capture denominators", () => {
    const m = computeG08Metrics([
      row({ labelId: "a", capture: "AMBIGUOUS" }),
      row({ labelId: "b", capture: "UNSAFE", envelopeOverall: "UNSUPPORTED" }),
    ]);
    expect(m.nAmbiguous).toBe(1);
    expect(m.falseSafeRate.denominator).toBe(1);
  });

  it("conditions downstream rates on envelope verdict, excluding NOT_RUN", () => {
    const m = computeG08Metrics([
      row({ labelId: "a", downstream: "USABLE", envelopeOverall: "SUPPORTED" }),
      row({ labelId: "b", downstream: "SILENT_FAILURE", envelopeOverall: "SUPPORTED" }),
      row({ labelId: "c", downstream: "NOT_RUN", envelopeOverall: "SUPPORTED" }),
      row({ labelId: "d", downstream: "USABLE", envelopeOverall: "DEGRADED" }),
    ]);
    expect(m.usableRateGivenSupported).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.silentFailureRateGivenSupported).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.usableRateGivenFlagged).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it("splits metrics by family across all six families", () => {
    const byFamily = computeG08MetricsByFamily([row({ family: "tiny_subject" })]);
    expect(Object.keys(byFamily)).toEqual([...G08_BYPASS_FAMILIES]);
    expect(byFamily.tiny_subject.n).toBe(1);
    expect(byFamily.camera_shake.n).toBe(0);
  });
});

describe("g08 promotion gate", () => {
  it("is NOT DECIDABLE with zero labels", () => {
    const empty = computeG08Metrics([]);
    expect(evidenceSufficient(empty).sufficient).toBe(false);
    const verdict = evaluateG08Promotion("camera_shake", empty, empty);
    expect(verdict.decidable).toBe(false);
    expect(verdict.promote).toBe(false);
  });

  it("refuses promotion when false-safe worsens even within absolute bounds", () => {
    const rows: G08EvalRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        row({
          labelId: `u${i}`,
          sessionKey: `s${i % 4}`,
          capture: "UNSAFE",
          envelopeOverall: "UNSUPPORTED",
        }),
      );
    }
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        row({
          labelId: `s${i}`,
          sessionKey: `s${i % 4}`,
          capture: "SAFE",
          envelopeOverall: "SUPPORTED",
        }),
      );
    }
    const incumbent = computeG08Metrics(rows);
    const candidateRows = rows.map((r, i) =>
      i === 0 ? { ...r, envelopeOverall: "SUPPORTED" as const } : r,
    );
    const candidate = computeG08Metrics(candidateRows);
    const verdict = evaluateG08Promotion("camera_shake", incumbent, candidate);
    expect(verdict.decidable).toBe(true);
    expect(verdict.promote).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("worsens"))).toBe(true);
  });

  it("promotes a candidate meeting all frozen criteria", () => {
    const rows: G08EvalRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        row({
          labelId: `u${i}`,
          sessionKey: `s${i % 4}`,
          capture: "UNSAFE",
          envelopeOverall: "UNSUPPORTED",
        }),
      );
    }
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        row({
          labelId: `s${i}`,
          sessionKey: `s${i % 4}`,
          capture: "SAFE",
          envelopeOverall: "SUPPORTED",
        }),
      );
    }
    const metrics = computeG08Metrics(rows);
    const verdict = evaluateG08Promotion("camera_shake", metrics, metrics);
    expect(verdict.decidable).toBe(true);
    expect(verdict.promote).toBe(true);
  });
});
