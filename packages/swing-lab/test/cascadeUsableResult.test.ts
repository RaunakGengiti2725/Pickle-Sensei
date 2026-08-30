import { describe, expect, it } from "vitest";
import {
  evaluateUsableResult,
  type Report,
  type StageName,
  type StageOutcome,
} from "../src/cascadeWaterfall.js";

/**
 * usable-result-v1 clause-3 regression tests (SYNTHETIC FIXTURES shaped after
 * the 2026-08-29 Mac re-measure). stroke-heuristic-7 emits the literal
 * taxonomy-v3 "UNKNOWN" label where v2 committed a side; the contract text has
 * always said "explicit abstention/unknown" is honest, but the implementation
 * counted UNKNOWN as a wrong CONFIDENT prediction (found on real wm-dink-01 /
 * afn-vic-rally1 runs). These pin the corrected behavior without changing the
 * strict STROKE stage (UNKNOWN still fails L1-match there).
 */

const stages = (overrides: Partial<Record<StageName, StageOutcome>> = {}) => {
  const pass = (detail: string): StageOutcome => ({ pass: true, detail });
  return {
    TARGET: pass("policy user_tapped_person · coverage 1.00 · conf 0.97"),
    EVENT: pass("selected 100–1068 vs gold 450–1150 (overlap 88%, contact inside)"),
    PADDLE: pass("status tracked · coverage 0.31"),
    BALL: pass("status tracked"),
    CONTACT: pass("error 30ms (est 650 vs gold 680)"),
    PHASE: pass("segmented, ordering valid"),
    STROKE: { pass: false, detail: "predicted UNKNOWN vs gold FOREHAND_DRIVE" },
    ...overrides,
  } as Record<StageName, StageOutcome>;
};

const reportWithStroke = (label: string | null): Report => ({
  player: { targetCoverage: 1 },
  targetEvent: { status: "selected", event: { startMs: 100, endMs: 1068 } },
  contact: { status: "estimated", estimatedContactMs: 650, paddleConfirmed: true },
  temporalPhasesV2: {
    status: "segmented",
    boundaries: { contactMs: 650, followThroughEndMs: 900 },
  },
  ...(label === null ? {} : { strokePrediction: { label } }),
});

describe("usable-result-v1 clause 3 — explicit abstention/unknown", () => {
  it("explicit UNKNOWN with trustworthy replay evidence is USABLE (honest stroke abstention)", () => {
    const verdict = evaluateUsableResult(stages(), reportWithStroke("UNKNOWN"), 680);
    expect(verdict.usable).toBe(true);
    expect(verdict.replayClause).toBe("a");
    expect(verdict.reasons).toContain("honest stroke abstention");
  });

  it("UNKNOWN is not rescued when replay evidence is fabricated (>132ms marker still vetoes)", () => {
    // afn-vic-rally1 shape: UNKNOWN stroke AND a 245ms-off contact marker —
    // the fabricated-evidence veto must still make it NOT usable.
    const report: Report = {
      ...reportWithStroke("UNKNOWN"),
      contact: { status: "estimated", estimatedContactMs: 435, paddleConfirmed: true },
    };
    const verdict = evaluateUsableResult(
      stages({ CONTACT: { pass: false, detail: "error 245ms (est 435 vs gold 680)" } }),
      report,
      680,
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("fabricated evidence veto");
    expect(verdict.reasons.join(" ")).not.toContain("stroke not honest");
  });

  it("a wrong CONFIDENT side prediction stays NOT usable (no softening)", () => {
    const verdict = evaluateUsableResult(
      stages({ STROKE: { pass: false, detail: "predicted BACKHAND vs gold FOREHAND_DRIVE" } }),
      reportWithStroke("BACKHAND"),
      680,
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("stroke not honest");
  });

  it("null/missing stroke prediction remains an abstention (pre-existing arm unchanged)", () => {
    const verdict = evaluateUsableResult(
      stages({ STROKE: { pass: false, detail: "predicted none vs gold FOREHAND_DRIVE" } }),
      reportWithStroke(null),
      680,
    );
    expect(verdict.usable).toBe(true);
    expect(verdict.reasons).toContain("honest stroke abstention");
  });
});
