import { describe, expect, it } from "vitest";
import {
  IncompleteResponseError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../src/index.js";

const BLANK_REFS: readonly string[] = ["", "   ", "\u00a0", "\ufeff", " \t\n\u00a0\ufeff "];

function makeIncident(severity: Severity): Incident {
  return declareIncident({
    id: "INC-ADJ",
    severity,
    failureClass: "data_corruption",
    title: "Adjudication fixture",
    detectionSource: "red_team",
    detectedAt: "2026-09-04T00:00:00Z",
    affectedSurfaces: ["table:shots"],
    declaredBy: "oncall",
    note: "declared from red team report",
  });
}

function advanceThrough(incident: Incident, steps: readonly ResponseStep[]): Incident {
  let current = incident;
  for (const step of steps) {
    current = advance(current, {
      step,
      at: "2026-09-04T01:00:00Z",
      actor: "oncall",
      note: `completed ${step}`,
    });
  }
  return current;
}

/** Fully close an incident, attaching a real postmortem when the sequence needs one. */
function closeIncident(severity: Severity): Incident {
  let incident = makeIncident(severity);
  for (const step of REQUIRED_SEQUENCES[severity].slice(1)) {
    if (step === "postmortem") {
      incident = attachPostmortem(incident, "docs/postmortems/INC-ADJ.md");
    }
    incident = advanceThrough(incident, [step]);
  }
  expect(isClosed(incident)).toBe(true);
  return incident;
}

/** Everything up to (not including) "closed" for a postmortem-required severity. */
function readyToClose(severity: "P0" | "P1"): Incident {
  const sequence = REQUIRED_SEQUENCES[severity];
  return advanceThrough(makeIncident(severity), sequence.slice(1, sequence.indexOf("closed")));
}

describe("adjudication: escalate() respects the terminal state", () => {
  it("throws InvalidTransitionError when escalating a closed P2 to P0 instead of reopening it", () => {
    const closed = closeIncident("P2");
    const timelineBefore = [...closed.timeline];
    expect(() =>
      escalate(closed, "P0", {
        at: "2026-09-04T02:00:00Z",
        actor: "oncall",
        note: "blast radius larger than believed",
      }),
    ).toThrow(InvalidTransitionError);
    expect(closed.severity).toBe("P2");
    expect(closed.timeline).toEqual(timelineBefore);
    expect(currentStep(closed)).toBe("closed");
  });

  it("throws for every higher severity from every closed severity", () => {
    const targets: Record<Severity, readonly Severity[]> = { P2: ["P1", "P0"], P1: ["P0"], P0: [] };
    for (const severity of ["P2", "P1"] as const) {
      const closed = closeIncident(severity);
      for (const to of targets[severity]) {
        let result: Incident | null = null;
        expect(() => {
          result = escalate(closed, to, { at: "t", actor: "oncall", note: "escalating" });
        }).toThrow(InvalidTransitionError);
        expect(result).toBeNull();
      }
    }
  });

  it("rejects a blank escalation note exactly like advance() does", () => {
    const open = advanceThrough(makeIncident("P2"), ["investigating"]);
    for (const note of BLANK_REFS) {
      expect(() => escalate(open, "P1", { at: "t", actor: "oncall", note })).toThrow(
        /non-empty note/,
      );
    }
    const escalated = escalate(open, "P1", { at: "t", actor: "oncall", note: "affects all users" });
    expect(escalated.severity).toBe("P1");
  });
});

describe("adjudication: postmortemRef must be a real reference", () => {
  it("attachPostmortem() rejects empty, whitespace, NBSP and BOM references", () => {
    const incident = readyToClose("P1");
    for (const ref of BLANK_REFS) {
      expect(() => attachPostmortem(incident, ref)).toThrow(/postmortemRef/);
    }
    expect(incident.postmortemRef).toBeNull();
    expect(attachPostmortem(incident, "docs/postmortems/INC-ADJ.md").postmortemRef).toBe(
      "docs/postmortems/INC-ADJ.md",
    );
  });

  it("the close guard rejects a blank postmortemRef even when set directly on the record", () => {
    for (const severity of ["P0", "P1"] as const) {
      const ready = readyToClose(severity);
      for (const ref of BLANK_REFS) {
        const tampered: Incident = { ...ready, postmortemRef: ref };
        expect(() =>
          advance(tampered, {
            step: "closed",
            at: "2026-09-04T03:00:00Z",
            actor: "oncall",
            note: "closing",
          }),
        ).toThrow(IncompleteResponseError);
      }
    }
  });

  it("still closes a postmortem-required incident once a real reference is attached", () => {
    for (const severity of ["P0", "P1"] as const) {
      const ready = attachPostmortem(readyToClose(severity), "docs/postmortems/INC-ADJ.md");
      const closed = advance(ready, {
        step: "closed",
        at: "2026-09-04T03:00:00Z",
        actor: "oncall",
        note: "closing after postmortem review",
      });
      expect(isClosed(closed)).toBe(true);
      expect(closed.postmortemRef).toBe("docs/postmortems/INC-ADJ.md");
    }
  });
});
