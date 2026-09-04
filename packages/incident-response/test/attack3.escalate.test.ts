/**
 * Adversarial pass 3 — incident escalation invariants.
 *
 *  - escalate P1→P1 (same) and P0→P1 (de-escalation) must throw.
 *  - escalate of a CLOSED incident must throw: "closed" is terminal for
 *    advance(); escalate must not be a back door that silently reopens the
 *    incident at "declared".
 */
import { describe, expect, it } from "vitest";
import {
  InvalidEscalationError,
  InvalidTransitionError,
  advance,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  remainingSteps,
} from "../src/index.js";

const meta = { at: "2026-09-04T00:00:00Z", actor: "oncall", note: "n" };

function declared(severity: "P0" | "P1" | "P2") {
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

describe("attack3: escalate same / downward severity", () => {
  it("P1 → P1 throws InvalidEscalationError", () => {
    expect(() => escalate(declared("P1"), "P1", meta)).toThrow(InvalidEscalationError);
  });
  it("P0 → P1 throws InvalidEscalationError", () => {
    expect(() => escalate(declared("P0"), "P1", meta)).toThrow(InvalidEscalationError);
  });
  it("P0 → P0 and P2 → P2 throw", () => {
    expect(() => escalate(declared("P0"), "P0", meta)).toThrow(InvalidEscalationError);
    expect(() => escalate(declared("P2"), "P2", meta)).toThrow(InvalidEscalationError);
  });
  it("P1 → P2 throws", () => {
    expect(() => escalate(declared("P1"), "P2", meta)).toThrow(InvalidEscalationError);
  });
  it("throws on an unknown severity string smuggled through the type system", () => {
    expect(() => escalate(declared("P2"), "P9" as unknown as "P0", meta)).toThrow();
  });
});

describe("attack3: escalate a CLOSED incident", () => {
  function closedP2() {
    let inc = declared("P2");
    for (const step of ["investigating", "fix_in_progress", "validating", "closed"] as const) {
      inc = advance(inc, { step, ...meta });
    }
    expect(isClosed(inc)).toBe(true);
    return inc;
  }

  it("closed P2 → P0 throws instead of reopening at declared", () => {
    const inc = closedP2();
    let reopened: ReturnType<typeof escalate> | null = null;
    let threw = false;
    try {
      reopened = escalate(inc, "P0", meta);
    } catch {
      threw = true;
    }
    if (!threw && reopened) {
      expect({
        severity: reopened.severity,
        currentStep: currentStep(reopened),
        isClosed: isClosed(reopened),
        remaining: remainingSteps(reopened),
      }).toEqual("<should have thrown>");
    }
    expect(threw).toBe(true);
  });

  it("closed P2 → P1 throws", () => {
    expect(() => escalate(closedP2(), "P1", meta)).toThrow();
  });

  it("advance() out of closed is refused (the invariant escalate must share)", () => {
    const inc = closedP2();
    expect(() => advance(inc, { step: "declared", ...meta })).toThrow(InvalidTransitionError);
  });

  it("escalate with an empty note is refused like advance() is", () => {
    expect(() => escalate(declared("P2"), "P0", { ...meta, note: "   " })).toThrow();
  });
});

describe("attack3: escalation re-derivation does not grant credit for skipped mitigations", () => {
  it("P2 at validating → P0 rewinds to declared (rollout_halted was never done)", () => {
    let inc = declared("P2");
    for (const step of ["investigating", "fix_in_progress", "validating"] as const) {
      inc = advance(inc, { step, ...meta });
    }
    const p0 = escalate(inc, "P0", meta);
    expect(currentStep(p0)).toBe("declared");
    expect(remainingSteps(p0)[0]).toBe("rollout_halted");
  });

  it("double escalation P2→P1→P0 stays consistent", () => {
    let inc = declared("P2");
    inc = advance(inc, { step: "investigating", ...meta });
    inc = escalate(inc, "P1", meta);
    expect(currentStep(inc)).toBe("declared"); // evidence_preserved missing
    inc = advance(inc, { step: "evidence_preserved", ...meta });
    inc = advance(inc, { step: "investigating", ...meta });
    inc = escalate(inc, "P0", meta);
    expect(currentStep(inc)).toBe("declared"); // rollout_halted missing
    expect(remainingSteps(inc)).toEqual([
      "rollout_halted",
      "feature_disabled",
      "rolled_back",
      "evidence_preserved",
      "investigating",
      "fix_in_progress",
      "validating",
      "postmortem",
      "closed",
    ]);
  });
});
