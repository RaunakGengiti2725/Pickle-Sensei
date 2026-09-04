/**
 * Adjudication repro (shared-packages-ops::SPO-4) — incident state machine.
 *
 *  - escalate() reopens a CLOSED incident (advance() treats "closed" as terminal;
 *    escalate() must share that invariant).
 *  - escalate() accepts a blank note that advance() would refuse.
 *  - attachPostmortem() + close accept a whitespace-only postmortemRef; the
 *    close guard must check for a non-blank ref, not just `!== null`.
 * Every test here FAILS on 4d812e1a.
 */
import { describe, expect, it } from "vitest";
import {
  IncompleteResponseError,
  InvalidTransitionError,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  type Incident,
  type Severity,
} from "../src/index.js";

const meta = { at: "2026-09-04T00:00:00Z", actor: "oncall", note: "n" };

function declared(severity: Severity): Incident {
  return declareIncident({
    id: `inc-${severity}`,
    severity,
    failureClass: "queue_stall",
    title: "t",
    detectionSource: "monitoring_alert",
    detectedAt: meta.at,
    affectedSurfaces: ["media"],
    declaredBy: "oncall",
    note: "declared",
  });
}

function closedP2(): Incident {
  let inc = declared("P2");
  for (const step of ["investigating", "fix_in_progress", "validating", "closed"] as const) {
    inc = advance(inc, { step, ...meta });
  }
  expect(isClosed(inc)).toBe(true);
  return inc;
}

describe("adjudication: closed is terminal for escalate() as it is for advance()", () => {
  it("closed P2 → P0 throws InvalidTransitionError and leaves the record untouched", () => {
    const inc = closedP2();
    expect(() => escalate(inc, "P0", meta)).toThrow(InvalidTransitionError);
    expect(() => escalate(inc, "P1", meta)).toThrow(/terminal step "closed"/);
    expect(inc.severity).toBe("P2");
    expect(currentStep(inc)).toBe("closed");
  });

  it("escalate with a blank note throws like advance() does", () => {
    for (const note of ["", "   ", "\u00a0", "\ufeff", "\u200b\u200d", "\t\n"]) {
      expect(() => escalate(declared("P2"), "P0", { ...meta, note })).toThrow(/non-empty note/);
    }
    expect(escalate(declared("P2"), "P0", meta).severity).toBe("P0");
  });
});

describe("adjudication: a postmortem-required incident cannot close on a blank ref", () => {
  for (const ref of ["", "   ", "\u00a0", "\ufeff"]) {
    it(`P1 close with postmortemRef ${JSON.stringify(ref)} throws`, () => {
      let inc = declared("P1");
      for (const step of [
        "evidence_preserved",
        "investigating",
        "fix_in_progress",
        "validating",
        "postmortem",
      ] as const) {
        inc = advance(inc, { step, ...meta });
      }
      expect(() => attachPostmortem(inc, ref)).toThrow(/postmortemRef/);
      const blankRef: Incident = { ...inc, postmortemRef: ref };
      expect(() => advance(blankRef, { step: "closed", ...meta })).toThrow(IncompleteResponseError);
      expect(
        isClosed(advance(attachPostmortem(inc, "docs/pm.md"), { step: "closed", ...meta })),
      ).toBe(true);
    });
  }
});
