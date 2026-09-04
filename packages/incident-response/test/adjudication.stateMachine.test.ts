/**
 * Adjudication repro (shared-packages-ops) — incident state machine.
 *
 *  - escalate() reopens a CLOSED incident (advance() treats "closed" as terminal;
 *    escalate() does not share that invariant).
 *  - escalate() accepts a blank note that advance() would refuse.
 *  - attachPostmortem() + close accept a whitespace-only postmortemRef; the
 *    close guard is `=== null` only.
 * Every test here FAILS on 4d812e1a.
 */
import { describe, expect, it } from "vitest";
import {
  advance,
  attachPostmortem,
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
  it("closed P2 → P0 throws", () => {
    expect(() => escalate(closedP2(), "P0", meta)).toThrow();
  });

  it("escalate with a blank note throws like advance() does", () => {
    expect(() => escalate(declared("P2"), "P0", { ...meta, note: "   " })).toThrow();
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
      inc = attachPostmortem(inc, ref);
      expect(() => advance(inc, { step: "closed", ...meta })).toThrow();
    });
  }
});
