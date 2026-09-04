import { describe, expect, it } from "vitest";
import {
  REQUIRED_SEQUENCES,
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
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1). Contract under test
 * (stateMachine.ts): non-empty notes, P0/P1 need a postmortem to close, no
 * transition out of "closed", escalation only re-derives an OPEN incident.
 */

function makeIncident(severity: Severity): Incident {
  return declareIncident({
    id: "INC-AUDIT",
    severity,
    failureClass: "confident_wrong_coaching_at_scale",
    title: "audit fixture",
    detectionSource: "monitoring_alert",
    detectedAt: "2026-08-29T00:00:00Z",
    affectedSurfaces: ["model:stroke-heuristic"],
    declaredBy: "oncall",
    note: "declared from alert",
  });
}

function advanceThrough(
  incident: Incident,
  steps: readonly ResponseStep[],
  postmortemRef = "docs/postmortems/INC-AUDIT.md",
): Incident {
  let current = incident;
  for (const step of steps) {
    if (step === "postmortem") current = attachPostmortem(current, postmortemRef);
    current = advance(current, {
      step,
      at: "2026-08-29T01:00:00Z",
      actor: "oncall",
      note: `completed ${step}`,
    });
  }
  return current;
}

describe("audit: postmortem reference must be real", () => {
  it("a P1 cannot close with an empty-string postmortemRef", () => {
    const steps = REQUIRED_SEQUENCES.P1.slice(1);
    expect(() => advanceThrough(makeIncident("P1"), steps, "")).toThrow();
  });

  it("a P0 cannot close with a whitespace-only postmortemRef", () => {
    const steps = REQUIRED_SEQUENCES.P0.slice(1);
    expect(() => advanceThrough(makeIncident("P0"), steps, "   ")).toThrow();
  });
});

describe("audit: escalation guards", () => {
  it("escalation requires a non-empty note like every other timeline entry", () => {
    expect(() =>
      escalate(makeIncident("P2"), "P1", { at: "2026-08-29T02:00:00Z", actor: "oncall", note: "" }),
    ).toThrow();
  });

  it("a closed incident cannot be escalated (reopened) — closed is terminal", () => {
    const closed = advanceThrough(makeIncident("P2"), REQUIRED_SEQUENCES.P2.slice(1));
    expect(isClosed(closed)).toBe(true);
    expect(() =>
      escalate(closed, "P1", {
        at: "2026-08-29T03:00:00Z",
        actor: "oncall",
        note: "turned out worse",
      }),
    ).toThrow();
  });

  it("escalation P2→P1 re-derives the chain: evidence_preserved becomes required", () => {
    let incident = advanceThrough(makeIncident("P2"), ["investigating"]);
    incident = escalate(incident, "P1", {
      at: "2026-08-29T02:00:00Z",
      actor: "oncall",
      note: "wider blast radius",
    });
    expect(incident.severity).toBe("P1");
    expect(() =>
      advance(incident, {
        step: "fix_in_progress",
        at: "2026-08-29T02:30:00Z",
        actor: "oncall",
        note: "skip",
      }),
    ).toThrow();
    const next = advance(incident, {
      step: "evidence_preserved",
      at: "2026-08-29T02:30:00Z",
      actor: "oncall",
      note: "snapshots taken",
    });
    expect(next.timeline.at(-1)?.step).toBe("evidence_preserved");
  });
});
