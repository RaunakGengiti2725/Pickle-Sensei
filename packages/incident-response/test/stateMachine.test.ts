import { describe, expect, it } from "vitest";
import {
  IncompleteResponseError,
  InvalidEscalationError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  SEVERITIES,
  SEVERITY_DEFINITIONS,
  addEvidence,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isAtLeastAsSevere,
  isClosed,
  nextRequiredStep,
  remainingSteps,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

function makeIncident(severity: Severity): Incident {
  return declareIncident({
    id: "INC-1",
    severity,
    failureClass: "confident_wrong_coaching_at_scale",
    title: "High-confidence wrong coaching on backhand drives",
    detectionSource: "monitoring_alert",
    detectedAt: "2026-08-29T00:00:00Z",
    affectedSurfaces: ["feature_flag:coaching_v2", "model:stroke-heuristic"],
    declaredBy: "oncall",
    note: "declared from alert",
  });
}

function advanceThrough(incident: Incident, steps: readonly ResponseStep[]): Incident {
  let current = incident;
  for (const step of steps) {
    if (step === "postmortem") {
      current = attachPostmortem(current, "docs/postmortems/INC-1.md");
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

describe("severity taxonomy", () => {
  it("defines exactly P0, P1, P2 with definitions and required sequences", () => {
    expect(SEVERITIES).toEqual(["P0", "P1", "P2"]);
    for (const severity of SEVERITIES) {
      expect(SEVERITY_DEFINITIONS[severity].severity).toBe(severity);
      expect(SEVERITY_DEFINITIONS[severity].criteria.length).toBeGreaterThan(0);
      expect(REQUIRED_SEQUENCES[severity][0]).toBe("declared");
      expect(REQUIRED_SEQUENCES[severity][REQUIRED_SEQUENCES[severity].length - 1]).toBe("closed");
    }
  });

  it("orders severities P0 > P1 > P2", () => {
    expect(isAtLeastAsSevere("P0", "P2")).toBe(true);
    expect(isAtLeastAsSevere("P2", "P0")).toBe(false);
    expect(isAtLeastAsSevere("P1", "P1")).toBe(true);
  });

  it("requires postmortems for P0 and P1 but not P2", () => {
    expect(SEVERITY_DEFINITIONS.P0.postmortemRequired).toBe(true);
    expect(SEVERITY_DEFINITIONS.P1.postmortemRequired).toBe(true);
    expect(SEVERITY_DEFINITIONS.P2.postmortemRequired).toBe(false);
    expect(REQUIRED_SEQUENCES.P0).toContain("postmortem");
    expect(REQUIRED_SEQUENCES.P1).toContain("postmortem");
    expect(REQUIRED_SEQUENCES.P2).not.toContain("postmortem");
  });
});

describe("P0 required response", () => {
  const p0MitigationOrder: readonly ResponseStep[] = [
    "rollout_halted",
    "feature_disabled",
    "rolled_back",
    "evidence_preserved",
    "investigating",
    "fix_in_progress",
    "validating",
    "postmortem",
    "closed",
  ];

  it("requires halt -> disable -> rollback -> preserve -> investigate -> fix -> validate -> postmortem -> close", () => {
    expect(REQUIRED_SEQUENCES.P0).toEqual(["declared", ...p0MitigationOrder]);
    let incident = makeIncident("P0");
    for (const step of p0MitigationOrder) {
      expect(nextRequiredStep(incident)).toBe(step);
      incident = advanceThrough(incident, [step]);
      expect(currentStep(incident)).toBe(step);
    }
    expect(isClosed(incident)).toBe(true);
    expect(nextRequiredStep(incident)).toBeNull();
  });

  it("rejects skipping mitigation to investigate directly", () => {
    const incident = makeIncident("P0");
    expect(() =>
      advance(incident, {
        step: "investigating",
        at: "2026-08-29T00:05:00Z",
        actor: "oncall",
        note: "jumping ahead",
      }),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects closing before the postmortem step", () => {
    const incident = advanceThrough(makeIncident("P0"), [
      "rollout_halted",
      "feature_disabled",
      "rolled_back",
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
    ]);
    expect(() =>
      advance(incident, {
        step: "closed",
        at: "2026-08-29T02:00:00Z",
        actor: "oncall",
        note: "closing early",
      }),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects closing without an attached postmortem document", () => {
    let incident = makeIncident("P1");
    incident = advanceThrough(incident, [
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
    ]);
    incident = advance(incident, {
      step: "postmortem",
      at: "2026-08-29T02:00:00Z",
      actor: "oncall",
      note: "postmortem meeting held",
    });
    expect(() =>
      advance(incident, {
        step: "closed",
        at: "2026-08-29T03:00:00Z",
        actor: "oncall",
        note: "closing",
      }),
    ).toThrow(IncompleteResponseError);
  });

  it("rejects any transition out of closed", () => {
    const incident = advanceThrough(makeIncident("P0"), p0MitigationOrder);
    for (const step of REQUIRED_SEQUENCES.P0) {
      expect(() =>
        advance(incident, {
          step,
          at: "2026-08-29T04:00:00Z",
          actor: "oncall",
          note: "reopening",
        }),
      ).toThrow(InvalidTransitionError);
    }
  });

  it("rejects repeating the current step", () => {
    const incident = advanceThrough(makeIncident("P0"), ["rollout_halted"]);
    expect(() =>
      advance(incident, {
        step: "rollout_halted",
        at: "2026-08-29T00:10:00Z",
        actor: "oncall",
        note: "again",
      }),
    ).toThrow(InvalidTransitionError);
  });

  it("requires a non-empty note on every step", () => {
    const incident = makeIncident("P0");
    expect(() =>
      advance(incident, {
        step: "rollout_halted",
        at: "2026-08-29T00:10:00Z",
        actor: "oncall",
        note: "   ",
      }),
    ).toThrow(/non-empty note/);
  });
});

describe("P1 and P2 required responses", () => {
  it("P1 skips halt/disable/rollback but still requires evidence and postmortem", () => {
    expect(REQUIRED_SEQUENCES.P1).toEqual([
      "declared",
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
      "postmortem",
      "closed",
    ]);
    const incident = advanceThrough(makeIncident("P1"), [
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
      "postmortem",
      "closed",
    ]);
    expect(isClosed(incident)).toBe(true);
    expect(incident.postmortemRef).toBe("docs/postmortems/INC-1.md");
  });

  it("P2 can close after validation without a postmortem", () => {
    const incident = advanceThrough(makeIncident("P2"), [
      "investigating",
      "fix_in_progress",
      "validating",
      "closed",
    ]);
    expect(isClosed(incident)).toBe(true);
    expect(incident.postmortemRef).toBeNull();
  });

  it("reports remaining steps in order", () => {
    const incident = advanceThrough(makeIncident("P2"), ["investigating"]);
    expect(remainingSteps(incident)).toEqual(["fix_in_progress", "validating", "closed"]);
  });
});

describe("escalation", () => {
  it("escalating P2 -> P0 mid-investigation requires the full P0 mitigation chain", () => {
    let incident = advanceThrough(makeIncident("P2"), ["investigating"]);
    incident = escalate(incident, "P0", {
      at: "2026-08-29T01:30:00Z",
      actor: "oncall",
      note: "blast radius larger than believed",
    });
    expect(incident.severity).toBe("P0");
    expect(nextRequiredStep(incident)).toBe("rollout_halted");
  });

  it("rejects de-escalation and no-op escalation", () => {
    const incident = makeIncident("P1");
    expect(() => escalate(incident, "P2", { at: "t", actor: "oncall", note: "n" })).toThrow(
      InvalidEscalationError,
    );
    expect(() => escalate(incident, "P1", { at: "t", actor: "oncall", note: "n" })).toThrow(
      InvalidEscalationError,
    );
  });

  it("preserves the full timeline across escalation", () => {
    let incident = advanceThrough(makeIncident("P2"), ["investigating"]);
    const before = incident.timeline.length;
    incident = escalate(incident, "P1", {
      at: "2026-08-29T01:30:00Z",
      actor: "oncall",
      note: "affects all users",
    });
    expect(incident.timeline.length).toBe(before + 1);
    expect(incident.timeline.map((entry) => entry.step)).toContain("investigating");
    expect(nextRequiredStep(incident)).toBe("evidence_preserved");
  });
});

describe("evidence log", () => {
  it("is append-only", () => {
    const incident = makeIncident("P0");
    const withEvidence = addEvidence(incident, {
      capturedAt: "2026-08-29T00:02:00Z",
      description: "snapshot of feature_flag table before mitigation",
      location: "s3://incident-evidence/INC-1/feature_flag.sql",
    });
    expect(incident.evidence).toHaveLength(0);
    expect(withEvidence.evidence).toHaveLength(1);
  });
});
