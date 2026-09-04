/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 */
import { describe, expect, it } from "vitest";
import {
  IncompleteResponseError,
  InvalidEscalationError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  RESPONSE_STEPS,
  SEVERITIES,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  nextRequiredStep,
  remainingSteps,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

function declare(severity: Severity): Incident {
  return declareIncident({
    id: `inc-${severity}`,
    severity,
    failureClass: "queue_stall",
    title: "audit",
    detectionSource: "monitoring_alert",
    detectedAt: "2026-09-01T00:00:00.000Z",
    affectedSurfaces: ["media-worker"],
    declaredBy: "audit",
    note: "declared for audit",
  });
}

function driveTo(incident: Incident, target: ResponseStep): Incident {
  let cur = incident;
  let n = 0;
  while (currentStep(cur) !== target) {
    const next = nextRequiredStep(cur);
    if (next === null) throw new Error("ran out of steps");
    if (
      next === "closed" &&
      cur.postmortemRef === null &&
      REQUIRED_SEQUENCES[cur.severity].includes("postmortem")
    ) {
      cur = attachPostmortem(cur, "docs/postmortems/audit.md");
    }
    cur = advance(cur, {
      step: next,
      at: new Date(Date.UTC(2026, 8, 1, 0, ++n)).toISOString(),
      actor: "audit",
      note: `did ${next}`,
    });
  }
  return cur;
}

describe("audit: postmortem gate and input validation", () => {
  it.fails(
    "FINDING: attachPostmortem accepts an empty/whitespace ref, so P0/P1 close without a postmortem",
    () => {
      for (const severity of ["P0", "P1"] as const) {
        let inc = driveTo(declare(severity), "postmortem");
        inc = attachPostmortem(inc, "   ");
        expect(() =>
          advance(inc, {
            step: "closed",
            at: "2026-09-02T00:00:00.000Z",
            actor: "audit",
            note: "closing",
          }),
        ).toThrow(IncompleteResponseError);
      }
    },
  );

  it.fails("FINDING: escalate() accepts an empty note while advance() rejects one", () => {
    const inc = declare("P2");
    expect(() =>
      escalate(inc, "P1", { at: "2026-09-01T00:01:00.000Z", actor: "audit", note: "" }),
    ).toThrow();
  });

  it.fails(
    "FINDING: timeline timestamps are not validated (non-ISO and non-monotonic accepted)",
    () => {
      const inc = declare("P2");
      expect(() =>
        advance(inc, { step: "investigating", at: "yesterday-ish", actor: "audit", note: "n" }),
      ).toThrow();
    },
  );

  it("evidence: a step dated before the previous one is appended as-is", () => {
    const inc = declare("P2");
    const out = advance(inc, {
      step: "investigating",
      at: "2020-01-01T00:00:00.000Z",
      actor: "audit",
      note: "back-dated",
    });
    expect(out.timeline.at(-1)!.at < out.timeline[0]!.at).toBe(true);
  });

  it("observed: escalating a CLOSED incident reopens it at the anchor step (documented, not a finding)", () => {
    const closed = driveTo(declare("P2"), "closed");
    expect(isClosed(closed)).toBe(true);
    const reopened = escalate(closed, "P0", {
      at: "2026-09-03T00:00:00.000Z",
      actor: "audit",
      note: "worse than thought",
    });
    expect(isClosed(reopened)).toBe(false);
    expect(currentStep(reopened)).toBe("declared");
    expect(remainingSteps(reopened)).toEqual(REQUIRED_SEQUENCES.P0.slice(1));
  });
});

describe("audit: invariants that HOLD", () => {
  it("exhaustive: from every position of every severity, every step but the next is rejected", () => {
    for (const severity of SEVERITIES) {
      const sequence = REQUIRED_SEQUENCES[severity];
      for (const position of sequence) {
        if (position === "closed") continue;
        const inc = driveTo(declare(severity), position);
        const expected = nextRequiredStep(inc);
        for (const step of RESPONSE_STEPS) {
          const attempt = (): Incident =>
            advance(attachPostmortem(inc, "pm.md"), {
              step,
              at: "2026-09-02T00:00:00.000Z",
              actor: "audit",
              note: "n",
            });
          if (step === expected) expect(attempt().timeline.at(-1)!.step).toBe(step);
          else expect(attempt).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it("closed incidents accept no further step", () => {
    for (const severity of SEVERITIES) {
      const closed = driveTo(declare(severity), "closed");
      expect(nextRequiredStep(closed)).toBeNull();
      for (const step of RESPONSE_STEPS) {
        expect(() =>
          advance(closed, { step, at: "2026-09-02T00:00:00.000Z", actor: "audit", note: "n" }),
        ).toThrow(InvalidTransitionError);
      }
    }
  });

  it("P0/P1 refuse to close with postmortemRef === null", () => {
    for (const severity of ["P0", "P1"] as const) {
      const inc = driveTo(declare(severity), "postmortem");
      expect(() =>
        advance(inc, { step: "closed", at: "2026-09-02T00:00:00.000Z", actor: "audit", note: "n" }),
      ).toThrow(IncompleteResponseError);
    }
  });

  it("de-escalation and same-severity escalation are rejected", () => {
    const p0 = declare("P0");
    for (const to of SEVERITIES) {
      expect(() => escalate(p0, to, { at: "x", actor: "a", note: "n" })).toThrow(
        InvalidEscalationError,
      );
    }
    expect(() => escalate(declare("P1"), "P2", { at: "x", actor: "a", note: "n" })).toThrow(
      InvalidEscalationError,
    );
  });

  it("escalation never grants credit for skipped mitigations", () => {
    const p1 = driveTo(declare("P1"), "investigating");
    const p0 = escalate(p1, "P0", {
      at: "2026-09-02T00:00:00.000Z",
      actor: "audit",
      note: "escalate",
    });
    expect(currentStep(p0)).toBe("declared");
    expect(remainingSteps(p0)).toEqual(REQUIRED_SEQUENCES.P0.slice(1));
    expect(() => advance(p0, { step: "investigating", at: "x", actor: "a", note: "skip" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("empty timeline is rejected loudly", () => {
    const inc = { ...declare("P2"), timeline: [] };
    expect(() => currentStep(inc)).toThrow(/empty timeline/);
    expect(() => nextRequiredStep(inc)).toThrow(/empty timeline/);
  });
});
