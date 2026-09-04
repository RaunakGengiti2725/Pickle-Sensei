import { describe, expect, it } from "vitest";
import {
  advance,
  attachPostmortem,
  declareIncident,
  escalate,
  isClosed,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests for
 * incident-response input validation gaps. Synthetic incidents only.
 */

function makeIncident(severity: Severity): Incident {
  return declareIncident({
    id: "SYNTHETIC-INC-1",
    severity,
    failureClass: "confident_wrong_coaching_at_scale",
    title: "synthetic incident",
    detectionSource: "monitoring_alert",
    detectedAt: "2026-08-29T00:00:00Z",
    affectedSurfaces: ["feature_flag:synthetic"],
    declaredBy: "oncall",
    note: "declared from alert",
  });
}

function advanceThrough(
  incident: Incident,
  steps: readonly ResponseStep[],
  postmortemRef: string | null,
): Incident {
  let current = incident;
  for (const step of steps) {
    if (step === "postmortem" && postmortemRef !== null) {
      current = attachPostmortem(current, postmortemRef);
    }
    current = advance(current, {
      step,
      at: "2026-08-29T01:00:00Z",
      actor: "oncall",
      note: `completed ${step}`,
    });
  }
  return current;
}

const P1_TAIL: readonly ResponseStep[] = [
  "evidence_preserved",
  "investigating",
  "fix_in_progress",
  "validating",
  "postmortem",
];

describe("AUDIT incident-response: postmortem requirement", () => {
  it("a P1 cannot close with an EMPTY postmortem reference", () => {
    const ready = advanceThrough(makeIncident("P1"), P1_TAIL, "");
    expect(() =>
      advance(ready, { step: "closed", at: "2026-08-29T02:00:00Z", actor: "oncall", note: "done" }),
    ).toThrow();
  });

  it("a P1 cannot close with a WHITESPACE-only postmortem reference", () => {
    const ready = advanceThrough(makeIncident("P1"), P1_TAIL, "   ");
    expect(() =>
      advance(ready, { step: "closed", at: "2026-08-29T02:00:00Z", actor: "oncall", note: "done" }),
    ).toThrow();
  });
});

describe("AUDIT incident-response: escalate() input validation", () => {
  it("escalation requires a non-empty note like every other timeline entry", () => {
    expect(() =>
      escalate(makeIncident("P2"), "P1", { at: "2026-08-29T01:00:00Z", actor: "oncall", note: "" }),
    ).toThrow();
  });

  it("escalating a CLOSED incident is refused (closed is terminal for advance())", () => {
    const closed = advanceThrough(
      makeIncident("P2"),
      ["investigating", "fix_in_progress", "validating", "closed"],
      null,
    );
    expect(isClosed(closed)).toBe(true);
    expect(() =>
      escalate(closed, "P0", { at: "2026-08-29T03:00:00Z", actor: "oncall", note: "regressed" }),
    ).toThrow();
  });
});
